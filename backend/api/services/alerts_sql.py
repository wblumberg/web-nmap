"""DB-backed query service for NWS CAP watches/warnings/advisories.

Provides ``query_alerts_geojson`` which queries the ``alerts`` TimescaleDB
hypertable and returns a GeoJSON FeatureCollection of polygons valid at a
given time, optionally filtered by significance, phenomenon, and bounding box.

The three significance-level sources exposed via the geometry router are:

    GET /api/v1/geometries/alerts_warnings/features?at=2026-04-07T22:00:00Z
    GET /api/v1/geometries/alerts_watches/features?at=2026-04-07T22:00:00Z&phen=TO
    GET /api/v1/geometries/alerts_advisories/features?at=2026-04-07T22:00:00Z

The optional ``phen`` query parameter accepts either a 2-letter VTEC code
(e.g. ``TO``) or a friendly type name (e.g. ``tornado``).  Use
``GET /api/v1/geometries/alerts/types`` to list all available type names.

VTEC code reference
-------------------
Phenomena (phen):
  TO=Tornado  SV=Severe Thunderstorm  FF=Flash Flood  FA=Areal Flood
  FL=River Flood  WS=Winter Storm  WW=Winter Weather  BZ=Blizzard
  IS=Ice Storm  HS=Heavy Snow  LE=Lake Effect Snow  ZR=Freezing Rain
  HW=High Wind  WI=Wind  EW=Extreme Wind  HU=Hurricane  TY=Typhoon
  TR=Tropical Storm  FW=Fire Weather  FG=Dense Fog  SM=Dense Smoke
  EH=Excessive Heat  HT=Heat  FZ=Freeze  HZ=Hard Freeze  FR=Frost
  CF=Coastal Flood  SU=High Surf  DS=Dust Storm  AS=Air Stagnation

Significance (sig):
  W=Warning  A=Watch  Y=Advisory  S=Statement
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text

from backend.api.db.engine import get_engine


# ── Significance → source_id mapping ─────────────────────────────────────────

ALERT_SOURCES: dict[str, str] = {
    "W": "alerts_warnings",
    "A": "alerts_watches",
    "Y": "alerts_advisories",
}

# Reverse: source_id → significance
ALERT_SOURCE_SIG: dict[str, str] = {v: k for k, v in ALERT_SOURCES.items()}


# ── Phenomenon code → friendly label ─────────────────────────────────────────
# Used by the /alerts/types discovery endpoint and for resolving
# human-readable ?phen= values (e.g. "tornado" → "TO").

ALERT_PHEN_LABELS: dict[str, str] = {
    "TO": "Tornado",
    "SV": "Severe Thunderstorm",
    "FF": "Flash Flood",
    "FA": "Areal Flood",
    "FL": "River Flood",
    "WS": "Winter Storm",
    "WW": "Winter Weather",
    "BZ": "Blizzard",
    "IS": "Ice Storm",
    "HS": "Heavy Snow",
    "LE": "Lake Effect Snow",
    "ZR": "Freezing Rain",
    "HW": "High Wind",
    "WI": "Wind",
    "EW": "Extreme Wind",
    "HU": "Hurricane",
    "TY": "Typhoon",
    "TR": "Tropical Storm",
    "FW": "Fire Weather",
    "FG": "Dense Fog",
    "SM": "Dense Smoke",
    "EH": "Excessive Heat",
    "HT": "Heat",
    "FZ": "Freeze",
    "HZ": "Hard Freeze",
    "FR": "Frost",
    "CF": "Coastal Flood",
    "SU": "High Surf",
    "DS": "Dust Storm",
    "AS": "Air Stagnation",
}

# Reverse lookup: lowercase label / slug → phen code
# e.g. "tornado" → "TO", "severe_thunderstorm" → "SV"
_LABEL_TO_PHEN: dict[str, str] = {
    label.lower().replace(" ", "_"): code
    for code, label in ALERT_PHEN_LABELS.items()
}


def resolve_phen(value: Optional[str]) -> Optional[str]:
    """Resolve a user-supplied phen value to a 2-letter VTEC code.

    Accepts:
    - Already a 2-letter VTEC code (``"TO"``, case-insensitive)
    - A friendly slug (``"tornado"``, ``"severe_thunderstorm"``)

    Returns the 2-letter code, or ``None`` if not supplied.
    Raises ``ValueError`` for unrecognised inputs.
    """
    if value is None:
        return None
    upper = value.strip().upper()
    if upper in ALERT_PHEN_LABELS:
        return upper
    slug = value.strip().lower().replace(" ", "_")
    if slug in _LABEL_TO_PHEN:
        return _LABEL_TO_PHEN[slug]
    raise ValueError(
        f"Unknown phen {value!r}. "
        f"Use a 2-letter VTEC code (e.g. 'TO') or a slug (e.g. 'tornado')."
    )


# ── SQL templates ─────────────────────────────────────────────────────────────

_SELECT_COLS = """
    SELECT
        canonical_key,
        event_id,
        office,
        etn,
        phen,
        significance,
        action,
        start_utc,
        end_utc,
        counties,
        ST_AsGeoJSON(geom) AS geom_json
    FROM alerts
    WHERE
        significance = :sig
        AND start_utc  <= :at
        AND (end_utc IS NULL OR end_utc >= :at)
        AND geom        IS NOT NULL
"""

# Optionally filter by phen — appended when phen is supplied
_PHEN_CLAUSE  = "        AND phen = :phen\n"
_ORDER_CLAUSE = "    ORDER BY start_utc\n"
_BBOX_CLAUSE  = (
    "        AND ST_Intersects(\n"
    "            geom,\n"
    "            ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326)\n"
    "        )\n"
)


def _build_query(phen: Optional[str], bbox: Optional[tuple]) -> text:
    sql = _SELECT_COLS
    if phen:
        sql += _PHEN_CLAUSE
    if bbox:
        sql += _BBOX_CLAUSE
    sql += _ORDER_CLAUSE
    return text(sql)


# ── Public API ────────────────────────────────────────────────────────────────

async def query_alerts_geojson(
    sig:  str,
    at:   datetime,
    phen: Optional[str] = None,
    bbox: Optional[tuple[float, float, float, float]] = None,
    engine=None,
) -> dict:
    """Query the ``alerts`` hypertable and return a GeoJSON FeatureCollection.

    Parameters
    ----------
    sig:
        One-letter VTEC significance code: ``"W"`` (Warning), ``"A"`` (Watch),
        or ``"Y"`` (Advisory).
    at:
        Return only alerts whose ``start_utc <= at <= end_utc``.
    phen:
        Optional two-letter VTEC phenomenon code to further filter results
        (e.g. ``"TO"`` for tornado-only).  When ``None`` all phenomena for
        the given significance are returned.
    bbox:
        Optional ``(xmin, ymin, xmax, ymax)`` spatial filter in EPSG:4326.
    engine:
        Optional SQLAlchemy async engine; defaults to ``get_engine()``.

    Returns
    -------
    A GeoJSON ``FeatureCollection`` dict ready to pass to ``JSONResponse``.
    """
    if engine is None:
        engine = get_engine()

    params: dict = {"sig": sig, "at": at}
    if phen:
        params["phen"] = phen
    if bbox:
        xmin, ymin, xmax, ymax = bbox
        params.update({"xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax})

    sql = _build_query(phen, bbox)

    features = []
    async with engine.begin() as conn:
        result = await conn.execute(sql, params)
        for row in result.mappings():
            geom = json.loads(row["geom_json"])
            props = {
                "canonical_key": row["canonical_key"],
                "event_id":      row["event_id"],
                "office":        row["office"],
                "etn":           row["etn"],
                "phen":          row["phen"],
                "significance":  row["significance"],
                "action":        row["action"],
                "start_utc":     row["start_utc"].isoformat() if row["start_utc"] else None,
                "end_utc":       row["end_utc"].isoformat()   if row["end_utc"]   else None,
                "counties":      row["counties"],
            }
            features.append({
                "type":       "Feature",
                "geometry":   geom,
                "properties": props,
            })

    return {"type": "FeatureCollection", "features": features}
