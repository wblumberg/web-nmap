import re
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

# Full phenomenon map (from your screenshot)
PHEN_MAP = {
    "AF": "ashfall",
    "AS": "air_stagnation",
    "BZ": "blizzard",
    "BW": "brisk_wind",
    "CB": "coastal_blizzard",
    "CF": "coastal_flood",
    "CW": "coastal_watch",
    "DS": "dust_storm",
    "DU": "blowing_dust",
    "EC": "extreme_cold",
    "EF": "extreme_fire",
    "EW": "extreme_wind",
    "EX": "excessive_heat",
    "FF": "flash_flood",
    "FG": "dense_fog",
    "FL": "flood",
    "FA": "flood",
    "FR": "frost",
    "FW": "fire_weather",
    "GL": "gale",
    "HF": "hurricane_force_wind",
    "HT": "heat",
    "HU": "hurricane",
    "HW": "high_wind",
    "HY": "hydrologic",
    "IS": "ice_storm",
    "LE": "lake_effect_snow",
    "LO": "low_water",
    "LS": "lakeshore_flood",
    "LW": "lake_wind",
    "MA": "marine",
    "MF": "marine_fog",
    "MH": "ashfall_marine",
    "MS": "dense_smoke_marine",
    "RB": "small_craft_rough_bar",
    "RP": "rip_current_risk",
    "SC": "small_craft",
    "SE": "hazardous_seas",
    "SI": "small_craft_winds",
    "SM": "dense_smoke",
    "SQ": "snow_squall",
    "SR": "storm",
    "SS": "storm_surge",
    "SU": "high_surf",
    "SV": "severe_thunderstorm",
    "SW": "small_craft_hazardous_seas",
    "TO": "tornado",
    "TR": "tropical_storm",
    "TS": "tsunami",
    "TY": "typhoon",
    "UP": "freezing_spray",
    "WI": "wind",
    "WS": "winter_storm",
    "WW": "winter_weather",
    "XH": "extreme_heat",
    "ZF": "freezing_fog",
    "ZR": "freezing_rain",
}

# Product class (k)
PRODUCT_CLASS_MAP = {
    "O": "operational",
    "T": "test",
    "E": "experimental",
    "X": "experimental_vtec_in_operational",
}

# Action (aaa) mapping (common VTEC action codes)
ACTION_MAP = {
    "NEW": "new_event",
    "CON": "event_continued",
    "EXT": "event_extended_time",
    "EXA": "event_extended_area",
    "EXB": "event_extended_time_and_area",
    "UPG": "event_upgraded",
    "CAN": "event_cancelled",
    "EXP": "event_expired",
    "COR": "correction",
    "ROU": "routine",
    # occasionally you'll see other/variant strings; keep raw action also
}

# Significance (s)
SIGNIFICANCE_MAP = {
    "W": "warning",
    "A": "watch",
    "Y": "advisory",
    "S": "statement",
    "F": "forecast",
    "O": "outlook",
    "N": "synopsis",
}

_PVTEC_RE = re.compile(r"^/?(?P<body>.+)/?$")
# find a timestamp like 260404T0300Z (yy mm dd T hh mm Z)
_TIME_TOKEN_RE = re.compile(r"(?P<ts>\d{6}T\d{4}Z)")

def _extract_and_parse_vtec_datetime(tok: str) -> Optional[datetime]:
    """
    Robustly extract a yymmddThhnnZ timestamp substring from tok and parse to UTC datetime.
    Returns None if the token is the all-zero sentinel or no timestamp found.
    """
    if not tok:
        return None
    # Extract the first timestamp-like substring
    m = _TIME_TOKEN_RE.search(tok.strip())
    if not m:
        return None
    ts = m.group("ts")
    if ts == "000000T0000Z":
        return None
    try:
        dt = datetime.strptime(ts, "%y%m%dT%H%MZ")
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None

def parse_pvtec_string(vtec: str) -> Optional[Dict[str, Any]]:
    """
    Parse a single P-VTEC string into structured fields (robust time parsing).
    Returns a dict or None on unparseable input.
    """
    if not vtec:
        return None
    m = _PVTEC_RE.match(vtec.strip())
    if not m:
        return None
    body = m.group("body")
    parts = body.split(".")
    if len(parts) < 7:
        return None

    prod_class = parts[0]     # k
    action = parts[1]         # aaa
    office = parts[2]         # cccc
    phen = parts[3]           # pp
    sig = parts[4]            # s
    etn_raw = parts[5]        # ####
    remainder = ".".join(parts[6:])
    # split on first '-' to separate start and end tokens
    if "-" in remainder:
        start_tok, end_tok = remainder.split("-", 1)
    else:
        start_tok, end_tok = remainder, ""

    # robustly extract timestamps from tokens
    start = _extract_and_parse_vtec_datetime(start_tok)
    end = _extract_and_parse_vtec_datetime(end_tok)

    # normalize ETN
    etn_padded = None
    etn_numeric = None
    try:
        if etn_raw is not None:
            i = int(etn_raw)
            etn_padded = f"{i:04d}"
            etn_numeric = str(i)
    except Exception:
        etn_padded = etn_raw

    product_class_label = PRODUCT_CLASS_MAP.get(prod_class)
    action_label = ACTION_MAP.get(action)
    significance_label = SIGNIFICANCE_MAP.get(sig)
    phen_name = PHEN_MAP.get(phen)

    canonical_key = None
    if office and etn_padded and phen:
        canonical_key = f"{office}-{etn_padded}-{phen}"

    return {
        "raw": vtec,
        "product_class": prod_class,
        "product_class_label": product_class_label,
        "action": action,
        "action_label": action_label,
        "office": office,
        "phen": phen,
        "phen_name": phen_name,
        "significance": sig,
        "significance_label": significance_label,
        "etn_raw": etn_raw,
        "etn_padded": etn_padded,
        "etn_numeric": etn_numeric,
        "start_utc": start,
        "end_utc": end,
        "canonical_key": canonical_key,
    }

def parse_vtec_list(vtecs: List[str]) -> List[Dict[str, Any]]:
    results = []
    for v in vtecs:
        parsed = parse_pvtec_string(v)
        if parsed:
            results.append(parsed)
    return results

if __name__ == "__main__":
    print("Testing parse_pvtec_string with sample VTEC strings:")
    samples = [
        "/O.CON.KICT.SV.A.0093.000000T0000Z-260404T0300Z/",
        "/O.CON.KILX.TO.A.0094.000000T0000Z-260404T0300Z/",
        "/O.NEW.KSGF.SV.A.0093.260403T1939Z-260404T0300Z/",
        "/O.NEW.KTSA.SV.A.0093.260403T1937Z-260404T0300Z/",
        "/O.NEW.KOUN.SV.A.0093.260403T1937Z-260404T0300Z/",
        "/O.NEW.KLOT.FA.A.0002.260404T0000Z-260404T1500Z/"
    ]

    for s in samples:
        parsed = parse_pvtec_string(s)
        print(s)
        print(parsed)
        print()