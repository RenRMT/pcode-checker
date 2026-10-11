"""Shared types and CSV readers for the data build."""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent
CACHE_DIR = HERE / ".cache"
DEFAULT_OUT = REPO / "site" / "data"
FIXTURES_DIR = REPO / "fixtures"

DATASET_ID = "global-pcodes"
DATASET_URL = f"https://data.humdata.org/dataset/{DATASET_ID}"
PCODES_RESOURCE = "global_pcodes.csv"
LENGTHS_RESOURCE = "global_pcode_lengths.csv"
LICENSE = "CC BY-IGO"
ATTRIBUTION = (
    "Global P-code List by UN OCHA Information Systems Section (ISS), "
    "from the Humanitarian Data Exchange (HDX), licensed under CC BY-IGO. "
    f"{DATASET_URL}"
)


@dataclass(frozen=True)
class Unit:
    iso3: str
    level: int
    pcode: str
    name: str
    parent: str
    valid_from: str
    version: str


def read_units(path: Path) -> list[Unit]:
    """Read global_pcodes.csv. The file starts with a UTF-8 BOM."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [
            Unit(
                iso3=row["Location"].strip().upper(),
                level=int(row["Admin Level"]),
                pcode=row["P-Code"].strip(),
                name=(row["Name"] or "").strip(),
                parent=row["Parent P-Code"].strip(),
                valid_from=row["Valid from date"].strip(),
                version=row["Version"].strip(),
            )
            for row in csv.DictReader(f)
        ]


def read_lengths(path: Path) -> dict[str, list[str]]:
    """Read global_pcode_lengths.csv as {iso3: [country, adm1, ..., adm5]}.

    Values stay strings: a length can be blank (unknown) or list alternatives
    such as "2|3".
    """
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        out = {}
        for row in reader:
            values = [row["Country Length"].strip()]
            for level in range(1, 6):
                values.append((row.get(f"Admin {level} Length") or "").strip())
            while values and values[-1] == "":
                values.pop()
            out[row["Location"].strip().upper()] = values
        return out


def expected_lengths(lengths: list[str], level: int) -> set[int] | None:
    """Possible total p-code lengths at an admin level, or None if unknown."""
    totals = {0}
    for part in lengths[: level + 1]:
        if part == "":
            return None
        options = {int(x) for x in part.split("|")}
        totals = {t + o for t in totals for o in options}
    if len(lengths) < level + 1:
        return None
    return totals


def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data, compact: bool = False) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(data, ensure_ascii=False, indent=1)
    raw = (text + "\n").encode("utf-8")
    path.write_bytes(raw)
    return raw


def country_names() -> dict[str, str]:
    return load_json(HERE / "country_names.json")
