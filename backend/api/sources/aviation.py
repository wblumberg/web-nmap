"""Declare and configure backend data sources for aviation."""

from .types.db_source import AircraftTrackDBSource

FAA_ASDI_DB = AircraftTrackDBSource()
