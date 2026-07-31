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
    def test_major_carrier_filter_uses_icao_callsign_prefix(self):
        self.assertEqual(_carrier_code("SWA2422"), "SWA")
        self.assertIsNone(_carrier_code("N12345"))
        self.assertIn("SWA", _parse_carriers("major"))
        self.assertEqual(_parse_carriers("aal, dal"), frozenset({"AAL", "DAL"}))

    def test_core30_airport_filter_matches_either_endpoint(self):
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
        self.assertEqual(
            _parse_airports("atl, PHNL"), frozenset({"KATL", "PHNL"})
        )
        with self.assertRaisesRegex(ValueError, "Invalid airport codes"):
            _parse_airports("ATL,TOOLONG")

    def test_extracts_altitude_and_qualified_aircraft_fields(self):
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
                    "nxce:assignedAltitude": {"nxce:simpleAltitude": 371}
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
        # assignedAltitude is a clearance value, not a measured altitude.
        self.assertIsNone(row["altitude_ft"])
        self.assertEqual(row["ground_speed_kt"], 436)
        self.assertEqual(row["observation_time"].isoformat(), "2026-07-30T22:00:46+00:00")
        self.assertAlmostEqual(row["lat"], 36.4822222)
        self.assertAlmostEqual(row["lon"], -120.5291667)

    def test_uses_direct_reported_altitude_but_not_assigned_altitude(self):
        from api.ingest.faa_asdi_ingest import _reported_altitude_ft

        self.assertEqual(_reported_altitude_ft({
            "nxcm:reportedAltitude": {"nxce:simpleAltitude": 123}
        }), 12300)
        self.assertIsNone(_reported_altitude_ft({
            "nxcm:reportedAltitude": {
                "nxce:assignedAltitude": {"nxce:simpleAltitude": 371}
            }
        }))
