import os
import gzip
import shutil
import tempfile
import requests
import argparse
import asyncio
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from backend.api.ingest.atcf_db_ingest import _parse_line, _ingest_points

AID_PUBLIC_URL = "https://ftp.nhc.noaa.gov/atcf/aid_public/"
OUTPUT_DIR = "/data/gempak/atcf/"
DOWNLOAD_DIR = "./"
CHUNK_SIZE = 64 * 1024  # 64KB


def get_file_links(session):
    """Parse the HTML directory listing and return a list of .dat.gz filenames."""
    r = session.get(AID_PUBLIC_URL, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    links = [a["href"] for a in soup.find_all("a", href=True) if a["href"].endswith(".dat.gz")]
    return links


def get_file_modtime(session, filename):
    """Get the modification time of a file from the HTTP headers (if available)."""
    url = AID_PUBLIC_URL + filename
    r = session.head(url, allow_redirects=True, timeout=20)
    if "Last-Modified" in r.headers:
        # parsedate_to_datetime handles timezone-aware parsing reliably
        try:
            dt = parsedate_to_datetime(r.headers["Last-Modified"])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None
    return None


def download_file(session, url, dest_path, chunk_size=CHUNK_SIZE):
    """Stream-download to a temp file and atomically move to dest_path."""
    tmp_dir = os.path.dirname(dest_path) or "."
    tmp = None
    try:
        with session.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            with tempfile.NamedTemporaryFile(dir=tmp_dir, delete=False) as tmp:
                for chunk in r.iter_content(chunk_size=chunk_size):
                    if chunk:
                        tmp.write(chunk)
                tmp.flush()
        # atomic replace
        os.replace(tmp.name, dest_path)
        tmp = None
    finally:
        # remove incomplete temp file if something went wrong
        if tmp is not None and os.path.exists(tmp.name):
            try:
                os.remove(tmp.name)
            except Exception:
                pass


def decompress_gz(src_path, dest_path, buffer_size=CHUNK_SIZE):
    """Decompress gzip file using buffered copy to avoid loading whole file into memory."""
    with gzip.open(src_path, "rb") as f_in, open(dest_path, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out, length=buffer_size)


def _parse_gz_atcf_points(src_path, source_id):
    """Parse ATCF points directly from a downloaded .dat.gz file."""
    points = []
    bad_lines = 0
    with gzip.open(src_path, "rt", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            s = line.strip()
            if not s:
                continue
            p = _parse_line(s, source_id)
            if p is None:
                bad_lines += 1
                continue
            points.append(p)
    return points, bad_lines


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def main(
    min_age_hours=0,
    source_id="ATCF_TRACKS",
    persist_files=False,
    dry_run=False,
):
    ensure_dir(DOWNLOAD_DIR)
    if persist_files:
        ensure_dir(OUTPUT_DIR)
    now = datetime.now(timezone.utc)
    total_points = 0
    total_bad_lines = 0

    all_points = []

    with requests.Session() as session:
        files = get_file_links(session)
        print(f"Found {len(files)} .dat.gz files.")

        for filename in files:
            url = AID_PUBLIC_URL + filename
            download_path = os.path.join(DOWNLOAD_DIR, filename)
            decompressed_name = filename[:-3]  # Remove '.gz'
            decompressed_path = os.path.join(OUTPUT_DIR, decompressed_name)

            # Age filter (if specified)
            if min_age_hours > 0:
                modtime = get_file_modtime(session, filename)
                if modtime:
                    age_hours = (now - modtime).total_seconds() / 3600
                    if age_hours < min_age_hours:
                        print(f"Skipping {filename}: age {age_hours:.1f}h < min_age {min_age_hours}h")
                        continue

            print(f"Downloading {filename} ...")
            download_file(session, url, download_path)

            points, bad_lines = _parse_gz_atcf_points(download_path, source_id)
            total_points += len(points)
            total_bad_lines += bad_lines
            all_points.extend(points)
            print(
                f"Parsed {len(points)} point(s) from {filename} "
                f"(skipped {bad_lines} line(s))."
            )

            if persist_files:
                print(f"Decompressing {filename} ...")
                decompress_gz(download_path, decompressed_path)
                print(f"Decompressed to {decompressed_path}")

            try:
                os.remove(download_path)  # Delete the .gz file after decompression
            except FileNotFoundError:
                pass

    print(f"Total parsed points: {total_points}; total skipped lines: {total_bad_lines}")
    inserted, skipped = asyncio.run(_ingest_points(all_points, dry_run=dry_run))
    if dry_run:
        print(f"[dry-run] Would insert {inserted} row(s) (in-memory skipped duplicates: {skipped}).")
    else:
        print(f"Inserted {inserted} row(s) (in-memory skipped duplicates: {skipped}).")


def _build_parser():
    p = argparse.ArgumentParser(
        description="Download ATCF A-deck files and ingest directly to atcf_tracks"
    )
    p.add_argument("--min-age-hours", type=float, default=0)
    p.add_argument("--source-id", default="ATCF_TRACKS")
    p.add_argument(
        "--persist-files",
        action="store_true",
        help="Also write decompressed .dat files to OUTPUT_DIR",
    )
    p.add_argument("--dry-run", action="store_true")
    return p


if __name__ == "__main__":
    args = _build_parser().parse_args()
    main(
        min_age_hours=args.min_age_hours,
        source_id=args.source_id,
        persist_files=args.persist_files,
        dry_run=args.dry_run,
    )
