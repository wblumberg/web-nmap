from datetime import datetime, timezone
import unittest

from api.services.dataset_status import _as_utc_datetime


class DatasetStatusTimeTests(unittest.TestCase):
    def test_accepts_source_timestamp_formats(self):
        cases = [
            ("2026072912", datetime(2026, 7, 29, 12, tzinfo=timezone.utc)),
            ("20260729_1230", datetime(2026, 7, 29, 12, 30, tzinfo=timezone.utc)),
            ("2026-07-29T12:00:00Z", datetime(2026, 7, 29, 12, tzinfo=timezone.utc)),
            (
            datetime(2026, 7, 29, 12),
            datetime(2026, 7, 29, 12, tzinfo=timezone.utc),
            ),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(_as_utc_datetime(value), expected)

    def test_rejects_unknown_strings(self):
        with self.assertRaisesRegex(ValueError, "unsupported datetime"):
            _as_utc_datetime("not-a-cycle", "cycle")
