#!/usr/bin/env python3
"""Ingest ASCAT-B/C NetCDF wind-vector cells into the ``points`` hypertable.

With no file arguments, the command connects directly to the KNMI FTP service,
downloads the newest unprocessed ASCAT-B/C files into memory, and inserts them.
Credentials are read from ``ASCAT_FTP_USERNAME`` and ``ASCAT_FTP_PASSWORD``.

Usage:
    python -m backend.api.ingest.ascat_ingest
    python -m backend.api.ingest.ascat_ingest /path/to/file.nc[.gz] [...]
    python -m backend.api.ingest.ascat_ingest --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import io
import json
import os
from datetime import datetime, timezone
from ftplib import FTP, FTP_TLS, error_perm
from pathlib import Path

import numpy as np
import xarray as xr
from sqlalchemy import text

from backend.api.db.engine import get_engine

SOURCE_ID = "ASCAT"
BATCH_SIZE = 2_000

_TITLE_TO_PLATFORM = {
    "ASCATB-L2-Coastal": "ASCAT-B",
    "ASCATB-L2-25km": "ASCAT-B",
    "ASCATC-L2-Coastal": "ASCAT-C",
    "ASCATC-L2-25km": "ASCAT-C",
}

DEFAULT_FTP_HOST = "ftppro.knmi.nl"
DEFAULT_FTP_DIRECTORIES = ("netcdf/ascat_b/", "netcdf/ascat_c/")
DEFAULT_STATE_PATH = Path("ascat_ftp_state.json")


def _open_dataset(path: Path) -> xr.Dataset:
    return _open_dataset_bytes(path.read_bytes(), path.name)


def _open_dataset_bytes(data: bytes, name: str) -> xr.Dataset:
    if name.lower().endswith(".gz"):
        data = gzip.decompress(data)
    return xr.open_dataset(io.BytesIO(data))


def _ftp_connect(host: str, username: str, password: str, use_tls: bool) -> FTP:
    ftp_class = FTP_TLS if use_tls else FTP
    ftp = ftp_class(timeout=60)
    ftp.connect(host)
    ftp.login(username, password)
    if isinstance(ftp, FTP_TLS):
        ftp.prot_p()
    ftp.set_pasv(True)
    return ftp


def _remote_mtime(ftp: FTP, filename: str) -> datetime:
    response = ftp.sendcmd(f"MDTM {filename}")
    stamp = response.split()[-1]
    return datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def _list_remote_files(ftp: FTP, directory: str) -> list[tuple[str, datetime]]:
    """List NetCDF/gzip files in one FTP directory with UTC modification times."""
    current = ftp.pwd()
    files: list[tuple[str, datetime]] = []
    try:
        ftp.cwd(directory)
        try:
            for name, facts in ftp.mlsd():
                if facts.get("type") != "file" or not name.lower().endswith((".nc", ".gz")):
                    continue
                modified = facts.get("modify")
                mtime = (
                    datetime.strptime(modified, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
                    if modified else _remote_mtime(ftp, name)
                )
                files.append((name, mtime))
        except (error_perm, AttributeError):
            for name in ftp.nlst():
                if not name.lower().endswith((".nc", ".gz")):
                    continue
                try:
                    files.append((name, _remote_mtime(ftp, name)))
                except error_perm:
                    continue
    finally:
        ftp.cwd(current)
    return files


def _download_remote(ftp: FTP, directory: str, filename: str) -> bytes:
    current = ftp.pwd()
    buffer = io.BytesIO()
    try:
        ftp.cwd(directory)
        ftp.retrbinary(f"RETR {filename}", buffer.write)
    finally:
        ftp.cwd(current)
    return buffer.getvalue()


def _load_state(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _platform(ds: xr.Dataset) -> str:
    title = str(ds.attrs.get("title_short_name", "")).strip()
    if title in _TITLE_TO_PLATFORM:
        return _TITLE_TO_PLATFORM[title]

    # KNMI publishes several L2 resolutions under the same directory.  Accept
    # future ASCAT-B/C L2 variants based on the stable platform prefix while
    # still rejecting unrelated scatterometer products.
    normalized = title.upper()
    if normalized.startswith("ASCATB-L2-"):
        return "ASCAT-B"
    if normalized.startswith("ASCATC-L2-"):
        return "ASCAT-C"

    raise ValueError(
        f"Unsupported scatterometer product {title!r}; "
        "expected an ASCAT-B/C L2 product"
    )


def _speed_to_knots(values: np.ndarray, units: str) -> np.ndarray:
    normalized = units.lower().replace(" ", "")
    if normalized in {"m/s", "ms-1", "m*s-1", "metersecond-1", "meterssecond-1"}:
        return values * 1.9438444924406
    if normalized in {"kt", "kts", "knot", "knots"}:
        return values
    raise ValueError(f"Unsupported wind_speed units {units!r}; refusing to guess")


def rows_from_dataset(ds: xr.Dataset, source_file: str) -> list[dict]:
    """Normalize valid WVCs from one ASCAT file into insert parameters."""
    required = {"time", "lat", "lon", "wind_speed", "wind_dir", "wvc_quality_flag"}
    missing = sorted(required.difference(ds.variables))
    if missing:
        raise ValueError(f"Missing required ASCAT variables: {', '.join(missing)}")

    platform = _platform(ds)
    swath_id = hashlib.sha256(
        f"{platform}:{source_file}".encode("utf-8")
    ).hexdigest()[:24]

    times = np.asarray(ds["time"].values)
    lats = np.asarray(ds["lat"].values, dtype=float)
    lons = np.asarray(ds["lon"].values, dtype=float)
    speeds = _speed_to_knots(
        np.asarray(ds["wind_speed"].values, dtype=float),
        str(ds["wind_speed"].attrs.get("units", "")),
    )
    directions = np.asarray(ds["wind_dir"].values, dtype=float)
    qc = np.asarray(ds["wvc_quality_flag"].values)

    try:
        times, lats, lons, speeds, directions, qc = np.broadcast_arrays(
            times, lats, lons, speeds, directions, qc
        )
    except ValueError as exc:
        raise ValueError("ASCAT variables do not share a broadcastable WVC shape") from exc

    rows: list[dict] = []
    for index in np.ndindex(times.shape):
        lat = float(lats[index])
        lon = float(lons[index])
        speed = float(speeds[index])
        direction = float(directions[index])
        when = times[index]
        if (
            np.isnat(when)
            or not np.isfinite(lat) or not -90 <= lat <= 90
            or not np.isfinite(lon) or not -180 <= lon <= 180
            or not np.isfinite(speed)
            or not np.isfinite(direction)
        ):
            continue

        scan_row = int(index[0]) if index else 0
        cell_index = int(index[1]) if len(index) > 1 else 0
        qc_value = None
        try:
            if np.isfinite(qc[index]):
                qc_value = int(qc[index])
        except (TypeError, ValueError, OverflowError):
            pass

        valid_time = datetime.fromisoformat(
            np.datetime_as_string(when, unit="ms") + "+00:00"
        ).astimezone(timezone.utc)
        props = {
            "platform": platform,
            "swath_id": swath_id,
            "scan_row": scan_row,
            "cell_index": cell_index,
            "wind_speed_kt": speed,
            # KNMI ASCAT L2 direction is the direction the wind vector points
            # toward.  Weather barbs use the meteorological direction-from.
            "wind_direction_deg": (direction + 180.0) % 360.0,
            "qc_flag": qc_value,
            "source_file": source_file,
        }
        rows.append({
            "source_id": SOURCE_ID,
            "valid_time": valid_time,
            "lon": lon,
            "lat": lat,
            "properties": json.dumps(props, separators=(",", ":")),
            # Stable WVC identity used for idempotent re-ingestion.
            "station_id": f"{swath_id}:{scan_row}:{cell_index}",
        })
    return rows


async def insert_rows(rows: list[dict], dry_run: bool = False) -> tuple[int, int]:
    if not rows or dry_run:
        return (len(rows), 0)

    engine = get_engine()
    existing_sql = text(
        "SELECT station_id, valid_time FROM points "
        "WHERE source_id = :source_id "
        "AND valid_time BETWEEN :tmin AND :tmax "
        "AND station_id = ANY(:station_ids)"
    )
    insert_sql = text(
        "INSERT INTO points "
        "(source_id, valid_time, geom, properties, station_id) VALUES "
        "(:source_id, :valid_time, "
        " ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), "
        " CAST(:properties AS JSONB), :station_id)"
    )

    inserted = skipped = 0
    async with engine.begin() as conn:
        for start in range(0, len(rows), BATCH_SIZE):
            batch = rows[start:start + BATCH_SIZE]
            times = [r["valid_time"] for r in batch]
            result = await conn.execute(existing_sql, {
                "source_id": SOURCE_ID,
                "tmin": min(times),
                "tmax": max(times),
                "station_ids": [r["station_id"] for r in batch],
            })
            existing = {(r[0], r[1]) for r in result.fetchall()}
            pending = [
                r for r in batch
                if (r["station_id"], r["valid_time"]) not in existing
            ]
            if pending:
                await conn.execute(insert_sql, pending)
            inserted += len(pending)
            skipped += len(batch) - len(pending)
    return inserted, skipped


async def ingest_paths(paths: list[Path], dry_run: bool = False) -> tuple[int, int]:
    inserted = skipped = 0
    for path in paths:
        with _open_dataset(path) as ds:
            rows = rows_from_dataset(ds, path.name)
        added, duplicate = await insert_rows(rows, dry_run=dry_run)
        inserted += added
        skipped += duplicate
        print(f"{path}: {added} inserted, {duplicate} duplicates")
    return inserted, skipped


async def ingest_ftp(
    *,
    host: str,
    username: str,
    password: str,
    directories: tuple[str, ...] = DEFAULT_FTP_DIRECTORIES,
    state_path: Path = DEFAULT_STATE_PATH,
    max_recent: int = 20,
    use_tls: bool = False,
    dry_run: bool = False,
) -> tuple[int, int]:
    """Download and ingest the newest files not recorded in the local state."""
    state = _load_state(state_path)
    ftp = _ftp_connect(host, username, password, use_tls)
    try:
        candidates: list[tuple[str, str, datetime, str]] = []
        for directory in directories:
            for name, mtime in _list_remote_files(ftp, directory):
                remote_path = f"{directory.rstrip('/')}/{name}"
                previous = state.get(remote_path)
                if previous:
                    try:
                        if mtime <= datetime.fromisoformat(previous):
                            continue
                    except ValueError:
                        pass
                candidates.append((directory, name, mtime, remote_path))

        # Select newest files globally, then process that subset oldest first.
        candidates.sort(key=lambda item: item[2], reverse=True)
        if max_recent > 0:
            candidates = candidates[:max_recent]
        candidates.sort(key=lambda item: item[2])

        if not candidates:
            print("No new ASCAT files found.")
            return 0, 0

        inserted = skipped = 0
        for directory, name, mtime, remote_path in candidates:
            print(f"Downloading {remote_path}...")
            data = _download_remote(ftp, directory, name)
            with _open_dataset_bytes(data, name) as ds:
                rows = rows_from_dataset(ds, remote_path)
            if not rows:
                raise ValueError(
                    f"{remote_path} contained no valid ASCAT wind-vector cells; "
                    "FTP state was not advanced"
                )
            added, duplicate = await insert_rows(rows, dry_run=dry_run)
            inserted += added
            skipped += duplicate
            print(f"{remote_path}: {added} inserted, {duplicate} duplicates")

            # A dry run must not consume the file.  Otherwise, record state only
            # after parsing and all database batches complete successfully.
            if not dry_run:
                state[remote_path] = mtime.isoformat()
                _save_state(state_path, state)
        return inserted, skipped
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download and ingest ASCAT-B/C winds into TimescaleDB"
    )
    parser.add_argument(
        "paths", nargs="*", type=Path,
        help="Optional local .nc/.gz files. With no paths, download from FTP.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--ftp-host", default=os.environ.get("ASCAT_FTP_HOST", DEFAULT_FTP_HOST),
    )
    parser.add_argument(
        "--ftp-directory", action="append", dest="ftp_directories",
        help="Remote directory; repeat to select multiple directories.",
    )
    parser.add_argument(
        "--ftp-state", type=Path,
        default=Path(os.environ.get("ASCAT_FTP_STATE", str(DEFAULT_STATE_PATH))),
    )
    parser.add_argument(
        "--max-recent", type=int,
        default=int(os.environ.get("ASCAT_FTP_MAX_RECENT", "20")),
        help="Maximum newest unprocessed remote files per run; 0 means unlimited.",
    )
    parser.add_argument(
        "--ftp-tls", action="store_true",
        default=os.environ.get("ASCAT_FTP_TLS", "").lower() in {"1", "true", "yes"},
    )
    args = parser.parse_args()

    if args.paths:
        missing = [str(path) for path in args.paths if not path.is_file()]
        if missing:
            parser.error(f"files not found: {', '.join(missing)}")
        asyncio.run(ingest_paths(args.paths, dry_run=args.dry_run))
        return

    username = os.environ.get("ASCAT_FTP_USERNAME")
    password = os.environ.get("ASCAT_FTP_PASSWORD")
    if not username or not password:
        parser.error(
            "FTP mode requires ASCAT_FTP_USERNAME and ASCAT_FTP_PASSWORD"
        )
    directories = tuple(args.ftp_directories or DEFAULT_FTP_DIRECTORIES)
    asyncio.run(ingest_ftp(
        host=args.ftp_host,
        username=username,
        password=password,
        directories=directories,
        state_path=args.ftp_state,
        max_recent=args.max_recent,
        use_tls=args.ftp_tls,
        dry_run=args.dry_run,
    ))


if __name__ == "__main__":
    main()
