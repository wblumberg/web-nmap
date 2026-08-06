"""Test point-range serialization, timestamps, metadata, and cursors."""

import os
import unittest
from datetime import datetime, timezone

os.environ.setdefault(
    "TIMESCALE_CONN",
    "postgresql+asyncpg://webnmap:test@localhost:5432/wxdata",
)

from api.routers.points_db import (
    _decode_cursor,
    _encode_cursor,
    _rows_to_geojson,
    _rows_to_protobuf,
)
from api.utils.time_helper import _parse_key_to_dt
from wxdata_pb2 import PointResponse


class PointRangeEncodingTests(unittest.TestCase):
    """Test point range encoding behavior."""
    def setUp(self):
        """Prepare shared state for each test case."""
        self.start = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
        self.end = datetime(2026, 8, 1, 13, 0, tzinfo=timezone.utc)
        self.rows = [{
            "lat": 35.22,
            "lon": -97.44,
            "valid_time": self.start,
            "station_id": "KOUN",
            "_row_id": 42,
            "properties": {"tmpf": 72.0, "weather": "clear"},
        }]

    def test_protobuf_keeps_station_identity_and_policy_metadata(self):
        """Verify protobuf output preserves station identity and policy metadata."""
        payload = _rows_to_protobuf(
            self.rows,
            "SAO",
            self.start,
            self.end,
            {"raw_range": "true", "most_recent_by": "station_id"},
        )
        response = PointResponse.FromString(payload)

        self.assertEqual(response.count, 1)
        self.assertEqual(response.points[0].metadata["station_id"], "KOUN")
        self.assertEqual(response.points[0].variables["tmpf"], 72.0)
        self.assertEqual(response.metadata["raw_range"], "true")

    def test_geojson_keeps_station_identity(self):
        """Verify GeoJSON output preserves station identity."""
        response = _rows_to_geojson(
            self.rows, "SAO", self.start, self.end, {"raw_range": "true"}
        )
        self.assertEqual(response["features"][0]["properties"]["station_id"], "KOUN")

    def test_minute_resolution_protobuf_omits_iso_timestamp(self):
        """Verify minute-resolution protobuf output omits redundant ISO timestamps."""
        precise = self.start.replace(second=47, microsecond=812_000)
        rows = [{**self.rows[0], "valid_time": precise}]
        payload = _rows_to_protobuf(
            rows, "LIGHTNING", self.start, self.end,
            {"raw_range": "true"}, minute_resolution=True,
        )
        response = PointResponse.FromString(payload)

        self.assertEqual(response.points[0].valid_time, "")
        self.assertEqual(
            response.points[0].valid_time_minute,
            int(precise.timestamp() // 60),
        )

    def test_javascript_iso_range_timestamps_are_accepted(self):
        """Verify JavaScript-style ISO range timestamps are accepted."""
        self.assertEqual(
            _parse_key_to_dt("2026-08-01T18:20:00.000Z"),
            datetime(2026, 8, 1, 18, 20, tzinfo=timezone.utc),
        )
        self.assertEqual(
            _parse_key_to_dt("2026-08-01T18:20:00.125-05:00"),
            datetime.fromisoformat("2026-08-01T18:20:00.125-05:00"),
        )

    def test_point_range_cursor_round_trip(self):
        """Verify point-range cursors survive an encode/decode round trip."""
        cursor = _encode_cursor(self.rows[0])
        valid_time, row_id = _decode_cursor(cursor)

        self.assertEqual(valid_time, self.start)
        self.assertEqual(row_id, 42)


if __name__ == "__main__":
    unittest.main()
