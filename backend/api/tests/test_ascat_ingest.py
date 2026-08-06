"""Test ASCAT normalization, product detection, and quality filtering."""

import unittest

import numpy as np
import xarray as xr

from api.ingest.ascat_ingest import _platform, _quality_reject_mask, rows_from_dataset


class AscatNormalizationTests(unittest.TestCase):
    """Test ascat normalization behavior."""
    def test_normalizes_ascat_cells_and_drops_invalid_coordinates(self):
        """Verify ASCAT cells are normalized and invalid coordinates dropped."""
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
        """Verify non-ASCAT products are rejected."""
        ds = xr.Dataset(attrs={"title_short_name": "OSCAT-L2-25km"})
        with self.assertRaisesRegex(ValueError, "Unsupported scatterometer product"):
            _platform(ds)

    def test_accepts_ascat_b_25km_product(self):
        """Verify ASCAT-B 25 km products are accepted."""
        ds = xr.Dataset(attrs={"title_short_name": "ASCATB-L2-25km"})

        self.assertEqual(_platform(ds), "ASCAT-B")

    def test_accepts_future_ascat_c_l2_variant(self):
        """Verify future ASCAT-C Level 2 variants are accepted."""
        ds = xr.Dataset(attrs={"title_short_name": "ASCATC-L2-50km"})

        self.assertEqual(_platform(ds), "ASCAT-C")

    def test_rejects_land_and_invalid_cells_using_cf_flag_metadata(self):
        """Verify CF flags remove land and invalid wind cells."""
        ds = xr.Dataset(
            {
                "time": (("row", "cell"), np.full(
                    (1, 3), "2026-07-30T10:00:00", dtype="datetime64[s]"
                )),
                "lat": (("row", "cell"), [[35.0, 36.0, 37.0]]),
                "lon": (("row", "cell"), [[-70.0, -71.0, -72.0]]),
                "wind_speed": (
                    ("row", "cell"), [[10.0, 11.0, 12.0]], {"units": "m/s"}
                ),
                "wind_dir": (("row", "cell"), [[45.0, 90.0, 135.0]]),
                "wvc_quality_flag": (
                    ("row", "cell"),
                    [[0, 1, 4]],
                    {
                        "flag_masks": np.array([1, 2, 4], dtype=np.uint16),
                        "flag_meanings": "land rain_contamination invalid_wind",
                    },
                ),
            },
            attrs={"title_short_name": "ASCATC-L2-Coastal"},
        )

        self.assertEqual(_quality_reject_mask(ds["wvc_quality_flag"]), 5)
        rows = rows_from_dataset(ds, "ascat-c-quality.nc")

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["lat"], 35.0)

    def test_keeps_unknown_quality_layout_instead_of_guessing(self):
        """Verify unknown quality layouts are retained rather than guessed."""
        quality = xr.DataArray(
            [4],
            attrs={"flag_masks": [1, 4], "flag_meanings": "land"},
        )
        self.assertEqual(_quality_reject_mask(quality), 0)


if __name__ == "__main__":
    unittest.main()
