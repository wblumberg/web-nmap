from datetime import datetime, timezone
# utils/__init__.py or utils/time_helpers.py

def _parse_key_to_dt(key: str) -> Optional[datetime]:
    """
    Parse a time key string into a datetime object.
    
    Supports:
        - ISO 8601: "2024-01-15T10:30:00Z" or "2024-01-15T10:30:00+00:00"
        - YYYYMMDD_HHMM: "20240115_1030"
    
    Returns None if parsing fails.
    """
    if not key:
        return None
    
    # Try ISO 8601 format first
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(key, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    
    # Try YYYYMMDD_HHMM format
    try:
        dt = datetime.strptime(key, "%Y%m%d_%H%M")
        dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        pass
    
    return None