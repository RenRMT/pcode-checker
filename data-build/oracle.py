"""Record hdx-python-country's answers so the TypeScript port can be tested
against them without Python.

Writes:
- fixtures/oracle/{ISO3}.json: {case id: p-code or null} from AdminLevel.get_pcode
  for every synthetic and curated case;
- fixtures/scorers.json: input/output vectors for hdx's normalise and the
  rapidfuzz scorers the port reimplements.

Needs the eval dependency group: `uv run --group eval python oracle.py`.
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

from hdx.utilities.matching import RapidFuzzMatcher, resolve_name_parts
from hdx.utilities.text import normalise
from rapidfuzz import fuzz
from rapidfuzz.distance import JaroWinkler

from common import FIXTURES_DIR, load_json, write_json
from eval.cases import load_cases, load_payloads
from eval.hdx_oracle import Oracle

EXTRA_NORMALISE = [
    "Al-Hasakeh",
    "  Deir-ez-Zor  ",
    "Tillabéri",
    "Ségou",
    "N'Djamena",
    "Côte d’Ivoire",
    "São Tomé & Príncipe",
    "Ma'arrat An-Nu'man",
    "ÆØÅ ß œ",
    "Ğazze İstanbul",
    "القاهرة",
    "Kano  (Municipal)",
    "Abuja_Municipal/Area Council",
    "Saint-Louis",
    "",
    "123 Main St.",
    "Tab\tand\nnewline",
]

EXTRA_PAIRS = [
    ("", ""),
    ("a", ""),
    ("abc", "abc"),
    ("central kalimantan", "kalimantan utara"),
    ("central west", "centre west"),
    ("kenge city", "kenge"),
    ("al hasakeh", "hasakeh al"),
    ("deir ez zor", "dayr az zawr"),
    ("new york new", "york new"),
    ("ab ab cd", "cd ab"),
    ("martha", "marhta"),
    ("dixon", "dicksonx"),
    ("jellyfish", "smellyfish"),
]


def scorer_vectors(cases: list[dict], payloads: dict[str, dict], n: int = 600) -> dict:
    rng = random.Random(7)
    names = {iso3: [u[1] for u in p["units"] if u[1]] for iso3, p in payloads.items()}
    texts = [c["input"] for c in cases] + [name for ns in names.values() for name in ns]
    normalise_inputs = EXTRA_NORMALISE + rng.sample(texts, min(300, len(texts)))
    pairs = list(EXTRA_PAIRS)
    for case in rng.sample(cases, min(n, len(cases))):
        a = normalise(case["input"])
        b = normalise(rng.choice(names[case["iso3"]]))
        pairs.append((a, b))
        expected = case.get("expected")
        if expected and expected != "AMBIGUOUS":
            name = next((u[1] for u in payloads[case["iso3"]]["units"] if u[0] == expected), None)
            if name:
                pairs.append((a, normalise(name)))
    return {
        "normalise": [[t, normalise(t)] for t in normalise_inputs],
        "pairs": [
            {
                "a": a,
                "b": b,
                "ratio": fuzz.ratio(a, b),
                "token_set_ratio": fuzz.token_set_ratio(a, b),
                "token_sort_ratio": fuzz.token_sort_ratio(a, b),
                "jaro_winkler": JaroWinkler.similarity(a, b),
                "default_scorer": RapidFuzzMatcher.default_scorer(a, b),
                "place_name_scorer": RapidFuzzMatcher.place_name_scorer(a, b),
            }
            for a, b in pairs
        ],
        "resolve_name_parts": resolve_vectors(),
    }


def resolve_vectors() -> list[dict]:
    lookup = {"falcon": "VE09", "acosta": "VE0901", "guba": "AZ01", "khachmaz": "AZ02", "protection": "PRO", "gbv": "PRO-GBV"}
    inputs = [
        ("Falcón, Acosta", "falcon"),
        ("Acosta, Falcón", "falcon"),
        ("Guba-Khachmaz", None),
        ("Protection - GBV", None),
        ("Guba / Guba", None),
        ("Wash & Protection & GBV", None),
        ("Guba and Khachmaz", None),
        ("Nowhere", None),
        ("Guba - Nowhere", None),
    ]
    return [
        {"name": name, "ignore": ignore, "lookup": lookup, "result": list(resolve_name_parts(name, lookup, ignore))}
        for name, ignore in inputs
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=FIXTURES_DIR)
    args = parser.parse_args(argv)
    payloads = load_payloads(args.fixtures)
    cases = load_cases(args.fixtures)
    oracle = Oracle(payloads)
    by_country: dict[str, dict] = {}
    for case in cases:
        by_country.setdefault(case["iso3"], {})[case["id"]] = oracle.match(case)
    for iso3, answers in sorted(by_country.items()):
        write_json(args.fixtures / "oracle" / f"{iso3}.json", answers)
        print(f"{iso3}: {len(answers)} oracle answers")
    write_json(args.fixtures / "scorers.json", scorer_vectors(cases, payloads))
    print("wrote scorers.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
