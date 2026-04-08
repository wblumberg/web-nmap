"""
readers/acad_ltng_reader.py — Academic Lightning Data Reader

Reads tab-separated lightning strike data files, where each file contains
all strikes for a single minute. Columns and units are defined below.
"""

import pandas as pd
from pathlib import Path
from datetime import datetime, timezone

from .base import Reader, PointResult

COLUMNS = [
    'year', 'month', 'day', 'hour', 'minute', 'second', 'nanosecond',
    'lat', 'lon', 'peak_current', 'multiplicity', 'num_sensors', 'dof',
    'error_ellipse_angle', 'error_ellipse_semi_major_axis', 'error_ellipse_semi_minor_axis',
    'chi_squared', 'rise_time', 'peak_to_zero_time', 'max_rate_of_rise',
    'cloud_indicator', 'angle_indicator', 'signal_indicator', 'timing_indicator'
]

UNITS = [
    '', '', '', '', '', '', '',
    'degN', 'degE', 'kiloAmps', '', '', '',
    'deg', 'km', 'km', '', 'microseconds', 'microseconds', 'kA/microseconds',
    '', '', '', ''
]

class AcadLtngReader(Reader):
    format_name = "acad_ltng"

    def can_read(self, path: Path) -> bool:
        # Accept .txt, .tsv, .ltg, or .ltng files
        return path.suffix in (".txt", ".tsv", ".ltg", ".ltng")

    async def read_points(
        self,
        path    : Path,
        var_map : dict[str, str],
        bbox    : tuple | None = None,
    ) -> PointResult:
        """
        Read lightning strike points from a tab-separated file.
        Each row is a lightning strike.
        """
        df = pd.read_csv(path, sep="\t", names=COLUMNS, header=None)

        points = []
        for _, row in df.iterrows():
            lat = float(row['lat'])
            lon = float(row['lon'])

            if bbox is not None:
                lo_min, la_min, lo_max, la_max = bbox
                if not (lo_min <= lon <= lo_max and la_min <= lat <= la_max):
                    continue

            # Map output fields: always include all source columns (except coords)
            pt = {'lat': lat, 'lon': lon}
            # Include raw columns as properties when var_map isn't provided
            for col in COLUMNS:
                if col in ('lat', 'lon'):
                    continue
                # skip missing values
                try:
                    val = row[col]
                except Exception:
                    continue
                # pandas may use NaN for missing; skip those
                if pd.isna(val):
                    continue
                pt[col] = val
            # Apply var_map overrides (if provided) to map into generic names
            for generic, col in var_map.items():
                if col in row and not pd.isna(row[col]):
                    pt[generic] = row[col]
            points.append(pt)

        # Try to infer valid_time from the first row
        if not df.empty:
            first = df.iloc[0]
            try:
                valid_time = datetime(
                    int(first['year']), int(first['month']), int(first['day']),
                    int(first['hour']), int(first['minute']), int(first['second']),
                    tzinfo=timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
            except Exception:
                valid_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            valid_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        return PointResult(
            source_type = "acad_ltng",
            valid_time  = valid_time,
            points      = points,
            metadata    = {
                "columns": COLUMNS,
                "units": UNITS,
            },
        )