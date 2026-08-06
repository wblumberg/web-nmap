"""Parse API time keys and convert between cycles, hours, and datetimes."""

from datetime import datetime, timezone
from typing import Optional
# utils/__init__.py or utils/time_helpers.py

def _parse_key_to_dt(key: str) -> Optional[datetime]:
    """
    Parse a time key string into a datetime object.
    
    Supports:
        - ISO 8601: "2024-01-15T10:30:00Z", fractional seconds, or an offset
        - YYYYMMDD_HHMM: "20240115_1030"
    
    Returns None if parsing fails.
    """
    if not key:
        return None
    
    # datetime.fromisoformat accepts fractional seconds and UTC offsets. Python
    # 3.10 does not consistently accept the RFC 3339 "Z" suffix, so normalize
    # it to an explicit UTC offset first.
    try:
        iso_key = key[:-1] + "+00:00" if key.endswith(("Z", "z")) else key
        dt = datetime.fromisoformat(iso_key)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        pass
    
    # Try YYYYMMDD_HHMM format
    try:
        dt = datetime.strptime(key, "%Y%m%d_%H%M")
        dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        pass
    
    return None
