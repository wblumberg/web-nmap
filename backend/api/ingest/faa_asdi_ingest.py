#!/usr/bin/env python3
"""Run the FAA SWIM client continuously and ingest ASDI positions.

The Java client must emit one JSON FAA wrapper object per stdout line.

Environment:
  FAA_SWIM_RUN_CMD  Executable to launch (default:
                    /home/gblumberg/ingest/faa_swim/bin/run)
  FAA_SWIM_CONFIG   Typesafe config path (default: application.conf)
  TIMESCALE_CONN    SQLAlchemy async TimescaleDB DSN
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import shlex
import signal
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from backend.api.db.engine import get_engine
from backend.api.services.aircraft_sql import MAJOR_CARRIER_CODES

DEFAULT_RUN_CMD = "/home/gblumberg/ingest/faa_swim/bin/run"
BATCH_SIZE = 500
FLUSH_SECONDS = 1.0
DEFAULT_LINE_LIMIT_MB = 16

CORE30 = ["ATL", "BOS", "BWI", "CLT", "DCA", "DEN", "DFW", "DTW", "EWR", "FLL", "HNL", "IAD", "IAH", "JFK", "LAS", "LAX", "LGA", "MCO", "MDW", "MEM", "MIA", "MSP", "ORD", "PHL", "PHX", "SAN", "SEA", "SFO", "SLC", "TPA"]

def _as_list(value: Any) -> list:
    """Normalize a scalar or sequence as a list."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def extract_messages(obj: dict) -> list[dict]:
    """Extract messages."""
    root = obj.get("ds:tfmDataService", {})
    output = root.get("fltdOutput", {}) if isinstance(root, dict) else {}
    return [
        message for message in _as_list(output.get("fdm:fltdMessage"))
        if isinstance(message, dict)
    ]


def _parse_time(value: Any) -> datetime | None:
    """Parse time."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> float | None:
    """Coerce a value to a finite number when possible."""
    try:
        result = float(value)
        return result if result == result else None
    except (TypeError, ValueError):
        return None


def _carrier_code(acid: str | None) -> str | None:
    """Extract the normalized carrier prefix from a callsign."""
    match = re.match(r"^([A-Za-z]{3})", acid or "")
    return match.group(1).upper() if match else None


def _parse_carriers(value: str | None) -> frozenset[str] | None:
    """Parse carriers."""
    if not value:
        return None
    if value.strip().lower() == "major":
        return MAJOR_CARRIER_CODES
    codes = frozenset(code.strip().upper() for code in value.split(",") if code.strip())
    invalid = sorted(code for code in codes if len(code) != 3 or not code.isalnum())
    if invalid:
        raise ValueError(f"Invalid ICAO carrier codes: {', '.join(invalid)}")
    return codes or None


def _dms_to_decimal(value: Any, *, latitude: bool) -> float | None:
    """Convert one FAA ``latitudeDMS``/``longitudeDMS`` object."""
    if not isinstance(value, dict):
        return None
    degrees = _number(value.get("degrees"))
    minutes = _number(value.get("minutes"))
    seconds = _number(value.get("seconds"))
    if degrees is None or minutes is None or seconds is None:
        return None
    if minutes < 0 or minutes >= 60 or seconds < 0 or seconds >= 60:
        return None

    decimal = degrees + minutes / 60.0 + seconds / 3600.0
    direction = str(value.get("direction", "")).upper()
    if direction in {"SOUTH", "WEST", "S", "W"}:
        decimal = -decimal
    elif direction not in {"NORTH", "EAST", "N", "E"}:
        return None
    limit = 90 if latitude else 180
    return decimal if -limit <= decimal <= limit else None


def _reported_position(track: dict) -> tuple[float, float] | None:
    """Return the current reported position, falling back to nextEvent.

    ``nxcm:nextEvent`` is normally a future fix and can remain unchanged for
    several messages, so it must not be preferred for aircraft tracking.
    """
    position = track.get("nxcm:position", {})
    if isinstance(position, dict):
        latitude = position.get("nxce:latitude", {})
        longitude = position.get("nxce:longitude", {})
        lat_dms = latitude.get("nxce:latitudeDMS") if isinstance(latitude, dict) else None
        lon_dms = longitude.get("nxce:longitudeDMS") if isinstance(longitude, dict) else None
        lat = _dms_to_decimal(lat_dms, latitude=True)
        lon = _dms_to_decimal(lon_dms, latitude=False)
        if lat is not None and lon is not None:
            return lat, lon

    ncsm = track.get("nxcm:ncsmTrackData", {})
    event = ncsm.get("nxcm:nextEvent", {}) if isinstance(ncsm, dict) else {}
    if isinstance(event, dict):
        lat = _number(event.get("latitudeDecimal"))
        lon = _number(event.get("longitudeDecimal"))
        if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
            return lat, lon
    return None


def _parse_reported_altitude(value: Any) -> tuple[int | None, str | None]:
    """Parse an FAA altitude in hundreds of feet plus optional B/C/T suffix."""
    match = re.fullmatch(r"([+-]?\d+(?:\.\d+)?)([BCT]?)", str(value).strip().upper())
    if match is None:
        return None, None
    suffix = match.group(2) or None
    altitude_ft = round(float(match.group(1)) * 100)
    # T means an interim altitude is displayed in the assigned-altitude field,
    # not an ordinary beacon altitude. Preserve the suffix but do not plot it
    # as a measured altitude.
    return (None if suffix == "T" else altitude_ft), suffix


def _reported_altitude(track: dict) -> tuple[int | None, str | None]:
    """Extract the NAS reported altitude and its optional B/C/T suffix.

    The FAA JSON representation nests ``assignedAltitude`` inside the
    semantically authoritative ``reportedAltitude`` container. In this
    context it carries the reported level; it is distinct from a standalone
    flight-plan assigned altitude.
    """
    reported = track.get("nxcm:reportedAltitude")
    if not isinstance(reported, dict):
        return None, None

    if "nxce:simpleAltitude" in reported:
        return _parse_reported_altitude(reported["nxce:simpleAltitude"])

    for key, value in reported.items():
        normalized = str(key).lower()
        if not any(
            token in normalized for token in ("assigned", "actual", "measured", "reported")
        ):
            continue
        if isinstance(value, dict) and "nxce:simpleAltitude" in value:
            return _parse_reported_altitude(value["nxce:simpleAltitude"])
    return None, None


def _reported_altitude_ft(track: dict) -> int | None:
    """Backward-compatible altitude-only helper."""
    return _reported_altitude(track)[0]


def extract_position(msg: dict, received_at: datetime | None = None) -> dict | None:
    """Normalize one ``fdm:fltdMessage`` into an aircraft-position row."""
    received_at = received_at or datetime.now(timezone.utc)
    track = msg.get("fdm:trackInformation", {})
    if not isinstance(track, dict):
        return None
    reported_position = _reported_position(track)
    if reported_position is None:
        return None
    lat, lon = reported_position

    qualified = track.get("nxcm:qualifiedAircraftId", {})
    if not isinstance(qualified, dict):
        qualified = {}
    departure = qualified.get("nxce:departurePoint", {})
    arrival = qualified.get("nxce:arrivalPoint", {})
    departure_airport = departure.get("nxce:airport") if isinstance(departure, dict) else None
    arrival_airport = arrival.get("nxce:airport") if isinstance(arrival, dict) else None

    flight_ref = (
        msg.get("flightRef")
        or qualified.get("nxce:gufi")
        or msg.get("acid")
        or qualified.get("nxce:aircraftId")
    )
    if flight_ref is None:
        return None

    altitude_ft, altitude_suffix = _reported_altitude(track)

    observation_time = (
        _parse_time(track.get("nxcm:timeAtPosition"))
        or _parse_time(msg.get("sourceTimeStamp"))
        or received_at
    )
    source_timestamp = _parse_time(msg.get("sourceTimeStamp"))
    acid = msg.get("acid") or qualified.get("nxce:aircraftId")
    speed = _number(track.get("nxcm:speed"))

    return {
        "observation_time": observation_time,
        "flight_ref": str(flight_ref),
        "acid": str(acid) if acid is not None else None,
        "departure_airport": (
            str(msg.get("depArpt") or departure_airport).upper()
            if msg.get("depArpt") or departure_airport else None
        ),
        "arrival_airport": (
            str(msg.get("arrArpt") or arrival_airport).upper()
            if msg.get("arrArpt") or arrival_airport else None
        ),
        "altitude_ft": altitude_ft,
        "altitude_suffix": altitude_suffix,
        "ground_speed_kt": speed,
        "lon": lon,
        "lat": lat,
        "message_type": msg.get("msgType"),
        "source_timestamp": source_timestamp,
        "received_at": received_at,
        "raw_message": json.dumps(msg, separators=(",", ":"), default=str),
    }


_UPSERT = text("""
    INSERT INTO aircraft_positions (
      observation_time, flight_ref, acid, departure_airport, arrival_airport,
      altitude_ft, altitude_suffix, ground_speed_kt, geom, message_type, source_timestamp,
      received_at, raw_message
    ) VALUES (
      :observation_time, :flight_ref, :acid, :departure_airport, :arrival_airport,
      :altitude_ft, :altitude_suffix, :ground_speed_kt,
      ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
      :message_type, :source_timestamp, :received_at, CAST(:raw_message AS JSONB)
    )
    ON CONFLICT (flight_ref, observation_time) DO UPDATE SET
      acid = EXCLUDED.acid,
      departure_airport = COALESCE(EXCLUDED.departure_airport, aircraft_positions.departure_airport),
      arrival_airport = COALESCE(EXCLUDED.arrival_airport, aircraft_positions.arrival_airport),
      altitude_ft = EXCLUDED.altitude_ft,
      altitude_suffix = EXCLUDED.altitude_suffix,
      ground_speed_kt = EXCLUDED.ground_speed_kt,
      geom = EXCLUDED.geom,
      message_type = EXCLUDED.message_type,
      source_timestamp = EXCLUDED.source_timestamp,
      received_at = EXCLUDED.received_at,
      raw_message = EXCLUDED.raw_message
""")


async def insert_positions(rows: list[dict]) -> int:
    """Insert positions."""
    if not rows:
        return 0
    engine = get_engine()
    async with engine.begin() as connection:
        await connection.execute(_UPSERT, rows)
    return len(rows)


def _command(args) -> list[str]:
    """Build the FAA ASDI consumer command from CLI arguments."""
    command = shlex.split(os.environ.get("FAA_SWIM_RUN_CMD", DEFAULT_RUN_CMD))
    config = os.environ.get("FAA_SWIM_CONFIG", args.config)
    if config:
        command.append(f"-Dconfig.file={config}")
    return command


async def consume(args) -> None:
    """Consume the requested value."""
    command = _command(args)
    logging.info("Starting FAA SWIM client: %s", shlex.join(command))
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        # FAA wrapper objects can contain many fdm:fltdMessage entries and
        # regularly exceed asyncio's 64 KiB StreamReader default.
        limit=args.line_limit_mb * 1024 * 1024,
    )
    assert process.stdout is not None

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for signame in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signame, stop.set)
        except NotImplementedError:
            pass

    pending: list[dict] = []
    last_flush = loop.time()
    try:
        while not stop.is_set():
            try:
                raw_line = await asyncio.wait_for(
                    process.stdout.readline(), timeout=FLUSH_SECONDS
                )
            except asyncio.TimeoutError:
                raw_line = b""

            if raw_line:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line.startswith("{"):
                    try:
                        wrapper = json.loads(line)
                    except json.JSONDecodeError:
                        logging.warning("Discarding malformed JSON line")
                    else:
                        received_at = datetime.now(timezone.utc)
                        for message in extract_messages(wrapper):
                            row = extract_position(message, received_at)
                            if (
                                row is not None
                                and (
                                    args.allowed_carriers is None
                                    or _carrier_code(row["acid"]) in args.allowed_carriers
                                )
                            ):
                                pending.append(row)
                elif args.verbose and line:
                    logging.info("[java] %s", line)
            elif process.returncode is not None:
                break

            now = loop.time()
            if pending and (
                len(pending) >= args.batch_size
                or now - last_flush >= args.flush_seconds
            ):
                batch, pending = pending, []
                await insert_positions(batch)
                logging.info("Upserted %d FAA positions", len(batch))
                last_flush = now
        if pending:
            await insert_positions(pending)
            logging.info("Upserted final %d FAA positions", len(pending))
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=10)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    if process.returncode not in (0, -signal.SIGTERM):
        raise RuntimeError(f"FAA SWIM client exited with status {process.returncode}")


def main() -> None:
    """Run the command-line entry point."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--config", default="application.conf",
        help="Typesafe config passed to the FAA Java client",
    )
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--flush-seconds", type=float, default=FLUSH_SECONDS)
    parser.add_argument(
        "--line-limit-mb",
        type=int,
        default=int(os.environ.get(
            "FAA_SWIM_LINE_LIMIT_MB", str(DEFAULT_LINE_LIMIT_MB)
        )),
        help="Maximum size of one JSON line emitted by the SWIM client.",
    )
    parser.add_argument(
        "--carriers",
        default=os.environ.get("FAA_ASDI_CARRIERS"),
        help="Optional ingest whitelist of ICAO carrier codes, or 'major'.",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.line_limit_mb < 1:
        parser.error("--line-limit-mb must be at least 1")
    try:
        args.allowed_carriers = _parse_carriers(args.carriers)
    except ValueError as error:
        parser.error(str(error))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    asyncio.run(consume(args))


if __name__ == "__main__":
    main()
