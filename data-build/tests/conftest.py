import csv
from pathlib import Path

import pytest

from common import Unit

HEADER = ["Location", "Admin Level", "P-Code", "Name", "Parent P-Code", "Valid from date", "Version"]


def unit(iso3, level, pcode, name, parent, version="v01", valid_from="2024-01-01"):
    return Unit(iso3, level, pcode, name, parent, valid_from, version)


@pytest.fixture
def units():
    return [
        unit("AAA", 1, "AA01", "North", "AAA"),
        unit("AAA", 1, "AA02", "South", "AAA"),
        unit("AAA", 2, "AA0101", "Riverside", "AA01"),
        unit("AAA", 2, "AA0201", "Riverside", "AA02"),
        unit("AAA", 2, "AA0202", "Hilltop", "AA02"),
        unit("BBB", 1, "BBB001", "Ouest", "BBB", "v03", "2025-05-05"),
        unit("BBB", 2, "BBB00101", "Tillabéri", "BBB001", "v03", "2025-05-05"),
    ]


@pytest.fixture
def lengths():
    return {"AAA": ["2", "2", "2"], "BBB": ["3", "3", "2"]}


@pytest.fixture
def csv_files(tmp_path: Path, units, lengths):
    pcodes = tmp_path / "global_pcodes.csv"
    with open(pcodes, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        for u in units:
            w.writerow([u.iso3, u.level, u.pcode, u.name, u.parent, u.valid_from, u.version])
    lengths_path = tmp_path / "global_pcode_lengths.csv"
    with open(lengths_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Location", "Country Length"] + [f"Admin {i} Length" for i in range(1, 6)])
        for iso3, values in lengths.items():
            w.writerow([iso3, *values, *[""] * (6 - len(values))])
    return pcodes, lengths_path
