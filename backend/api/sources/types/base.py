"""
sources/base.py — Abstract DataSource

A DataSource knows how to answer two questions about one type of data:
  1. What valid times are available? (list_times)
  2. Given a valid time, where is the file? (get_path)

Every concrete source (filesystem scan, S3 listing, database query) inherits
from this base class and implements those two methods.

─── Why an abstract base class? ─────────────────────────────────────────────
Because every router (catalog, lightning, observations) needs to ask
"what times are available?" for any source, without knowing whether that
source lives on disk, in S3, or in a database. The routers talk to the
abstract interface; the concrete source handles the details.

This is called the "Strategy pattern" — you swap out the strategy (filesystem
vs S3 vs database) without changing the code that uses it.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass
class AvailableTime:
    """
    Represents one available valid time for a data source.

    Attributes:
        valid_time   : The actual datetime of the data (UTC)
        key          : The string key used in MultiPlotLayer (e.g. '20250302_1800')
        path         : Full path to the data file (or None for remote sources)
        cycle        : Model init time, if applicable (e.g. GFS 00Z run)
        fhr          : Forecast hour, if applicable
        size_bytes   : File size — useful for progress indicators
    """
    valid_time  : datetime
    key         : str
    path        : Path | None   = None
    cycle       : datetime | None = None
    fhr         : int | None    = None
    size_bytes  : int | None    = None

    def as_dict(self) -> dict:
        """Serialize to a JSON-safe dict for the API response."""
        return {
            "valid_time" : self.valid_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "key"        : self.key,
            "path"       : str(self.path) if self.path else None,
            "cycle"      : self.cycle.strftime("%Y%m%d%H") if self.cycle else None,
            "fhr"        : self.fhr,
            "size_bytes" : self.size_bytes,
        }


class DataSource(ABC):
    """
    Abstract base class for all WebNMAP data sources.

    Subclasses must implement list_times() and get_path().
    Everything else (time matching, age calculation, etc.) is built
    on top of these two primitives.
    """

    #: Which API endpoint family serves data for this source.
    #: Values: 'gridded' | 'point_obs' | 'geometry'
    #: Subclasses override this as a class attribute where needed.
    endpoint_type: str = 'gridded'

    @property
    @abstractmethod
    def source_id(self) -> str:
        """The string identifier used in VIEW_REGISTRY on the JS side."""
        ...

    @property
    @abstractmethod
    def label(self) -> str:
        """Human-readable name shown in the UI."""
        ...

    @abstractmethod
    async def list_times(
        self,
        after  : datetime | None = None,
        before : datetime | None = None,
        limit  : int             = 200,
    ) -> list[AvailableTime]:
        """
        Return available valid times, optionally filtered to a time window.

        Parameters:
            after  : Only return times after this datetime (inclusive)
            before : Only return times before this datetime (inclusive)
            limit  : Maximum number of times to return (most-recent first)

        Returns:
            List of AvailableTime objects, sorted newest → oldest.
        """
        ...

    @abstractmethod
    async def get_path(self, key: str) -> Path | None:
        """
        Return the filesystem path for the data file with the given key.
        Returns None if the key is not found.
        """
        ...

    async def most_recent(self) -> AvailableTime | None:
        """Convenience: return the single most recent available time."""
        times = await self.list_times(limit=1)
        return times[0] if times else None
