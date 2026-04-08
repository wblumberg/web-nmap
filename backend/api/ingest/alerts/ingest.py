"""NWS CAP alerts ingest → `alerts` hypertable.

Provides ``ingest_feature`` which accepts a single GeoJSON Feature from the
NWS /alerts API, derives geometry (from the feature itself or by reconstructing
county outlines from SAME codes), and upserts the row into the ``alerts`` table.

Geometry merge strategy
-----------------------
The same VTEC canonical key (e.g. KOUN-0093-TO) can appear in multiple API
responses when a watch covers multiple CWA forecast offices.  On a second
insert, ``ST_Union`` merges the new geometry into the existing one so the
final row contains the combined area.

Upsert strategy
---------------
The ``alerts`` hypertable has no UNIQUE constraint (TimescaleDB requires all
unique indexes to include the partitioning column, and partial unique indexes
have additional restrictions).  We use an explicit UPDATE-then-INSERT pattern:
  1. Attempt UPDATE WHERE canonical_key = :key AND start_utc = :start
  2. If zero rows affected, INSERT.
"""
from __future__ import annotations

import json
from typing import Optional
from datetime import datetime, timezone

from shapely.geometry import mapping
from sqlalchemy import text

from backend.api.db.engine import get_engine
from backend.api.ingest.alerts.cap_parser import parse_vtec_list
from backend.api.ingest.alerts.counties import counties_to_multipolygon


# ── Time helpers ──────────────────────────────────────────────────────────────

def _to_utc(ts) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp string (or datetime) to timezone-aware UTC."""
    if not ts:
        return None
    if isinstance(ts, datetime):
        if ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)
    try:
        return datetime.fromisoformat(str(ts).replace('Z', '+00:00')).astimezone(timezone.utc)
    except Exception:
        return None


# ── SQL templates ─────────────────────────────────────────────────────────────

# Try to update an existing row, merging geometry via ST_Union.
_UPDATE_SQL = text("""
    UPDATE alerts
       SET geom       = ST_Multi(ST_MakeValid(ST_Union(
                            ST_Multi(COALESCE(geom,
                                ST_GeomFromText('MULTIPOLYGON EMPTY', 4326))),
                            ST_Multi(ST_SetSRID(
                                ST_GeomFromGeoJSON(:geom_json), 4326))
                        ))),
           end_utc    = GREATEST(COALESCE(end_utc, :end_utc), :end_utc),
           counties   = COALESCE(counties, '[]'::jsonb)
                        || COALESCE(CAST(:counties AS jsonb), '[]'::jsonb),
           raw_message = CAST(:raw AS jsonb),
           action     = :action,
           updated_at = now()
     WHERE canonical_key = :canonical_key
       AND start_utc     = :start_utc
""")

# Insert a brand-new row.
_INSERT_SQL = text("""
    INSERT INTO alerts
        (canonical_key, event_id, office, etn, phen, significance, action,
         start_utc, end_utc,
         geom, counties, raw_message, source)
    VALUES
        (:canonical_key, :event_id, :office, :etn, :phen, :significance, :action,
         :start_utc, :end_utc,
         ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326))),
         CAST(:counties AS jsonb), CAST(:raw AS jsonb), :source)
""")


# ── Public API ────────────────────────────────────────────────────────────────

async def ingest_feature(
    feature: dict,
    county_shp_path: Optional[str] = None,
    engine=None,
) -> Optional[str]:
    """Ingest one NWS GeoJSON Feature into the ``alerts`` table.

    Parameters
    ----------
    feature:
        A single element from the ``features`` list of a NWS /alerts response.
    county_shp_path:
        Absolute path to the county boundary shapefile.  Required when
        a feature lacks API-provided geometry; the SAME codes in
        ``properties.geocode.SAME`` will be used to reconstruct county
        outlines.
    engine:
        Optional SQLAlchemy async engine.  Defaults to ``get_engine()``.

    Returns
    -------
    The ``canonical_key`` string on success, or ``None`` if the feature was
    intentionally skipped (no geometry, unresolvable event, etc.).
    """
    props      = feature.get('properties') or {}
    parameters = props.get('parameters') or {}

    # ── 1. Parse VTEC ────────────────────────────────────────────────────────
    vtecs   = parameters.get('VTEC') or []
    parsed  = parse_vtec_list(vtecs) if vtecs else []
    vtec    = parsed[0] if parsed else None

    # ── 2. Canonical key ─────────────────────────────────────────────────────
    # VTEC alerts: office-etn-phen (e.g. KOUN-0093-TO) — shared across CWAs
    # Non-VTEC alerts: NWS event @id — unique per message
    if vtec and vtec.get('canonical_key'):
        canonical_key = vtec['canonical_key']
    else:
        canonical_key = props.get('id') or props.get('@id')

    if not canonical_key:
        return None  # cannot identify this alert

    # ── 3. Geometry ──────────────────────────────────────────────────────────
    geom_json    = None
    geom_source  = 'api'
    counties_json = '[]'

    if feature.get('geometry'):
        # API provided a polygon — use it directly.
        geom_json = json.dumps(feature['geometry'])

    else:
        # No geometry in the response.  Attempt county reconstruction.
        # NWS SAME codes are 6-digit: the last 5 digits are the 5-digit FIPS.
        same_codes: list[str] = (props.get('geocode') or {}).get('SAME') or []
        if same_codes and county_shp_path:
            fips_list = [s[-5:] for s in same_codes]
            shapely_geom = counties_to_multipolygon(county_shp_path, fips_list)
            if shapely_geom is not None:
                geom_json     = json.dumps(mapping(shapely_geom))
                geom_source   = 'counties'
                counties_json = json.dumps(fips_list)

    if geom_json is None:
        # Marine/zone-only alerts, or missing shapefile — cannot store geometry.
        return None

    # ── 4. Times ─────────────────────────────────────────────────────────────
    # VTEC zero-sentinel (000000T0000Z) comes back as None from the parser.
    # Fall back to the properties onset/ends/expires fields.
    #
    # Use 'ends'    for end_utc   — the *meteorological* end of the event.
    # Use 'expires' only as a     fallback (it is the message expiry time,
    #                              which can be hours before the event ends).

    prop_onset    = _to_utc(props.get('onset'))
    prop_effective= _to_utc(props.get('effective'))
    prop_sent     = _to_utc(props.get('sent'))
    prop_ends     = _to_utc(props.get('ends'))       # meteorological end
    prop_expires  = _to_utc(props.get('expires'))   # message expiry fallback

    vtec_start = vtec['start_utc'] if vtec else None
    vtec_end   = vtec['end_utc']   if vtec else None

    start_utc = (
        vtec_start
        or prop_onset
        or prop_effective
        or prop_sent
        or datetime.now(timezone.utc)   # safety net — should never reach this
    )
    end_utc = vtec_end or prop_ends or prop_expires

    # Sanity: start must not be after end
    if end_utc is not None and start_utc > end_utc:
        print(f"[alerts] Warning: start_utc > end_utc for {canonical_key!r}, "
              f"clamping end_utc = start_utc")
        end_utc = start_utc

    # ── 5. Parameters for SQL ────────────────────────────────────────────────
    params = {
        'canonical_key': canonical_key,
        'event_id':      props.get('id') or props.get('@id'),
        'office':        vtec['office']       if vtec else None,
        'etn':           vtec['etn_padded']   if vtec else None,
        'phen':          vtec['phen']         if vtec else None,
        'significance':  vtec['significance'] if vtec else None,
        'action':        vtec['action']       if vtec else None,
        'start_utc':     start_utc,
        'end_utc':       end_utc,
        'geom_json':     geom_json,
        'counties':      counties_json,
        'raw':           json.dumps(feature),
        'source':        geom_source,
    }

    # ── 6. Upsert (UPDATE then INSERT) ───────────────────────────────────────
    if engine is None:
        engine = get_engine()

    async with engine.begin() as conn:
        result = await conn.execute(_UPDATE_SQL, params)
        if result.rowcount == 0:
            await conn.execute(_INSERT_SQL, params)

    return canonical_key
