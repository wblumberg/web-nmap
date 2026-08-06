"""Translate human-readable date/time patterns into regular expressions."""

# Human-readable to regex mapping for date/time expressions
# Example: 'YYYY' -> r'(?P<year>\\d{4})', 'mm' or 'MM' -> r'(?P<month>\\d{2})', etc.

HUMAN_TO_REGEX = {
    'YYYY': r'(?P<year>\\d{4})',
    'YY':   r'(?P<year>\\d{2})',
    'MM':   r'(?P<month>\\d{2})',
    # lowercase 'mm' is minutes (used in time HHmm), not month
    'mm':   r'(?P<minute>\\d{2})',
    'DD':   r'(?P<day>\\d{2})',
    'HH':   r'(?P<hour>\\d{2})',
    'SS':   r'(?P<second>\\d{2})',
    'CYYYY': r'(?P<cyear>\\d{4})',
    'CMM':   r'(?P<cmonth>\\d{2})',
    'CDD':   r'(?P<cday>\\d{2})',
    'CHH':   r'(?P<chour>\\d{2})',
    'FHR':   r'(?P<fhr>\\d{2,3})',
}

def human_pattern_to_regex(pattern: str) -> str:
    """
    Convert a human-readable pattern to a regex string using the mapping above.
    Example: 'YYYYMMDD_HHmm' -> r'(?P<year>\\d{4})(?P<month>\\d{2})(?P<day>\\d{2})_(?P<hour>\\d{2})(?P<minute>\\d{2})'
    """
    # Replace longer keys first to avoid partial overlaps (e.g. CYYYY before YYYY)
    # Use regex-based replacement that avoids matching tokens inside alphabetic words
    import re
    regex = pattern
    for key in sorted(HUMAN_TO_REGEX.keys(), key=len, reverse=True):
        # For lowercase-starting tokens (e.g. 'mm'), guard against accidental
        # matches inside ordinary words like 'summary'.  Uppercase tokens
        # (e.g. 'FHR', 'YYYY') are safe without the lookbehind — and need it
        # removed so they match after a literal lowercase prefix (e.g. 'fFHR').
        if key[0].islower():
            token_re = re.compile(rf"(?<![a-z]){re.escape(key)}(?![a-z])")
        else:
            token_re = re.compile(rf"{re.escape(key)}(?![a-z])")
        regex = token_re.sub(HUMAN_TO_REGEX[key], regex)
    return regex
