"""Load fixture country data and cases (synthetic + curated)."""

from __future__ import annotations

from pathlib import Path

from common import load_json


def load_payloads(fixtures_dir: Path) -> dict[str, dict]:
    return {p.stem: load_json(p) for p in sorted((fixtures_dir / "data").glob("*.json"))}


def load_cases(fixtures_dir: Path, sets: tuple[str, ...] = ("synthetic", "curated")) -> list[dict]:
    cases = []
    for name in sets:
        for path in sorted((fixtures_dir / name).glob("*.json")):
            data = load_json(path)
            for case in data["cases"]:
                cases.append({**case, "set": name})
    return cases
