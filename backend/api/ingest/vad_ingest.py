import argparse
from datetime import datetime, timezone
import asyncio
import json
import numpy as np
import re
import pandas as pd
import xarray as xr
import os
import glob
import calendar
from collections import defaultdict
from metpy.io import Level3File

from backend.api.ingest.vad_profiles_db_ingest import ProfileRow, _ingest_rows


def parse_vad_output(file_content):
    lines = file_content.strip().split('\n')
    headers = re.split(r'\s{2,}', lines[1].strip())
    units = re.split(r'\s{2,}', lines[2].strip())
    data = []
    for line in lines[3:]:
        if line.strip() == '':
            break
        values = re.split(r'\s{2,}', line.strip())
        data.append(values)
    try:
        df = pd.DataFrame(data, columns=headers)
    except:
        return None
    numeric_columns = ['ALT', 'U', 'V', 'W', 'DIR', 'SPD', 'RMS', 'DIV', 'SRNG', 'ELEV']
    for col in numeric_columns:
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df['ALT'] = ((df['ALT'] * 100.) * 304.8)/1000.
    df = df.rename(columns={'ALT': 'ALT_KM_MSL', 'U': "U_MS", "V":"V_MS", "W": "W_CMS",
                       "SPD": "SPD_KTS", "RMS":"RMS_KTS", "DIV": "DIV_E-3/s"})
    return df

def _normalize_prod_time(raw_time):
    if raw_time is None:
        return None
    if isinstance(raw_time, datetime):
        return raw_time if raw_time.tzinfo else raw_time.replace(tzinfo=timezone.utc)
    return None


def _time_from_filename(filepath, now=None):
    """Return the UTC time encoded by a ``SITE_DDHHMM`` VAD filename.

    The filename does not include a month or year.  Choose the nearest valid
    date among the previous, current, and next UTC months so month/year
    boundaries are handled without relying on file modification times.
    """
    match = re.match(r"^[^_]+_(\d{2})(\d{2})(\d{2})$", os.path.basename(filepath))
    if match is None:
        return None

    day, hour, minute = (int(value) for value in match.groups())
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)

    candidates = []
    for month_offset in (-1, 0, 1):
        month_index = now.year * 12 + now.month - 1 + month_offset
        year, zero_based_month = divmod(month_index, 12)
        month = zero_based_month + 1
        if day > calendar.monthrange(year, month)[1]:
            continue
        try:
            candidates.append(
                datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
            )
        except ValueError:
            return None

    return min(candidates, key=lambda candidate: abs(candidate - now), default=None)


def _recent_files(vad_files, lookback_minutes=5, files_per_station=2, now=None):
    """Choose recent files for each site, newest first.

    Files older than ``lookback_minutes`` or dated in the future are ignored,
    then each station is limited to ``files_per_station`` files.
    """
    if lookback_minutes < 0:
        raise ValueError("lookback_minutes must be zero or greater")
    if files_per_station < 1:
        raise ValueError("files_per_station must be at least one")

    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)
    # Filenames have minute precision, so compare them to the current minute
    # rather than accidentally excluding the boundary due to seconds.
    comparison_time = now.replace(second=0, microsecond=0)

    by_site = defaultdict(list)
    for filepath in vad_files:
        basename = os.path.basename(filepath)
        match = re.match(r"^([^_]+)_\d{6}$", basename)
        file_time = _time_from_filename(filepath, now=now)
        if match is None or file_time is None:
            continue
        age_minutes = (comparison_time - file_time).total_seconds() / 60.0
        if age_minutes < 0 or age_minutes > lookback_minutes:
            continue

        site_id = match.group(1)
        by_site[site_id].append((file_time, filepath))

    selected = []
    for site_id in sorted(by_site):
        site_files = sorted(by_site[site_id], reverse=True)
        selected.extend(filepath for _, filepath in site_files[:files_per_station])
    return selected


def get_vad_groups(vad_dir='/data/base/vads', lookback_minutes=5, files_per_station=2):
    """Read recent Level3 VAD files per site and group by product time.

    Returns:
        list[tuple[dict, datetime]]: sequence of (site_dict, prod_time)
    """
    print(f"Reading Level3 VAD files from {vad_dir}...")
    groups = defaultdict(dict)

    all_vad_files = glob.glob(os.path.join(vad_dir, '*'))
    vad_files = _recent_files(
        all_vad_files,
        lookback_minutes=lookback_minutes,
        files_per_station=files_per_station,
    )
    print(
        f"Selected {len(vad_files)} file(s) from the last "
        f"{lookback_minutes} minute(s), limited to {files_per_station} "
        f"per station, from {len(all_vad_files)} candidate(s)."
    )

    for filepath in vad_files:
        try:
            f = Level3File(filepath)

            if f.product_name != 'VAD Wind Profile':
                continue
            if not f.tab_pages or not f.tab_pages[0]:
                continue

            vad_output = parse_vad_output(f.tab_pages[0])
            if vad_output is None:
                continue

            prod_time = _normalize_prod_time(f.metadata.get('prod_time') if f.metadata else None)
            if prod_time is None:
                prod_time = datetime.now(timezone.utc)

            # Deduplicate within one product time: one row per station/time.
            groups[prod_time][f.siteID] = {
                'latitude': f.lat,
                'longitude': f.lon,
                'altitude': f.height,
                'data': vad_output,
            }

            print(f"Successfully read {f.siteID} @ {prod_time.isoformat()} from {os.path.basename(filepath)}")
        except Exception as e:
            print(f"Skipping {filepath}: {e}")
            continue

    out = []
    for prod_time in sorted(groups.keys()):
        out.append((groups[prod_time], prod_time))
    return out

def _build_dataset(vad_data, date):
    variable_mapping = {
        'ALT_KM_MSL': ('altitude', 'km'),
        'U_MS': ('u_wind', 'm/s'),
        'V_MS': ('v_wind', 'm/s'),
        'W_CMS': ('w_wind', 'cm/s'),
        'DIR': ('wind_direction', 'degrees'),
        'SPD_KTS': ('wind_speed', 'knots'),
        'RMS_KTS': ('rms_speed', 'knots'),
        'DIV_E-3/s': ('divergence', '1e-3/s'),
        'SRNG': ('s_range', 'km'),
        'ELEV': ('elevation_angle', 'degrees')
    }
    site_ids = []
    latitudes = []
    longitudes = []
    altitudes = []
    profiles = []
    for site_id, site_data in vad_data.items():
        site_ids.append(site_id)
        latitudes.append(site_data['latitude'])
        longitudes.append(site_data['longitude'])
        altitudes.append(site_data['altitude'])
        profiles.append(site_data['data'])
    if not profiles:
        return None
    max_levels = max(profile.shape[0] for profile in profiles)
    padded_profiles = []
    for profile in profiles:
        padded_profile = profile.reindex(range(max_levels)).fillna(np.nan)
        padded_profiles.append(padded_profile)
    data_vars = {}
    for column in padded_profiles[0].columns:
        new_name, unit = variable_mapping[column]
        data_vars[new_name] = xr.DataArray(
            np.array([profile[column].values for profile in padded_profiles]),
            dims=('site', 'vertical_level'),
            attrs={'units': unit}
        )
    ds = xr.Dataset(
        data_vars,
        coords={
            'site': site_ids,
            'latitude': ('site', latitudes),
            'longitude': ('site', longitudes),
            'elevation': ('site', altitudes),
            'vertical_level': range(max_levels)
        }
    )
    ds.attrs['Summary'] = "File contains all the NEXRAD VAD VWP data for a specific time."
    ds.attrs['time_matching'] = date.strftime("%Y-%m-%d %H:%M:%S UTC")
    ds.attrs['source'] = "Nexrad Level 3 data from the National Weather Service"
    ds.attrs['institution'] = "National Weather Service"
    ds.attrs['Conventions'] = "CF-1.8"
    ds.attrs['date_created'] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
    ds.attrs['references'] = "https://www.ncdc.noaa.gov/data-access/radar-data/nexrad-products"
    ds.attrs['datastream'] = 'Unidata THREDDS Server'
    ds.attrs['contact'] = 'greg.blumberg@millersville.edu'
    return ds


def _dataset_to_profile_rows(ds, source_id):
    rows = []
    valid_time = datetime.now(timezone.utc)
    if 'time_matching' in ds.attrs:
        try:
            valid_time = datetime.strptime(
                str(ds.attrs['time_matching']).replace(" UTC", ""),
                "%Y-%m-%d %H:%M:%S",
            ).replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    site_ids = ds['site'].values.tolist() if 'site' in ds.coords else []
    if not site_ids:
        return rows

    lat_vals = ds['latitude'].values if 'latitude' in ds.coords else None
    lon_vals = ds['longitude'].values if 'longitude' in ds.coords else None
    elev_vals = ds['elevation'].values if 'elevation' in ds.coords else None
    vertical_levels = ds['vertical_level'].values.tolist() if 'vertical_level' in ds.coords else []
    data_var_names = list(ds.data_vars.keys())

    attrs = {}
    for key, value in ds.attrs.items():
        if isinstance(value, (str, int, float, bool)):
            attrs[key] = value
        else:
            attrs[key] = str(value)

    for idx, site in enumerate(site_ids):
        lat = float(lat_vals[idx]) if lat_vals is not None else None
        lon = float(lon_vals[idx]) if lon_vals is not None else None
        if lat is None or lon is None:
            continue

        profile = {
            'vertical_level': vertical_levels,
            'variables': {},
        }

        for var_name in data_var_names:
            var = ds[var_name]
            if var.ndim != 2:
                continue
            vals = var.isel(site=idx).values.tolist()
            out_vals = []
            for v in vals:
                try:
                    fv = float(v)
                    if np.isnan(fv):
                        out_vals.append(None)
                    else:
                        out_vals.append(fv)
                except Exception:
                    out_vals.append(None)

            profile['variables'][var_name] = {
                'units': var.attrs.get('units'),
                'values': out_vals,
            }

        metadata = {
            'dataset_attrs': attrs,
            'station_elevation_m': float(elev_vals[idx]) if elev_vals is not None else None,
            'ingest_mode': 'direct',
        }

        rows.append(
            ProfileRow(
                source_id=source_id,
                station_id=str(site),
                valid_time=valid_time,
                lat=lat,
                lon=lon,
                profile_json=json.dumps(profile),
                metadata_json=json.dumps(metadata),
            )
        )

    return rows


def main(
    vad_dir='/data/base/vads',
    source_id='VAD_PROFILE',
    dry_run=False,
    write_netcdf=False,
    output_dir=None,
    lookback_minutes=5,
    files_per_station=2,
):
    vad_groups = get_vad_groups(
        vad_dir,
        lookback_minutes=lookback_minutes,
        files_per_station=files_per_station,
    )

    if not vad_groups:
        print('No VAD profiles found.')
        return

    all_rows = []
    for vad_data, prod_time in vad_groups:
        ds = _build_dataset(vad_data, prod_time)
        if ds is None:
            continue
        all_rows.extend(_dataset_to_profile_rows(ds, source_id))

        if write_netcdf:
            if output_dir is None:
                raise ValueError("--output-dir is required when --write-netcdf is set")
            fname = os.path.join(output_dir, "NEXRAD.VWP.summary." + prod_time.strftime("%Y%m%d.%H%M%S") + ".nc")
            ds.to_netcdf(fname, format='NETCDF4')
            print(f"NetCDF file written to: {fname}")

    if not all_rows:
        print('No VAD profiles parsed.')
        return

    inserted = asyncio.run(_ingest_rows(all_rows, dry_run=dry_run))
    if dry_run:
        print(f"[dry-run] Would insert {inserted} profile row(s).")
    else:
        print(f"Inserted {inserted} profile row(s).")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch NEXRAD VAD data from local LDM files and ingest directly to profiles table.")
    parser.add_argument('--vad-dir', type=str, default='/data/base/vads', help='Directory containing Level3 VAD files')
    parser.add_argument('--source-id', type=str, default='VAD_PROFILE', help='profiles.source_id value')
    parser.add_argument('--dry-run', action='store_true', help='Parse and stage rows without DB writes')
    parser.add_argument('--write-netcdf', action='store_true', help='Also persist summary NetCDF output')
    parser.add_argument('--output-dir', type=str, default=None, help='Directory to save NetCDF when --write-netcdf')
    parser.add_argument(
        '--lookback-minutes',
        type=int,
        default=5,
        help='Only read files timestamped within this many minutes (default: 5)',
    )
    parser.add_argument(
        '--files-per-station',
        type=int,
        default=2,
        help='Maximum recent files to read for each station (default: 2)',
    )
    args = parser.parse_args()
    main(
        vad_dir=args.vad_dir,
        source_id=args.source_id,
        dry_run=args.dry_run,
        write_netcdf=args.write_netcdf,
        output_dir=args.output_dir,
        lookback_minutes=args.lookback_minutes,
        files_per_station=args.files_per_station,
    )
