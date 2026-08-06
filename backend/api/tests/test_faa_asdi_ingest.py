"""Test FAA ASDI filtering and aircraft-position normalization."""

import unittest
from datetime import datetime, timezone

from api.ingest.faa_asdi_ingest import (
    CORE30_AIRPORTS,
    _carrier_code,
    _matches_airports,
    _parse_airports,
    _parse_carriers,
    extract_position,
)


class FaaPositionParsingTests(unittest.TestCase):
    """Test faa position parsing behavior."""
    def test_major_carrier_filter_uses_icao_callsign_prefix(self):
        """Verify the major-carrier filter uses ICAO callsign prefixes."""
        self.assertEqual(_carrier_code("SWA2422"), "SWA")
        self.assertIsNone(_carrier_code("N12345"))
        self.assertIn("SWA", _parse_carriers("major"))
        self.assertEqual(_parse_carriers("aal, dal"), frozenset({"AAL", "DAL"}))

    def test_core30_airport_filter_matches_either_endpoint(self):
        """Verify the Core 30 filter matches either flight endpoint."""
        airports = _parse_airports("core30")

        self.assertEqual(airports, CORE30_AIRPORTS)
        self.assertEqual(len(airports), 30)
        self.assertTrue(_matches_airports({
            "departure_airport": "KATL", "arrival_airport": "KOAK",
        }, airports))
        self.assertTrue(_matches_airports({
            "departure_airport": "PANC", "arrival_airport": "HNL",
        }, airports))
        self.assertFalse(_matches_airports({
            "departure_airport": "KPSP", "arrival_airport": "KOAK",
        }, airports))
        self.assertFalse(_matches_airports({
            "departure_airport": None, "arrival_airport": None,
        }, airports))

    def test_explicit_airport_filter_accepts_icao_and_iata_codes(self):
        """Verify explicit airport filters accept ICAO and IATA codes."""
        self.assertEqual(
            _parse_airports("atl, PHNL"), frozenset({"KATL", "PHNL"})
        )
        with self.assertRaisesRegex(ValueError, "Invalid airport codes"):
            _parse_airports("ATL,TOOLONG")

    def test_extracts_altitude_and_qualified_aircraft_fields(self):
        """Verify position parsing extracts altitude and qualified aircraft fields."""
        msg = {
            "msgType": "TRACK_INFORMATION",
            "flightRef": "flight-123",
            "fdm:trackInformation": {
                "nxcm:ncsmTrackData": {
                    "nxcm:nextEvent": {
                        "longitudeDecimal": -120.5938306,
                        "latitudeDecimal": 36.5355528,
                    }
                },
                "nxcm:position": {
                    "nxce:latitude": {
                        "nxce:latitudeDMS": {
                            "seconds": 56, "minutes": 28, "degrees": 36,
                            "direction": "NORTH",
                        }
                    },
                    "nxce:longitude": {
                        "nxce:longitudeDMS": {
                            "seconds": 45, "minutes": 31, "degrees": 120,
                            "direction": "WEST",
                        }
                    },
                },
                "nxcm:speed": 436,
                "nxcm:timeAtPosition": "2026-07-30T22:00:46Z",
                "nxcm:qualifiedAircraftId": {
                    "nxce:departurePoint": {"nxce:airport": "KPSP"},
                    "nxce:arrivalPoint": {"nxce:airport": "KOAK"},
                    "nxce:gufi": "KL681195YV",
                    "nxce:aircraftId": "SWA2422",
                },
                "nxcm:reportedAltitude": {
                    "nxce:assignedAltitude": {"nxce:simpleAltitude": "371C"}
                },
            },
        }
        row = extract_position(
            msg, datetime(2026, 7, 30, 22, 0, 47, tzinfo=timezone.utc)
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["flight_ref"], "flight-123")
        self.assertEqual(row["acid"], "SWA2422")
        self.assertEqual(row["departure_airport"], "KPSP")
        self.assertEqual(row["arrival_airport"], "KOAK")
        self.assertEqual(row["altitude_ft"], 37100)
        self.assertEqual(row["altitude_suffix"], "C")
        self.assertEqual(row["ground_speed_kt"], 436)
        self.assertEqual(row["observation_time"].isoformat(), "2026-07-30T22:00:46+00:00")
        self.assertAlmostEqual(row["lat"], 36.4822222)
        self.assertAlmostEqual(row["lon"], -120.5291667)

    def test_parses_direct_and_nested_reported_altitude(self):
        """Verify direct and nested reported-altitude values are parsed."""
        from api.ingest.faa_asdi_ingest import (
            _reported_altitude,
            _reported_altitude_ft,
        )

        self.assertEqual(_reported_altitude_ft({
            "nxcm:reportedAltitude": {"nxce:simpleAltitude": 123}
        }), 12300)
        self.assertEqual(_reported_altitude_ft({
            "nxcm:reportedAltitude": {
                "nxce:assignedAltitude": {"nxce:simpleAltitude": 371}
            }
        }), 37100)
        self.assertEqual(_reported_altitude({
            "nxcm:reportedAltitude": {
                "nxce:assignedAltitude": {"nxce:simpleAltitude": "360C"}
            }
        }), (36000, "C"))

    def test_preserves_bct_suffix_and_excludes_interim_altitude(self):
        """Verify B/C/T suffixes are preserved and interim altitudes excluded."""
        from api.ingest.faa_asdi_ingest import _reported_altitude

        self.assertEqual(_reported_altitude({
            "nxcm:reportedAltitude": {
                "nxce:assignedAltitude": {"nxce:simpleAltitude": "120B"}
            }
        }), (12000, "B"))
        self.assertEqual(_reported_altitude({
            "nxcm:reportedAltitude": {
                "nxce:assignedAltitude": {"nxce:simpleAltitude": "240T"}
            }
        }), (None, "T"))
        self.assertEqual(_reported_altitude({
            "nxcm:reportedAltitude": {
                "nxce:assignedAltitude": {"nxce:simpleAltitude": "VFR"}
            }
        }), (None, None))
