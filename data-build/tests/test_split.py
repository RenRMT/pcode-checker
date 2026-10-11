import json
from collections import Counter
from dataclasses import replace

import pytest

from common import CACHE_DIR, LENGTHS_RESOURCE, PCODES_RESOURCE, load_json, read_lengths, read_units
from split import split


def test_round_trip(tmp_path, units, lengths):
    index, notes = split(units, lengths, {"lastModified": "x"}, tmp_path)
    assert notes == []
    assert set(index["countries"]) == {"AAA", "BBB"}
    aaa = load_json(tmp_path / "AAA" / "v01.json")
    assert aaa["units"] == [[u.pcode, u.name, u.parent, u.level] for u in units if u.iso3 == "AAA"]
    assert aaa["lengths"] == ["2", "2", "2"]
    bbb = index["countries"]["BBB"]
    assert bbb["file"] == "BBB/v03.json"
    assert bbb["levels"] == {"1": 1, "2": 1}
    assert bbb["rows"] == 2
    assert load_json(tmp_path / "BBB" / "v03.json")["units"][1][1] == "Tillabéri"
    assert "CC BY-IGO" in index["attribution"]


def test_new_version_keeps_old_file(tmp_path, units, lengths):
    first, _ = split(units, lengths, None, tmp_path)
    bumped = [replace(u, version="v02", valid_from="2026-01-01") if u.iso3 == "AAA" else u for u in units]
    index, notes = split(bumped, lengths, None, tmp_path, first)
    assert (tmp_path / "AAA" / "v01.json").exists()
    assert (tmp_path / "AAA" / "v02.json").exists()
    assert [v["version"] for v in index["countries"]["AAA"]["versions"]] == ["v01", "v02"]
    assert "AAA: new version v02 (was v01)" in notes


def test_changed_content_without_version_bump_is_noted(tmp_path, units, lengths):
    first, _ = split(units, lengths, None, tmp_path)
    renamed = [replace(units[0], name="Northern")] + units[1:]
    _, notes = split(renamed, lengths, None, tmp_path, first)
    assert "AAA: content of v01 changed without a version bump" in notes


def test_sorted_by_level_keeping_order(tmp_path, units, lengths):
    shuffled = [units[2], units[0], units[3], units[1], units[4]]
    split(shuffled, lengths, None, tmp_path)
    rows = load_json(tmp_path / "AAA" / "v01.json")["units"]
    assert [r[0] for r in rows] == ["AA01", "AA02", "AA0101", "AA0201", "AA0202"]


@pytest.mark.skipif(not (CACHE_DIR / PCODES_RESOURCE).exists(), reason="real data not downloaded")
def test_real_data_round_trip(tmp_path):
    units = read_units(CACHE_DIR / PCODES_RESOURCE)
    index, _ = split(units, read_lengths(CACHE_DIR / LENGTHS_RESOURCE), None, tmp_path)
    counts = Counter(u.iso3 for u in units)
    for iso3, info in index["countries"].items():
        data = json.loads((tmp_path / info["file"]).read_text(encoding="utf-8"))
        assert len(data["units"]) == counts[iso3] == info["rows"]
