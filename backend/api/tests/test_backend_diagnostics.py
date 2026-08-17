"""Tests for the bounded application diagnostics recorder."""

import unittest

from api.services.backend_diagnostics import BackendDiagnostics


class BackendDiagnosticsTests(unittest.TestCase):
    """Verify request aggregation and incremental delivery."""

    def test_snapshot_contains_completed_request_and_aggregates(self):
        diagnostics = BackendDiagnostics()
        token = diagnostics.start()
        diagnostics.finish(
            token, method="GET", endpoint="/api/v1/zarr/{source_id}/{key}/{chunk_path:path}",
            status=200, source_id="GOES-E", variable_group="CMI",
            ttfb_ms=12.5, response_bytes=4096,
        )

        snapshot = diagnostics.snapshot()
        self.assertEqual(snapshot["totals"]["requests"], 1)
        self.assertEqual(snapshot["window"]["response_bytes"], 4096)
        self.assertEqual(snapshot["requests"][0]["source_id"], "GOES-E")
        self.assertEqual(snapshot["active_requests"], 0)
        self.assertTrue(snapshot["instance_id"])
        self.assertGreater(snapshot["started_at"], 0)

        sequence = snapshot["latest_sequence"]
        self.assertEqual(diagnostics.snapshot(sequence)["requests"], [])
        # Multi-process clients request a small recent tail and deduplicate by
        # instance ID + sequence rather than sharing one invalid global cursor.
        self.assertEqual(len(diagnostics.snapshot(sequence, recent_limit=1)["requests"]), 1)


if __name__ == "__main__":
    unittest.main()
