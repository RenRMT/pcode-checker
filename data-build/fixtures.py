"""Generate golden test fixtures from the real names.

Writes, for each fixture country:
- fixtures/data/{ISO3}.json: the country file, so core tests run without the
  data branch;
- fixtures/synthetic/{ISO3}.json: noisy variants of real names with the
  expected p-code (or "AMBIGUOUS" or null).

Case format: {id, input, iso3, level, parent?, expected, noise}. Generation
is seeded, so reruns give the same cases for the same data version.
"""

from __future__ import annotations

import argparse
import difflib
import random
import re
import shutil
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

from common import DEFAULT_OUT, FIXTURES_DIR, load_json, write_json

DEFAULT_COUNTRIES = ("SYR", "NER", "NGA")
PER_LEVEL = 120
NEGATIVES = 40
DUPLICATE_GROUPS = 25
SEED = 20261011

LEVEL_WORDS = {
    1: ["Governorate", "Province", "State", "Region"],
    2: ["District", "LGA", "Department", "County"],
    3: ["Sub-district", "Commune", "Ward"],
    4: ["Village", "Commune"],
    5: ["Village"],
}

TRANSLIT = [
    (r"ou", "u"),
    (r"(?<!o)u", "ou"),
    (r"kh", "h"),
    (r"(?<![csk])h", "kh"),
    (r"dj", "j"),
    (r"(?<!d)j", "dj"),
    (r"sh", "ch"),
    (r"ch", "sh"),
    (r"q", "k"),
    (r"k(?!h)", "q"),
    (r"ee", "i"),
    (r"([bcdfgklmnprstz])\1", r"\1"),
    (r"(?<=[aeiou])([bdlmnrst])(?=[aeiou])", r"\1\1"),
    (r"ei", "ai"),
    (r"ai", "ei"),
    (r"y", "i"),
]

ARTICLE = re.compile(r"^(al|el|ad|ed|ar|as|az|ash|an)[- ]", re.IGNORECASE)


def simple_normalise(text: str) -> str:
    """Close to hdx.utilities.text.normalise; used only to label duplicates."""
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower().replace("'", "")
    return " ".join(re.sub(r"[\W_]+", " ", text).split())


def strip_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return unicodedata.normalize("NFC", "".join(c for c in decomposed if not unicodedata.combining(c)))


def noise_case(name: str, rng: random.Random) -> str | None:
    style = rng.choice(["upper", "lower", "title"])
    out = {"upper": name.upper(), "lower": name.lower(), "title": name.title()}[style]
    return out if out != name else None


def noise_diacritics(name: str, rng: random.Random) -> str | None:
    out = strip_diacritics(name)
    return out if out != name else None


def noise_typo(name: str, rng: random.Random) -> str | None:
    letters = [i for i, c in enumerate(name) if c.isalpha() and i > 0]
    if len(name) < 6 or len(letters) < 3:
        return None
    i = rng.choice(letters[:-1])
    op = rng.choice(["sub", "del", "ins", "swap"])
    alphabet = "abcdefghijklmnopqrstuvwxyz"
    if op == "sub":
        out = name[:i] + rng.choice(alphabet.replace(name[i].lower(), "")) + name[i + 1 :]
    elif op == "del":
        out = name[:i] + name[i + 1 :]
    elif op == "ins":
        out = name[:i] + rng.choice(alphabet) + name[i:]
    else:
        out = name[:i] + name[i + 1] + name[i] + name[i + 2 :]
    return out if out != name else None


def noise_translit(name: str, rng: random.Random) -> str | None:
    lower = name.lower()
    options = [(p, r) for p, r in TRANSLIT if re.search(p, lower[1:])]
    if not options:
        return None
    pattern, repl = rng.choice(options)
    matches = [m for m in re.finditer(pattern, lower) if m.start() > 0]
    if not matches:
        return None
    m = rng.choice(matches)
    out = lower[: m.start()] + m.expand(repl) + lower[m.end() :]
    return out.title() if out != lower else None


def noise_level_word(name: str, rng: random.Random, level: int) -> str | None:
    word = rng.choice(LEVEL_WORDS.get(level, ["District"]))
    return f"{name} {word}"


def noise_article(name: str, rng: random.Random) -> str | None:
    m = ARTICLE.match(name)
    if m:
        return name[m.end() :]
    return None


def noise_spacing(name: str, rng: random.Random) -> str | None:
    if "-" in name:
        return name.replace("-", " ")
    if " " in name:
        return name.replace(" ", "-")
    return None


NOISES = {
    "case": noise_case,
    "diacritics": noise_diacritics,
    "typo": noise_typo,
    "translit": noise_translit,
    "level_word": None,  # needs the level, handled in make_noisy
    "article": noise_article,
    "spacing": noise_spacing,
}


def make_noisy(name: str, level: int, noise: str, rng: random.Random) -> str | None:
    if noise == "level_word":
        return noise_level_word(name, rng, level)
    return NOISES[noise](name, rng)


def build_cases(country: dict, others: list[dict], rng: random.Random) -> list[dict]:
    iso3 = country["iso3"]
    units = [u for u in country["units"] if u[1]]
    by_level: dict[int, list] = defaultdict(list)
    for u in units:
        by_level[u[3]].append(u)
    # normalised name -> units, per level and per (level, parent)
    scope_all: dict[tuple, list] = defaultdict(list)
    scope_parent: dict[tuple, list] = defaultdict(list)
    for u in units:
        key = simple_normalise(u[1])
        scope_all[(u[3], key)].append(u)
        scope_parent[(u[3], u[2], key)].append(u)

    cases = []
    for level in sorted(by_level):
        sample = rng.sample(by_level[level], min(PER_LEVEL, len(by_level[level])))
        for pcode, name, parent, _ in sample:
            use_parent = level >= 3 or (level == 2 and rng.random() < 0.5)
            scope = scope_parent[(level, parent, simple_normalise(name))] if use_parent else scope_all[(level, simple_normalise(name))]
            expected = pcode if len(scope) == 1 else "AMBIGUOUS"
            variants = [("exact", name)] if rng.random() < 0.25 else []
            for noise in rng.sample(list(NOISES), len(NOISES)):
                noisy = make_noisy(name, level, noise, rng)
                if noisy and noisy != name:
                    variants.append((noise, noisy))
                if len(variants) >= 3:
                    break
            for noise, text in variants:
                # A noisy name that exactly equals another unit's name is not a fair test
                if noise not in ("exact", "case", "diacritics", "spacing", "level_word"):
                    key = simple_normalise(text)
                    clash = scope_parent.get((level, parent, key)) if use_parent else scope_all.get((level, key))
                    if clash and any(c[0] != pcode for c in clash):
                        continue
                case = {"input": text, "iso3": iso3, "level": level}
                if use_parent:
                    case["parent"] = parent
                case["expected"] = expected
                case["noise"] = noise
                cases.append(case)

    cases += duplicate_cases(iso3, scope_all, rng)
    cases += negative_cases(country, others, rng)
    for i, case in enumerate(cases):
        case["id"] = f"{iso3}-{i:04d}"
    return [{"id": c.pop("id"), **c} for c in cases]


def duplicate_cases(iso3: str, scope_all: dict[tuple, list], rng: random.Random) -> list[dict]:
    """Names shared by several units at one level: ambiguous alone, unique with a parent."""
    groups = sorted((key, units) for key, units in scope_all.items() if len(units) > 1)
    rng.shuffle(groups)
    cases = []
    for (level, _), units in groups[:DUPLICATE_GROUPS]:
        cases.append({"input": units[0][1], "iso3": iso3, "level": level, "expected": "AMBIGUOUS", "noise": "duplicate"})
        unit = rng.choice(units)
        same_parent = [u for u in units if u[2] == unit[2]]
        expected = unit[0] if len(same_parent) == 1 else "AMBIGUOUS"
        cases.append(
            {"input": unit[1], "iso3": iso3, "level": level, "parent": unit[2], "expected": expected, "noise": "duplicate_parent"}
        )
    return cases


def negative_cases(country: dict, others: list[dict], rng: random.Random) -> list[dict]:
    """Names from other countries that look nothing like any name here."""
    iso3 = country["iso3"]
    own = defaultdict(list)
    for u in country["units"]:
        if u[1]:
            own[u[3]].append(simple_normalise(u[1]))
    pool = [(u[1], u[3]) for other in others for u in other["units"] if u[1] and u[3] in own and u[3] <= 2]
    rng.shuffle(pool)
    cases = []
    for name, level in pool:
        key = simple_normalise(name)
        if len(key) < 5:
            continue
        if difflib.get_close_matches(key, own[level], n=1, cutoff=0.6):
            continue
        cases.append({"input": name, "iso3": iso3, "level": level, "expected": None, "noise": "negative"})
        if len(cases) >= NEGATIVES:
            break
    return cases


def generate(data_dir: Path, countries: list[str], fixtures_dir: Path = FIXTURES_DIR) -> dict[str, int]:
    index = load_json(data_dir / "index.json")
    payloads = {iso3: load_json(data_dir / index["countries"][iso3]["file"]) for iso3 in countries}
    counts = {}
    for iso3 in countries:
        rng = random.Random(f"{SEED}-{iso3}")
        shutil.copyfile(data_dir / index["countries"][iso3]["file"], _mkdir(fixtures_dir / "data") / f"{iso3}.json")
        others = [p for k, p in payloads.items() if k != iso3]
        cases = build_cases(payloads[iso3], others, rng)
        write_json(
            fixtures_dir / "synthetic" / f"{iso3}.json",
            {"iso3": iso3, "version": payloads[iso3]["version"], "seed": SEED, "cases": cases},
        )
        counts[iso3] = len(cases)
    return counts


def _mkdir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--out", type=Path, default=FIXTURES_DIR)
    parser.add_argument("countries", nargs="*", default=list(DEFAULT_COUNTRIES))
    args = parser.parse_args(argv)
    for iso3, n in generate(args.data, [c.upper() for c in args.countries], args.out).items():
        print(f"{iso3}: {n} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
