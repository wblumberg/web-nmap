#!/usr/bin/env python3
"""Ingest NWS CAP watch/warning/advisory alerts into the ``alerts`` hypertable.

Usage
-----
  # Fetch live active alerts from the NWS API and ingest them:
  python -m backend.api.ingest.alerts.run_ingest --fetch

  # Parse a saved API response JSON without writing to the DB:
  python -m backend.api.ingest.alerts.run_ingest --sample backend/api/ingest/alerts/weather_alerts.json --dry-run

  # Full live run with custom county shapefile:
  python -m backend.api.ingest.alerts.run_ingest --fetch \\
      --shp backend/assets/mapping/counties/counties_boundaries_2025.shp

  # Restrict to specific phenomena (e.g. only tornado/severe thunderstorm):
  python -m backend.api.ingest.alerts.run_ingest --fetch --phen TO,SV

  # Restrict to a specific CWA:
  python -m backend.api.ingest.alerts.run_ingest --fetch --office KTLX

  # Ingest alerts from a specific state (NWS API parameter):
  python -m backend.api.ingest.alerts.run_ingest --fetch --area OK

Environment
-----------
  TIMESCALE_CONN   Override default DSN (see db/engine.py).

Default shapefile
-----------------
  backend/assets/mapping/counties/counties_boundaries_2025.shp
  (relative to the repo root; provide --shp to override)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Optional

import requests

from sqlalchemy.exc import OperationalError

from backend.api.ingest.alerts.cap_parser import parse_vtec_list
from backend.api.ingest.alerts.ingest import ingest_feature

# ── Defaults ──────────────────────────────────────────────────────────────────

_NWS_ALERTS_URL = "https://api.weather.gov/alerts/active"
_NWS_HEADERS    = {
    "User-Agent": "web-nmap/0.1 (contact: webmaster)",
    "Accept":     "application/geo+json",
}

_DEFAULT_SHP = Path(__file__).resolve().parents[4] / (
    "assets/mapping/counties/counties_boundaries_2025.shp"
)

# Retry configuration for transient DB errors (recovery mode, dropped connections)
_MAX_RETRIES   = 4
_RETRY_DELAYS  = (2, 5, 15, 30)   # seconds per attempt


# ── Fetch helpers ─────────────────────────────────────────────────────────────

def fetch_active_alerts(
    area: Optional[str]   = None,
    office: Optional[str] = None,
    phen_filter: Optional[set[str]] = None,
    timeout: int = 30,
) -> list[dict]:
    """Download active NWS alerts and return the feature list.

    Parameters
    ----------
    area:
        Two-letter state abbreviation to pass as the ``area`` query param
        (e.g. ``"OK"``).  When None, all US alerts are fetched.
    office:
        Filter results to a specific NWS office (4-letter code, e.g. ``"KTLX"``).
        Applied client-side after fetch.
    phen_filter:
        Set of 2-letter VTEC phenomena codes to keep (e.g. ``{"TO", "SV"}``).
        Applied client-side after fetch.
    """
    params = {"status": "actual"}
    if area:
        params["area"] = area.upper()

    resp = requests.get(_NWS_ALERTS_URL, headers=_NWS_HEADERS,
                        params=params, timeout=timeout)
    resp.raise_for_status()
    features: list[dict] = resp.json().get("features") or []

    if office:
        office_upper = office.upper()
        features = [
            f for f in features
            if any(
                (p.get("parameters") or {}).get("VTEC") and
                any(office_upper in v for v in (p.get("parameters") or {}).get("VTEC", []))
                for p in [f.get("properties") or {}]
            )
        ]

    if phen_filter:
        def _has_phen(feature):
            """Return whether the value has phen."""
            vtecs = (feature.get("properties") or {}).get("parameters", {}).get("VTEC") or []
            parsed = parse_vtec_list(vtecs)
            return any(p.get("phen") in phen_filter for p in parsed)
        features = [f for f in features if _has_phen(f)]

    return features


# ── Ingest runner ─────────────────────────────────────────────────────────────

async def run(
    features: list[dict],
    shp_path: Optional[str],
    dry_run: bool = False,
    verbose: bool = False,
    skip_urn: bool = False,
) -> tuple[int, int, int]:
    """Ingest a list of NWS alert features.

    Returns (inserted_or_updated, skipped, error) counts.
    """
    engine = None
    if not dry_run:
        from backend.api.db.engine import get_engine
        engine = get_engine()

    ok = skipped = errors = 0

    for i, feat in enumerate(features, start=1):
        props      = feat.get("properties") or {}
        parameters = props.get("parameters") or {}
        vtecs      = parameters.get("VTEC") or []
        parsed     = parse_vtec_list(vtecs) if vtecs else []

        canonical = (parsed[0].get("canonical_key") if parsed
                     else props.get("id") or props.get("@id"))
        event_str = props.get("event", "?")
        phen   = parsed[0]["phen"]   if parsed else None
        sig    = parsed[0]["significance"] if parsed else None
        action = parsed[0]["action"] if parsed else None

        if skip_urn and isinstance(canonical, str) and canonical.startswith("urn:"):
            skipped += 1
            if verbose or dry_run:
                print(f"[{i:3d}] SKIP  {canonical!r:40s} {event_str} (URN canonical key)")
            continue

        if dry_run:
            has_geom = bool(feat.get("geometry"))
            same_count = len((props.get("geocode") or {}).get("SAME") or [])
            print(f"[{i:3d}] canonical={canonical!r:40s} "
                  f"event={event_str!r:30s} "
                  f"phen={phen} sig={sig} action={action} "
                  f"has_geom={has_geom} same_codes={same_count}")
            ok += 1
            continue

        try:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    key = await ingest_feature(feat, county_shp_path=shp_path, engine=engine)
                    break
                except OperationalError as exc:
                    if attempt >= _MAX_RETRIES:
                        raise
                    delay = _RETRY_DELAYS[attempt]
                    print(f"[{i:3d}] RETRY ({attempt + 1}/{_MAX_RETRIES}) "
                          f"in {delay}s – {exc.__class__.__name__}",
                          file=sys.stderr)
                    await asyncio.sleep(delay)
            if key:
                ok += 1
                if verbose:
                    print(f"[{i:3d}] OK    {key!r:40s} {event_str}")
            else:
                skipped += 1
                if verbose:
                    reason = "no geometry and no county SAME codes"
                    if not feat.get("geometry"):
                        same = (props.get("geocode") or {}).get("SAME") or []
                        if same and not shp_path:
                            reason = "SAME codes present but --shp not provided"
                        elif same:
                            reason = "SAME codes present but no county match (marine/zone)"
                    print(f"[{i:3d}] SKIP  {canonical!r:40s} {event_str} ({reason})")
        except Exception as exc:
            errors += 1
            print(f"[{i:3d}] ERROR {canonical!r}: {exc}", file=sys.stderr)
            if verbose:
                import traceback
                traceback.print_exc()

    return ok, skipped, errors


# ── CLI ────────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    """Build parser."""
    p = argparse.ArgumentParser(
        prog="run_ingest.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--fetch",
        action="store_true",
        help="Fetch active alerts from the NWS API (api.weather.gov/alerts/active)",
    )
    src.add_argument(
        "--sample",
        metavar="FILE",
        help="Path to a saved NWS API response JSON file",
    )

    p.add_argument(
        "--shp",
        default=str(_DEFAULT_SHP) if _DEFAULT_SHP.exists() else None,
        help="Path to county boundary shapefile (default: %(default)s)",
    )
    p.add_argument(
        "--area",
        default=None,
        help="Two-letter state code to pass to NWS API (e.g. OK).  --fetch only.",
    )
    p.add_argument(
        "--office",
        default=None,
        help="Filter to a specific NWS office (e.g. KTLX).  Applied client-side.",
    )
    p.add_argument(
        "--phen",
        default=None,
        help="Comma-separated VTEC phenomena to keep (e.g. TO,SV,FF).  "
             "Applied client-side.",
    )
    p.add_argument(
        "--skip-urn",
        action="store_true",
        help="Skip features whose canonical key is a URN (non-VTEC alerts such as "
             "Special Weather Statements whose NWS event ID is used instead of a "
             "VTEC string, e.g. urn:oid:2.49.0.1.840.0...)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and report counts without writing to the DB",
    )
    p.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print one line per feature (OK / SKIP / ERROR)",
    )
    return p


async def main() -> None:
    """Run the command-line entry point."""
    parser = _build_parser()
    args   = parser.parse_args()

    phen_filter = {p.strip().upper() for p in args.phen.split(",")} if args.phen else None

    # ── Load features ──────────────────────────────────────────────────────
    if args.fetch:
        print(f"Fetching active alerts from {_NWS_ALERTS_URL} …")
        try:
            features = fetch_active_alerts(
                area=args.area,
                office=args.office,
                phen_filter=phen_filter,
            )
        except requests.HTTPError as e:
            print(f"HTTP error fetching alerts: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"Fetched {len(features)} feature(s)")
    else:
        path = args.sample
        if not os.path.exists(path):
            print(f"Sample file not found: {path}", file=sys.stderr)
            sys.exit(1)
        with open(path) as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "features" in data:
            features = data["features"]
        elif isinstance(data, list):
            features = data
        else:
            print("Unexpected JSON structure in sample file", file=sys.stderr)
            sys.exit(1)

        # Apply client-side filters
        if phen_filter:
            def _has_phen(feat):
                """Return whether the value has phen."""
                vtecs = (feat.get("properties") or {}).get("parameters", {}).get("VTEC") or []
                return any(p.get("phen") in phen_filter for p in parse_vtec_list(vtecs))
            features = [f for f in features if _has_phen(f)]
        if args.office:
            office_upper = args.office.upper()
            features = [
                f for f in features
                if any(office_upper in v
                       for v in ((f.get("properties") or {}).get("parameters", {}).get("VTEC") or []))
            ]

        print(f"Loaded {len(features)} feature(s) from {path}")

    if not features:
        print("No features to process.")
        return

    # ── Validate shapefile ─────────────────────────────────────────────────
    shp = args.shp
    if shp and not os.path.exists(shp):
        print(f"Warning: shapefile not found: {shp}.  County reconstruction disabled.",
              file=sys.stderr)
        shp = None
    if not shp:
        print("Warning: no shapefile provided.  County reconstruction disabled.  "
              "Only features with API-provided geometry will be ingested.")

    # ── Run ingest ─────────────────────────────────────────────────────────
    print("Running ingest into TimescaleDB...")
    ok, skipped, errors = await run(
        features,
        shp_path=shp,
        dry_run=args.dry_run,
        verbose=args.verbose,
        skip_urn=args.skip_urn,
    )

    mode = "dry-run" if args.dry_run else "ingested"
    print(f"\n{'─' * 50}")
    print(f"  {mode}: {ok}   skipped: {skipped}   errors: {errors}")

    # Dispose the engine explicitly so asyncpg closes all pool connections
    # before the event loop tears down.  Without this, asyncpg's SSL/TLS
    # shutdown races with loop closure and causes a segfault on Linux.
    if not args.dry_run:
        from backend.api.db.engine import get_engine
        engine = get_engine()
        await engine.dispose()

    if not args.dry_run and errors:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
