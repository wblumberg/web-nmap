import unittest

import numpy as np
import xarray as xr

from api.ingest.ascat_ingest import _platform, rows_from_dataset


class AscatNormalizationTests(unittest.TestCase):
    def test_normalizes_ascat_cells_and_drops_invalid_coordinates(self):
        ds = xr.Dataset(
            {
                "time": (
                    ("NUMROWS", "NUMCELLS"),
                    np.array([
                        ["2026-07-30T10:00:00", "2026-07-30T10:00:01"],
                    ], dtype="datetime64[s]"),
                ),
                "lat": (("NUMROWS", "NUMCELLS"), [[35.0, 999.0]]),
                "lon": (("NUMROWS", "NUMCELLS"), [[-70.0, -69.5]]),
                "wind_speed": (
                    ("NUMROWS", "NUMCELLS"),
                    [[10.0, 11.0]],
                    {"units": "m/s"},
                ),
                "wind_dir": (("NUMROWS", "NUMCELLS"), [[45.0, 90.0]]),
                "wvc_quality_flag": (("NUMROWS", "NUMCELLS"), [[0, 4]]),
            },
            attrs={"title_short_name": "ASCATC-L2-Coastal"},
        )

        rows = rows_from_dataset(ds, "ascat-c-test.nc")

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["source_id"], "ASCAT")
        self.assertEqual(rows[0]["properties"], (
            '{"platform":"ASCAT-C","swath_id":"63ae5287cc29f08feb5a50f9",'
            '"scan_row":0,"cell_index":0,"wind_speed_kt":19.438444924406,'
            '"wind_direction_deg":225.0,"qc_flag":0,'
            '"source_file":"ascat-c-test.nc"}'
        ))

    def test_rejects_non_ascat_product(self):
        ds = xr.Dataset(attrs={"title_short_name": "OSCAT-L2-25km"})
        with self.assertRaisesRegex(ValueError, "Unsupported scatterometer product"):
            _platform(ds)

    def test_accepts_ascat_b_25km_product(self):
        ds = xr.Dataset(attrs={"title_short_name": "ASCATB-L2-25km"})

        self.assertEqual(_platform(ds), "ASCAT-B")

    def test_accepts_future_ascat_c_l2_variant(self):
        ds = xr.Dataset(attrs={"title_short_name": "ASCATC-L2-50km"})

        self.assertEqual(_platform(ds), "ASCAT-C")


if __name__ == "__main__":
    unittest.main()
