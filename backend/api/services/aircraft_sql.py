"""Queries for rolling FAA ASDI aircraft tracks."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from ..db.engine import get_engine

# Common North American mainline/large low-cost and cargo operators. Callsigns
# in SWIM use the ICAO three-letter designator (for example SWA2422).
MAJOR_CARRIER_CODES = frozenset({
    "AAL", "ACA", "ASA", "DAL", "FDX", "FFT", "HAL",
    "JBU", "NKS", "SWA", "UAL", "UPS", "WJA",
})


async def query_aircraft_tracks_geojson(
    *,
    end: datetime,
    window_minutes: int = 30,
    airports: list[str] | None = None,
    carriers: list[str] | None = None,
    operation: str = "both",
    bbox: tuple[float, float, float, float] | None = None,
    max_positions: int = 250_000,
    max_implied_speed_kt: float = 750.0,
    max_gap_minutes: int = 10,
) -> dict:
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    start = end - timedelta(minutes=window_minutes)
    operation = operation.lower()
    if operation not in {"arrival", "departure", "both"}:
        raise ValueError("operation must be arrival, departure, or both")

    params: dict = {
        "start": start,
        "end": end,
        "max_positions": max_positions,
        "max_implied_speed_kt": max_implied_speed_kt,
        "max_gap_seconds": max_gap_minutes * 60,
    }
    filters = [
        "observation_time BETWEEN :start AND :end",
        "geom IS NOT NULL",
    ]
    if airports:
        params["airports"] = airports
        if operation == "arrival":
            filters.append("arrival_airport = ANY(:airports)")
        elif operation == "departure":
            filters.append("departure_airport = ANY(:airports)")
        else:
            filters.append(
                "(arrival_airport = ANY(:airports) "
                "OR departure_airport = ANY(:airports))"
            )
    if carriers:
        params["carriers"] = carriers
        filters.append("left(upper(acid), 3) = ANY(:carriers)")
    if bbox:
        xmin, ymin, xmax, ymax = bbox
        params.update(xmin=xmin, ymin=ymin, xmax=xmax, ymax=ymax)
        filters.append(
            "ST_Intersects(geom, "
            "ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))"
        )

    sql = text(f"""
        WITH selected AS (
          SELECT *
          FROM aircraft_positions
          WHERE {" AND ".join(filters)}
          ORDER BY observation_time DESC
          LIMIT :max_positions
        ),
        with_previous AS (
          SELECT
            selected.*,
            lag(observation_time) OVER flight_window AS previous_time,
            lag(geom) OVER flight_window AS previous_geom
          FROM selected
          WINDOW flight_window AS (
            PARTITION BY flight_ref ORDER BY observation_time
          )
        ),
        with_breaks AS (
          SELECT *,
            CASE
              WHEN previous_time IS NULL THEN 0
              WHEN EXTRACT(EPOCH FROM observation_time - previous_time) <= 0 THEN 1
              WHEN EXTRACT(EPOCH FROM observation_time - previous_time)
                     > :max_gap_seconds THEN 1
              WHEN (
                ST_DistanceSphere(previous_geom, geom)
                / EXTRACT(EPOCH FROM observation_time - previous_time)
                * 1.9438444924406
              ) > :max_implied_speed_kt THEN 1
              ELSE 0
            END AS starts_new_segment
          FROM with_previous
        ),
        segmented AS (
          SELECT *,
            sum(starts_new_segment) OVER (
              PARTITION BY flight_ref ORDER BY observation_time
            ) AS segment_id
          FROM with_breaks
        )
        SELECT
          flight_ref,
          (array_agg(acid ORDER BY observation_time DESC)
             FILTER (WHERE acid IS NOT NULL))[1] AS acid,
          (array_agg(departure_airport ORDER BY observation_time DESC)
             FILTER (WHERE departure_airport IS NOT NULL))[1] AS departure_airport,
          (array_agg(arrival_airport ORDER BY observation_time DESC)
             FILTER (WHERE arrival_airport IS NOT NULL))[1] AS arrival_airport,
          MIN(observation_time) AS start_time,
          MAX(observation_time) AS end_time,
          array_to_json(array_agg(altitude_ft ORDER BY observation_time))
            AS altitude_ft_array,
          array_to_json(array_agg(ground_speed_kt ORDER BY observation_time))
            AS ground_speed_kt_array,
          array_to_json(array_agg(observation_time ORDER BY observation_time))
            AS observation_time_array,
          ST_AsGeoJSON(ST_MakeLine(geom ORDER BY observation_time)) AS geom_json,
          COUNT(*) AS point_count
        FROM segmented
        GROUP BY flight_ref, segment_id
        HAVING COUNT(*) >= 2
        ORDER BY MAX(observation_time) DESC
    """)

    features = []
    engine = get_engine()
    async with engine.connect() as connection:
        result = await connection.execute(sql, params)
        for row in result.mappings():
            def as_array(value):
                return json.loads(value) if isinstance(value, str) else value

            features.append({
                "type": "Feature",
                "geometry": json.loads(row["geom_json"]),
                "properties": {
                    "flight_ref": row["flight_ref"],
                    "acid": row["acid"],
                    "departure_airport": row["departure_airport"],
                    "arrival_airport": row["arrival_airport"],
                    "start_time": row["start_time"].isoformat(),
                    "end_time": row["end_time"].isoformat(),
                    "altitude_ft_array": as_array(row["altitude_ft_array"]),
                    "ground_speed_kt_array": as_array(row["ground_speed_kt_array"]),
                    "observation_time_array": as_array(row["observation_time_array"]),
                    "point_count": int(row["point_count"]),
                    "is_latest_segment": False,
                },
            })

    latest_by_flight: dict[str, str] = {}
    for feature in features:
        properties = feature["properties"]
        flight_ref = properties["flight_ref"]
        latest_by_flight[flight_ref] = max(
            latest_by_flight.get(flight_ref, ""),
            properties["end_time"],
        )
    for feature in features:
        properties = feature["properties"]
        properties["is_latest_segment"] = (
            properties["end_time"] == latest_by_flight[properties["flight_ref"]]
        )

    return {
        "type": "FeatureCollection",
        "metadata": {
            "start_time": start.isoformat(),
            "end_time": end.isoformat(),
            "window_minutes": window_minutes,
            "airports": airports or [],
            "carriers": carriers or [],
            "operation": operation,
            "position_limit": max_positions,
            "max_implied_speed_kt": max_implied_speed_kt,
            "max_gap_minutes": max_gap_minutes,
        },
        "features": features,
    }
