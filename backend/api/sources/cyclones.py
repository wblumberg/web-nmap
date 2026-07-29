from .types.db_source import CycloneTrackDBSource

# ATCF forecast tracks ingested into the `atcf_tracks` hypertable.
ATCF_TRACKS_DB = CycloneTrackDBSource(
    source_id_="ATCF_TRACKS",
    label_="ATCF Cyclone Tracks",
    source_type="MISC",
    data_category="cyclone_tracks",
    default_selected=-9999,
    timeline_hours=240,
)
