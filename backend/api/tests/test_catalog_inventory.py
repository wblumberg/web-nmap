"""Test catalog inventory caching and concurrent request coalescing."""

import asyncio
import unittest

from api.services import catalog_inventory


class _FakeSource:
    """Provide a test double for source."""
    source_id = "CACHE_TEST"

    def __init__(self):
        """Initialize the instance."""
        self.calls = 0

    async def list_times(self, **kwargs):
        """Return the available dataset times for this source."""
        self.calls += 1
        await asyncio.sleep(0.01)
        return [kwargs["limit"]]


class CatalogInventoryCacheTests(unittest.IsolatedAsyncioTestCase):
    """Test catalog inventory cache behavior."""
    async def asyncSetUp(self):
        """Prepare asynchronous shared state for each test case."""
        await catalog_inventory.clear_catalog_inventory_cache()
        catalog_inventory._inflight.clear()

    async def test_reuses_identical_inventory(self):
        """Verify identical inventory requests reuse cached results."""
        source = _FakeSource()
        first = await catalog_inventory.list_times_cached(source, limit=20)
        second = await catalog_inventory.list_times_cached(source, limit=20)

        self.assertEqual(first, [20])
        self.assertEqual(second, [20])
        self.assertEqual(source.calls, 1)

    async def test_coalesces_concurrent_inventory_requests(self):
        """Verify concurrent inventory requests are coalesced."""
        source = _FakeSource()
        results = await asyncio.gather(
            *(catalog_inventory.list_times_cached(source, limit=50) for _ in range(5))
        )

        self.assertEqual(results, [[50]] * 5)
        self.assertEqual(source.calls, 1)

    async def test_parameters_have_distinct_cache_entries(self):
        """Verify distinct request parameters receive distinct cache entries."""
        source = _FakeSource()
        await catalog_inventory.list_times_cached(source, limit=10)
        await catalog_inventory.list_times_cached(source, limit=20)

        self.assertEqual(source.calls, 2)
