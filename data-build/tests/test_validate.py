from dataclasses import replace

from common import expected_lengths, read_lengths, read_units
from validate import validate


def test_clean_data_passes(units, lengths):
    report = validate(units, lengths)
    assert report.ok, report.format()
    assert report.warnings == []


def test_reads_csv_with_bom(csv_files, units, lengths):
    pcodes, lengths_path = csv_files
    assert read_units(pcodes) == units
    assert read_lengths(lengths_path) == lengths


def test_duplicate_pcode_at_one_level_fails(units, lengths):
    report = validate(units + [units[0]], lengths)
    assert any("AA01 is not unique" in e for e in report.errors)


def test_pcode_reused_across_levels_only_warns(units, lengths):
    # MMR reuses adm2 p-codes at adm3; lengths table says adm3 adds 0 digits
    extra = [replace(units[2], level=3, parent="AA0101")]
    report = validate(units + extra, {**lengths, "AAA": ["2", "2", "2", "0"]})
    assert report.ok, report.format()
    assert any("reused" in w for w in report.warnings)


def test_missing_parent_fails(units, lengths):
    report = validate(units + [replace(units[2], pcode="AA0909", parent="AA09")], lengths)
    assert any("no parent" in e for e in report.errors)


def test_adm1_parent_must_be_country(units, lengths):
    report = validate([replace(units[0], parent="ZZZ")] + units[1:], lengths)
    assert any("AAA adm1" in e and "no parent" in e for e in report.errors)


def test_wrong_length_fails(units, lengths):
    report = validate(units + [replace(units[2], pcode="AA01011")], lengths)
    assert any("wrong length" in e for e in report.errors)


def test_length_alternatives_and_blanks():
    assert expected_lengths(["2", "2", "3", "2|3"], 3) == {9, 10}
    assert expected_lengths(["2", "2", ""], 2) is None
    assert expected_lengths(["2", "2"], 2) is None
    assert expected_lengths(["3", "3", "3|4", "0"], 3) == {9, 10}


def test_empty_name_warns(units, lengths):
    report = validate(units + [replace(units[2], pcode="AA0102", name="")], lengths)
    assert report.ok
    assert any("no name" in w for w in report.warnings)


def test_two_versions_in_one_country_fails(units, lengths):
    report = validate(units[:-1] + [replace(units[-1], version="v04")], lengths)
    assert any("more than one version" in e for e in report.errors)


def test_sharp_drop_fails_unless_allowed(units, lengths):
    previous = {"countries": {"AAA": {"rows": 50}, "BBB": {"rows": 2}}}
    report = validate(units, lengths, previous)
    assert any("AAA: row count dropped from 50 to 5" in e for e in report.errors)
    allowed = validate(units, lengths, previous, allow_drop={"AAA"})
    assert allowed.ok
    assert any("(allowed)" in w for w in allowed.warnings)


def test_vanished_country_fails(units, lengths):
    previous = {"countries": {"CCC": {"rows": 10}}}
    assert not validate(units, lengths, previous).ok
