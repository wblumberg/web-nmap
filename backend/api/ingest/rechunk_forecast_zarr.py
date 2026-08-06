#!/usr/bin/env python3
"""
rechunk_forecast_zarr.py — Rechunk forecast zarr stores for efficient HTTP serving

Rewrites all time-indexed arrays in a zarr store to chunk_shape = (1, nj, ni)
so that each forecast hour occupies exactly one on-disk chunk file per variable.
This enables the zarr_proxy fast path: the proxy can serve raw compressed chunk
bytes verbatim without any decompression.

── Why (1, nj, ni)? ────────────────────────────────────────────────────────────

The zarr_proxy fhr-slice endpoint maps a JS request for virtual 2-D chunk
"0.0" to the on-disk 3-D key "{t_idx}.0.0".  With chunk_t=1, that file
exists directly on disk and can be returned with a single read(), with no
decompression, quantization, or re-encoding.  With chunk_t>1 the proxy must
decompress the covering multi-step chunk, extract the slice, and re-compress.

── What this script does ────────────────────────────────────────────────────────

For each .zarr store found under the target directories:

  1. Identifies arrays that have a time dimension (shape[t_axis] > 1).
  2. Skips arrays already chunked with chunk_t == 1 (already fast-path ready).
  3. Rechunks to (1, nj, ni), preserving dtype, codec, and fill_value.
  4. Writes to a sibling temp store, then atomically renames it over the original.
  5. Non-time arrays (coordinates, scalars) are copied verbatim.

── Usage ────────────────────────────────────────────────────────────────────────

  # Dry run — print what would be rechunked, touch nothing:
  python rechunk_forecast_zarr.py --dry-run

  # Rechunk everything in the default directories:
  python rechunk_forecast_zarr.py

  # Rechunk only HREF and ECMWF ENS stores:
  python rechunk_forecast_zarr.py \\
      --dirs /data/store/grid/href /data/store/grid/ecens

  # Process only stores whose names match a glob:
  python rechunk_forecast_zarr.py --glob "2026050700.*"

  # Limit parallelism (default: number of CPU cores):
  python rechunk_forecast_zarr.py --workers 4

  # Overwrite even stores that already appear fully rechunked:
  python rechunk_forecast_zarr.py --force

Run from the conda environment:
  conda run -n nmap_api python backend/api/ingest/rechunk_forecast_zarr.py

── Notes ────────────────────────────────────────────────────────────────────────

  • The script works on both zarr v2 (.zgroup / .zarray) and zarr v3 (zarr.json)
    stores. Output is always written in the same format as the input.
  • Temporary stores are written alongside the originals as <name>.rechunk_tmp.
    If interrupted, the partial temp store is left behind and cleaned up on the
    next run.
  • Coordinate arrays (1-D: time, x, y, lat, lon) and scalar arrays are copied
    without rechunking.
"""

import argparse
import fnmatch
import os
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

# ── Default directories (mirrors nwp_forecasts.py source registry) ────────────
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store"))

DEFAULT_DIRS = [
    DATA_ROOT / "grid/ecens",
    DATA_ROOT / "grid/ecmwf_hr",
    DATA_ROOT / "grid/gefs",
    DATA_ROOT / "grid/href",
    DATA_ROOT / "grid/hrrr",
    DATA_ROOT / "grid/hiresw_conusarw",
    DATA_ROOT / "grid/hiresw_conusfv3",
    DATA_ROOT / "grid/mpasrn_nssl",
    DATA_ROOT / "grid/namnest",
    DATA_ROOT / "grid/refs",
    DATA_ROOT / "grid/rrfs",
    DATA_ROOT / "grid/wrf4nssl",
]


# ─────────────────────────────────────────────────────────────────────────────
# Core rechunking logic
# ─────────────────────────────────────────────────────────────────────────────

def _time_axis(arr) -> int | None:
    """Return the index of the time dimension, or None if there is none."""
    try:
        dims = list(dict(arr.attrs).get("_ARRAY_DIMENSIONS", []))
    except Exception:
        dims = []
    if "time" in dims:
        return dims.index("time")
    # Heuristic: treat first axis of a 3-D array as time.
    if arr.ndim >= 3:
        return 0
    return None


# Common CF/GRIB names for the ensemble member dimension.
_MEMBER_DIM_NAMES = ("member", "ensemble_member", "number", "realization", "perturbationNumber")


def _member_axis(arr) -> int | None:
    """Return the index of the ensemble member dimension, or None if there is none."""
    try:
        dims = list(dict(arr.attrs).get("_ARRAY_DIMENSIONS", []))
    except Exception:
        dims = []
    for name in _MEMBER_DIM_NAMES:
        if name in dims:
            return dims.index(name)
    return None


def _already_rechunked(arr, t_axis: int, m_axis: int | None) -> bool:
    """Return True if chunk_t (and chunk_member when present) are already 1
    AND the spatial chunk covers the full 2-D frame."""
    # A single-member array will be squeezed to 3-D during rechunking; it is
    # never considered "already done" in its current 4-D form.
    if m_axis is not None and arr.shape[m_axis] == 1:
        return False
    chunks = arr.chunks
    if chunks[t_axis] != 1:
        return False
    if m_axis is not None and chunks[m_axis] != 1:
        return False
    non_spatial = {t_axis} | ({m_axis} if m_axis is not None else set())
    spatial_shape  = [arr.shape[i]  for i in range(arr.ndim) if i not in non_spatial]
    spatial_chunks = [chunks[i]     for i in range(arr.ndim) if i not in non_spatial]
    return all(sc >= ss for sc, ss in zip(spatial_chunks, spatial_shape))


def _target_chunks(arr, t_axis: int, m_axis: int | None) -> tuple[int, ...]:
    """Return the desired chunk shape.

    For arrays without a member dimension: (1, nj, ni).
    For arrays with member_size == 1:      (1, nj, ni)  — member axis squeezed out.
    For arrays with member_size > 1:       (1, 1, nj, ni) — both axes set to 1.
    """
    squeeze = m_axis is not None and arr.shape[m_axis] == 1
    if squeeze:
        # Drop the member axis from the chunk shape entirely.
        result = []
        for i in range(arr.ndim):
            if i == m_axis:
                continue
            result.append(1 if i == t_axis else arr.shape[i])
        return tuple(result)
    else:
        non_spatial = {t_axis} | ({m_axis} if m_axis is not None else set())
        chunks = list(arr.shape)
        chunks[t_axis] = 1
        if m_axis is not None:
            chunks[m_axis] = 1
        for i in range(arr.ndim):
            if i not in non_spatial:
                chunks[i] = arr.shape[i]
        return tuple(chunks)


def _get_compressor(arr):
    """Return the compressor/codec for an array, handling v2 and v3 zarr."""
    # zarr v3: use .compressors (returns a tuple)
    try:
        compressors = arr.compressors
        if compressors:
            return list(compressors)
        return None
    except AttributeError:
        pass
    # zarr v2: use .compressor
    try:
        return arr.compressor
    except Exception:
        return None


def rechunk_store(store_path: Path, dry_run: bool = False, force: bool = False) -> dict:
    """
    Rechunk one zarr store in-place.

    Returns a summary dict with keys:
        path, arrays_rechunked, arrays_skipped, arrays_copied, elapsed_s, error
    """
    import zarr

    t0 = time.perf_counter()
    summary = {
        "path": str(store_path),
        "arrays_rechunked": 0,
        "arrays_skipped": 0,
        "arrays_copied": 0,
        "elapsed_s": 0.0,
        "error": None,
    }

    tmp_path = store_path.parent / (store_path.name + ".rechunk_tmp")

    # Detect zarr format up front so we can pass it explicitly to zarr.open().
    # zarr-python v3 changed the default open behaviour and will raise
    # "No group found" when asked to open a v2 store without a format hint.
    zarr_format = 3 if (store_path / "zarr.json").exists() else 2

    try:
        src = zarr.open_group(str(store_path), mode="r", zarr_format=zarr_format)

        # ── Decide what needs rechunking ──────────────────────────────────────
        to_rechunk  = []  # (name, arr, t_axis, m_axis, new_chunks)
        to_copy     = []  # (name, arr) — coordinate/scalar arrays

        for name in src.keys():
            arr = src[name]
            if not hasattr(arr, "shape") or arr.ndim == 0:
                to_copy.append((name, arr))
                continue

            t_axis = _time_axis(arr)
            # ndim < 3: 1-D coordinate arrays (time, x, y, …) — never rechunk.
            if t_axis is None or arr.shape[t_axis] <= 1 or arr.ndim < 3:
                to_copy.append((name, arr))
                continue

            m_axis = _member_axis(arr)

            if not force and _already_rechunked(arr, t_axis, m_axis):
                summary["arrays_skipped"] += 1
                label = "chunk_t=1, full spatial slice"
                if m_axis is not None:
                    label = "chunk_t=1, chunk_member=1, full spatial slice"
                print(
                    f"  [skip]   {name}  shape={arr.shape}  chunks={arr.chunks}  "
                    f"(already {label})"
                )
                to_copy.append((name, arr))  # must still be written to the output store
                continue

            new_chunks = _target_chunks(arr, t_axis, m_axis)
            to_rechunk.append((name, arr, t_axis, m_axis, new_chunks))

        if not to_rechunk:
            print(f"  [ok] Nothing to rechunk in {store_path.name}")
            summary["elapsed_s"] = time.perf_counter() - t0
            return summary

        # ── Report plan ───────────────────────────────────────────────────────
        for name, arr, t_axis, m_axis, new_chunks in to_rechunk:
            print(
                f"  [rechunk] {name}  shape={arr.shape}  "
                f"{arr.chunks} → {new_chunks}  dtype={arr.dtype}"
            )
        for name, arr in to_copy:
            print(f"  [copy]   {name}  shape={getattr(arr, 'shape', '()')}  dtype={getattr(arr, 'dtype', '?')}")

        if dry_run:
            summary["arrays_rechunked"] = len(to_rechunk)
            summary["arrays_copied"]    = len(to_copy)
            summary["elapsed_s"]        = time.perf_counter() - t0
            return summary

        # ── Clean up any leftover temp store from a previous interrupted run ──
        if tmp_path.exists():
            shutil.rmtree(tmp_path)

        # Open destination store in the same format.
        dst = zarr.open_group(
            str(tmp_path), mode="w",
            zarr_format=zarr_format,
        )

        # Copy root attributes.
        try:
            dst.attrs.update(dict(src.attrs))
        except Exception:
            pass

        # ── Copy coordinate / scalar arrays verbatim ──────────────────────────
        for name, arr in to_copy:
            if arr.ndim == 0:
                # Scalar: write as a scalar zarr array.
                dst_arr = dst.create_array(
                    name, shape=(), dtype=arr.dtype,
                )
                dst_arr[()] = arr[()]
            else:
                compressor = _get_compressor(arr)
                kwargs = dict(
                    name=name,
                    data=arr[:],
                    chunks=arr.chunks,
                )
                if zarr_format == 2:
                    # zarr v2 wants a single Codec, not a list
                    c2 = compressor[0] if isinstance(compressor, list) and compressor else compressor
                    kwargs["compressor"] = c2
                elif compressor:
                    kwargs["compressors"] = compressor if isinstance(compressor, list) else [compressor]
                dst.create_array(**kwargs)

            try:
                dict_attrs = dict(arr.attrs)
                if dict_attrs:
                    dst[name].attrs.update(dict_attrs)
            except Exception:
                pass
            summary["arrays_copied"] += 1

        # ── Rechunk time-indexed arrays ───────────────────────────────────────
        for name, arr, t_axis, m_axis, new_chunks in to_rechunk:
            squeeze_member = m_axis is not None and arr.shape[m_axis] == 1

            compressor = _get_compressor(arr)
            out_shape = tuple(
                arr.shape[i] for i in range(arr.ndim)
                if not (squeeze_member and i == m_axis)
            )
            kwargs = dict(
                name=name,
                shape=out_shape,
                chunks=new_chunks,
                dtype=arr.dtype,
                fill_value=arr.fill_value,
            )
            if zarr_format == 2:
                # zarr v2 wants a single Codec, not a list
                c2 = compressor[0] if isinstance(compressor, list) and compressor else compressor
                kwargs["compressor"] = c2
                kwargs["filters"] = list(arr.filters) if arr.filters else None
            elif compressor:
                kwargs["compressors"] = compressor if isinstance(compressor, list) else [compressor]

            dst_arr = dst.create_array(**kwargs)

            # Write one (time, member) slab at a time to bound memory usage.
            n_steps   = arr.shape[t_axis]
            # When squeezing a single-member axis, iterate only once (m=0).
            n_members = 1 if squeeze_member else (arr.shape[m_axis] if m_axis is not None else 1)
            total     = n_steps * n_members
            done      = 0
            # Destination t-axis index may shift when member axis is squeezed.
            dst_t_axis = t_axis if (not squeeze_member or m_axis is None or t_axis < m_axis) \
                         else t_axis - 1
            for t in range(n_steps):
                for m in range(n_members):
                    # Source index: select this (t, m) slab.
                    idx_src = [slice(None)] * arr.ndim
                    idx_src[t_axis] = t
                    if m_axis is not None:
                        idx_src[m_axis] = m

                    # Destination index: same shape as out_shape.
                    if squeeze_member:
                        idx_dst = [slice(None)] * len(out_shape)
                        idx_dst[dst_t_axis] = t
                    else:
                        idx_dst = list(idx_src)

                    try:
                        dst_arr[tuple(idx_dst)] = arr[tuple(idx_src)]
                    except Exception as slab_exc:
                        print(
                            f"    WARNING: skipping corrupt slab "
                            f"{name}[t={t}, m={m}]: {slab_exc}",
                            flush=True,
                        )

                    done += 1
                    if total > 10 and done % max(1, total // 10) == 0:
                        pct = int(done / total * 100)
                        print(f"    {name}: {pct}% ({done}/{total} slabs)", flush=True)

            try:
                dict_attrs = dict(arr.attrs)
                if dict_attrs:
                    # Remove the member dimension name from _ARRAY_DIMENSIONS
                    # when squeezing so downstream consumers see a 3-D array.
                    if squeeze_member and "_ARRAY_DIMENSIONS" in dict_attrs:
                        dims = list(dict_attrs["_ARRAY_DIMENSIONS"])
                        for mname in _MEMBER_DIM_NAMES:
                            if mname in dims:
                                dims.remove(mname)
                                break
                        dict_attrs["_ARRAY_DIMENSIONS"] = dims
                    dst_arr.attrs.update(dict_attrs)
            except Exception:
                pass

            summary["arrays_rechunked"] += 1

        # ── Atomic replace: rename tmp → original ─────────────────────────────
        backup = store_path.parent / (store_path.name + ".bak")
        store_path.rename(backup)
        tmp_path.rename(store_path)
        shutil.rmtree(backup)

    except Exception as exc:
        summary["error"] = str(exc)
        import traceback
        traceback.print_exc()
        # Leave the temp store for inspection; don't delete the original.

    summary["elapsed_s"] = time.perf_counter() - t0
    return summary


# ─────────────────────────────────────────────────────────────────────────────
# Store discovery
# ─────────────────────────────────────────────────────────────────────────────

def find_stores(dirs: list[Path], glob: str | None) -> list[Path]:
    """Return all .zarr directories under the given directories, sorted."""
    stores = []
    for d in dirs:
        if not d.is_dir():
            continue
        for child in sorted(d.iterdir()):
            if not child.is_dir():
                continue
            if not (child.suffix == ".zarr" or child.name.endswith(".zarr")):
                continue
            if glob and not fnmatch.fnmatch(child.name, glob):
                continue
            stores.append(child)
    return stores


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def _worker(args):
    """Top-level function for ProcessPoolExecutor (must be picklable)."""
    store_path, dry_run, force = args
    print(f"\n── {store_path.name} ({'DRY RUN' if dry_run else 'RECHUNKING'}) ──")
    return rechunk_store(store_path, dry_run=dry_run, force=force)


def main():
    """Run the command-line entry point."""
    parser = argparse.ArgumentParser(
        description="Rechunk forecast zarr stores to chunk_t=1 for the zarr_proxy fast path.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--dirs", nargs="+", type=Path, default=None,
        metavar="DIR",
        help="Directories to search for .zarr stores. Default: all model grid directories.",
    )
    parser.add_argument(
        "--glob", default=None, metavar="PATTERN",
        help="Only process stores whose directory name matches this glob, e.g. '2026050700.*'.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be rechunked without writing anything.",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Rechunk even stores that already have chunk_t=1 and full spatial slices.",
    )
    parser.add_argument(
        "--workers", type=int, default=1, metavar="N",
        help="Number of stores to process in parallel (default: 1). "
             "Each worker holds one full array frame in memory — "
             "be conservative with large grids.",
    )
    parser.add_argument(
        "--store", type=Path, default=None, metavar="PATH",
        help="Process a single specific store path (bypasses --dirs / --glob).",
    )
    args = parser.parse_args()

    if args.store:
        stores = [args.store]
    else:
        dirs = args.dirs if args.dirs else DEFAULT_DIRS
        stores = find_stores(dirs, args.glob)

    if not stores:
        print("No .zarr stores found. Check --dirs / --glob arguments.")
        sys.exit(0)

    print(f"Found {len(stores)} store(s) to process.")
    if args.dry_run:
        print("DRY RUN — no files will be written.\n")

    work = [(s, args.dry_run, args.force) for s in stores]

    summaries = []
    if args.workers <= 1:
        for item in work:
            summaries.append(_worker(item))
    else:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(_worker, item): item[0] for item in work}
            for fut in as_completed(futures):
                summaries.append(fut.result())

    # ── Final report ──────────────────────────────────────────────────────────
    print("\n" + "═" * 70)
    print("SUMMARY")
    print("═" * 70)
    total_rechunked = total_skipped = total_copied = 0
    errors = []
    for s in summaries:
        status = "ERROR" if s["error"] else "ok"
        print(
            f"  [{status:5s}]  {Path(s['path']).name:<45s}  "
            f"rechunked={s['arrays_rechunked']}  "
            f"skipped={s['arrays_skipped']}  "
            f"copied={s['arrays_copied']}  "
            f"{s['elapsed_s']:.1f}s"
        )
        total_rechunked += s["arrays_rechunked"]
        total_skipped   += s["arrays_skipped"]
        total_copied    += s["arrays_copied"]
        if s["error"]:
            errors.append((s["path"], s["error"]))

    print("─" * 70)
    print(
        f"  Total: {len(summaries)} stores  "
        f"rechunked={total_rechunked}  skipped={total_skipped}  copied={total_copied}"
    )
    if errors:
        print(f"\n  {len(errors)} ERROR(S):")
        for path, err in errors:
            print(f"    {path}: {err}")
        sys.exit(1)
    else:
        print("\n  All stores processed successfully.")


if __name__ == "__main__":
    main()
