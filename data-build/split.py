"""Split the global list into one compact JSON file per country and version.

Writes {out}/{ISO3}/{version}.json and {out}/index.json. Files for older
versions are never deleted, so p-codes stamped with an old version still
resolve.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from common import (
    ATTRIBUTION,
    CACHE_DIR,
    DATASET_URL,
    DEFAULT_OUT,
    LENGTHS_RESOURCE,
    LICENSE,
    PCODES_RESOURCE,
    Unit,
    country_names,
    load_json,
    read_lengths,
    read_units,
    write_json,
)

FORMAT_VERSION = 1


def country_payload(iso3: str, units: list[Unit], lengths: list[str] | None, name: str) -> dict:
    ordered = sorted(units, key=lambda u: u.level)  # stable: keeps CSV order within a level
    return {
        "format": FORMAT_VERSION,
        "iso3": iso3,
        "name": name,
        "version": units[0].version,
        "validFrom": units[0].valid_from,
        "lengths": lengths,
        "units": [[u.pcode, u.name, u.parent, u.level] for u in ordered],
    }


def pcode_prefix(units: list[Unit]) -> str:
    """Letters that start the country's adm1 p-codes ("SY", "NGA"), so a
    p-code's country can be found from the p-code alone."""
    letters = Counter(re.match(r"[A-Za-z]*", u.pcode).group(0).upper() for u in units if u.level == 1)
    return letters.most_common(1)[0][0] if letters else ""


def split(
    units: list[Unit],
    lengths: dict[str, list[str]],
    source: dict | None,
    out_dir: Path,
    previous_index: dict | None = None,
) -> tuple[dict, list[str]]:
    """Write the per-country files and return (index, notes)."""
    names = country_names()
    by_country: dict[str, list[Unit]] = defaultdict(list)
    for unit in units:
        by_country[unit.iso3].append(unit)

    previous_countries = (previous_index or {}).get("countries", {})
    notes = []
    countries = {}
    for iso3 in sorted(by_country):
        country_units = by_country[iso3]
        payload = country_payload(iso3, country_units, lengths.get(iso3), names.get(iso3, iso3))
        version = payload["version"]
        rel = f"{iso3}/{version}.json"
        path = out_dir / rel
        old = path.read_bytes() if path.exists() else None
        raw = write_json(path, payload, compact=True)
        if old is not None and old != raw:
            notes.append(f"{iso3}: content of {version} changed without a version bump")
        elif old is None and iso3 in previous_countries:
            notes.append(f"{iso3}: new version {version} (was {previous_countries[iso3]['version']})")
        elif iso3 not in previous_countries and previous_index:
            notes.append(f"{iso3}: new country")

        versions = {v["version"]: v for v in previous_countries.get(iso3, {}).get("versions", [])}
        versions[version] = {
            "version": version,
            "validFrom": payload["validFrom"],
            "file": rel,
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
        levels = Counter(u.level for u in country_units)
        countries[iso3] = {
            "name": payload["name"],
            "prefix": pcode_prefix(country_units),
            "version": version,
            "validFrom": payload["validFrom"],
            "file": rel,
            "bytes": len(raw),
            "sha256": versions[version]["sha256"],
            "rows": len(country_units),
            "levels": {str(level): n for level, n in sorted(levels.items())},
            "versions": sorted(versions.values(), key=lambda v: v["validFrom"]),
        }

    for iso3 in sorted(set(previous_countries) - set(countries)):
        notes.append(f"{iso3}: no longer in the source; previous files kept")

    index = {
        "format": FORMAT_VERSION,
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "license": LICENSE,
        "attribution": ATTRIBUTION,
        "sourceUrl": DATASET_URL,
        "source": source or {},
        "countries": countries,
    }
    write_json(out_dir / "index.json", index)
    return index, notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pcodes", type=Path, default=CACHE_DIR / PCODES_RESOURCE)
    parser.add_argument("--lengths", type=Path, default=CACHE_DIR / LENGTHS_RESOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    index_path = args.out / "index.json"
    previous = load_json(index_path) if index_path.exists() else None
    index, notes = split(
        read_units(args.pcodes), read_lengths(args.lengths), previous and previous.get("source"), args.out, previous
    )
    print(f"wrote {len(index['countries'])} countries to {args.out}")
    for note in notes:
        print(note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
