import json
import random

import fetch
import fixtures
from split import split

PACKAGE = {
    "name": "global-pcodes",
    "title": "Global P-codes",
    "license_title": "CC BY-IGO",
    "last_modified": "2026-09-16T20:41:53",
    "resources": [
        {"name": "global_pcodes.csv", "url": "https://x/a.csv", "last_modified": "2026-09-16", "hash": "abc", "size": 1},
        {"name": "global_pcode_lengths.csv", "url": "https://x/b.csv", "last_modified": "2026-09-16", "hash": "", "size": 1},
        {"name": "global_pcodes_hxl.csv", "url": "https://x/c.csv", "last_modified": "2026-09-16"},
    ],
}


def test_source_metadata_and_change_detection():
    source = fetch.source_from_package(PACKAGE)
    assert set(source["resources"]) == {"global_pcodes.csv", "global_pcode_lengths.csv"}
    assert source["resources"]["global_pcode_lengths.csv"]["md5"] is None
    assert fetch.is_changed(source, None)
    assert not fetch.is_changed(source, {"source": source})
    older = json.loads(json.dumps(source))
    older["resources"]["global_pcodes.csv"]["lastModified"] = "2026-08-01"
    assert fetch.is_changed(source, {"source": older})


def test_download_verifies_checksum(tmp_path, monkeypatch):
    source = fetch.source_from_package(PACKAGE)
    monkeypatch.setattr(fetch, "http_get", lambda url: b"data")
    try:
        fetch.download(source, tmp_path)
    except RuntimeError as e:
        assert "checksum mismatch" in str(e)
    else:
        raise AssertionError("expected a checksum error")
    source["resources"]["global_pcodes.csv"]["md5"] = fetch.md5(b"data")
    paths = fetch.download(source, tmp_path)
    assert paths["global_pcodes.csv"].read_bytes() == b"data"


def test_noise_functions_change_the_name():
    rng = random.Random(1)
    assert fixtures.noise_diacritics("Tillabéri", rng) == "Tillaberi"
    assert fixtures.noise_article("Al-Hasakeh", rng) == "Hasakeh"
    assert fixtures.noise_article("Damascus", rng) is None
    assert fixtures.noise_spacing("Deir-ez-Zor", rng) == "Deir ez Zor"
    for _ in range(50):
        typo = fixtures.noise_typo("Damascus", rng)
        assert typo and typo != "Damascus" and typo[0] == "D"


def test_generate_is_deterministic_and_labels_duplicates(tmp_path, units, lengths):
    data = tmp_path / "data"
    split(units, lengths, None, data)
    out1, out2 = tmp_path / "f1", tmp_path / "f2"
    fixtures.generate(data, ["AAA", "BBB"], out1)
    fixtures.generate(data, ["AAA", "BBB"], out2)
    a = (out1 / "synthetic" / "AAA.json").read_text(encoding="utf-8")
    assert a == (out2 / "synthetic" / "AAA.json").read_text(encoding="utf-8")
    cases = json.loads(a)["cases"]
    riverside = [c for c in cases if c["noise"] == "duplicate"]
    assert riverside and all(c["expected"] == "AMBIGUOUS" for c in riverside)
    with_parent = [c for c in cases if c["noise"] == "duplicate_parent"]
    assert all(c["expected"] in ("AA0101", "AA0201") for c in with_parent)
    assert (out1 / "data" / "AAA.json").exists()
