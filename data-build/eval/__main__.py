"""Evaluate the TypeScript matcher against hdx-python-country.

    uv run --group eval python -m eval [--sets synthetic curated] [--errors 20] [--out report.md]

Runs every fixture case through:
- hdx-python-country (Python, the reference oracle);
- the TS port of hdx (packages/core, --mode hdx), to check port fidelity;
- the TS matcher (packages/core), at a range of score thresholds.

Needs packages/core built (`npm run build -w @pcode-checker/core`).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from common import FIXTURES_DIR, REPO, load_json
from eval.cases import load_cases, load_payloads
from eval.hdx_oracle import Oracle

CLI = REPO / "packages" / "core" / "dist" / "cli.js"
THRESHOLDS = (60, 65, 70, 75, 80, 85, 90, 95, 100)
AMBIGUOUS = "AMBIGUOUS"


@dataclass
class Metrics:
    n: int
    correct: int
    committed: int
    committed_correct: int
    expect_pcode: int
    found: int
    ambiguous_expected: int
    ambiguous_flagged: int

    @property
    def accuracy(self) -> float:
        return self.correct / self.n if self.n else 0

    @property
    def precision(self) -> float:
        return self.committed_correct / self.committed if self.committed else 1

    @property
    def recall(self) -> float:
        return self.found / self.expect_pcode if self.expect_pcode else 1

    @property
    def wrong(self) -> int:
        return self.committed - self.committed_correct


def is_correct(expected, predicted) -> bool:
    if expected is None:
        return predicted in (None, AMBIGUOUS)
    return predicted == expected


def metrics(cases: list[dict], predictions: dict[str, str | None]) -> Metrics:
    m = Metrics(len(cases), 0, 0, 0, 0, 0, 0, 0)
    for case in cases:
        expected, predicted = case["expected"], predictions.get(case["id"])
        m.correct += is_correct(expected, predicted)
        if predicted not in (None, AMBIGUOUS):
            m.committed += 1
            m.committed_correct += predicted == expected
        if expected not in (None, AMBIGUOUS):
            m.expect_pcode += 1
            m.found += predicted == expected
        if expected == AMBIGUOUS:
            m.ambiguous_expected += 1
            m.ambiguous_flagged += predicted == AMBIGUOUS
    return m


def run_cli(cases: list[dict], data_dir: Path, mode: str) -> dict[str, dict]:
    if not CLI.exists():
        raise SystemExit(f"{CLI} not found: run `npm run build -w @pcode-checker/core` first")
    payload = "".join(
        json.dumps({k: c.get(k) for k in ("id", "input", "iso3", "level", "parent")}) + "\n" for c in cases
    )
    proc = subprocess.run(
        ["node", str(CLI), "--data", str(data_dir), "--mode", mode],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return {r["id"]: r for r in map(json.loads, proc.stdout.splitlines())}


def core_predictions(results: dict[str, dict], threshold: float) -> dict[str, str | None]:
    out = {}
    for case_id, r in results.items():
        if r["status"] == "ambiguous":
            out[case_id] = AMBIGUOUS
        elif r["status"] in ("exact", "fuzzy") and r["score"] >= threshold:
            out[case_id] = r["pcode"]
        else:
            out[case_id] = None
    return out


def row(label: str, m: Metrics) -> str:
    return (
        f"| {label} | {m.accuracy:.3f} | {m.precision:.3f} | {m.recall:.3f} | {m.wrong} | "
        f"{m.ambiguous_flagged}/{m.ambiguous_expected} |"
    )


def report(cases: list[dict], hdx: dict, port: dict, core: dict, errors: int) -> str:
    lines = []
    for subset_name, subset in [("all", cases), *sorted(_group(cases, "set").items()), *sorted(_group(cases, "iso3").items())]:
        lines += [
            f"### {subset_name} ({len(subset)} cases)",
            "",
            "| system | accuracy | precision | recall | wrong p-codes | ambiguous flagged |",
            "|---|---|---|---|---|---|",
            row("hdx-python-country", metrics(subset, hdx)),
        ]
        for t in THRESHOLDS:
            lines.append(row(f"core, score >= {t}", metrics(subset, core_predictions(core, t))))
        lines.append("")

    agree = [c for c in cases if port[c["id"]]["pcode"] == hdx[c["id"]]]
    lines += [f"### TS hdx port vs Python hdx: {len(agree)}/{len(cases)} agree", ""]
    for c in [c for c in cases if port[c["id"]]["pcode"] != hdx[c["id"]]][:errors]:
        lines.append(f"- {c['id']} {c['input']!r}: python={hdx[c['id']]} ts={port[c['id']]['pcode']}")
    lines.append("")

    by_noise = _group(cases, "noise")
    lines += ["### Accuracy by noise type (core at default threshold 80)", "", "| noise | n | hdx | core |", "|---|---|---|---|"]
    core80 = core_predictions(core, 80)
    for noise, subset in sorted(by_noise.items()):
        lines.append(f"| {noise} | {len(subset)} | {metrics(subset, hdx).accuracy:.3f} | {metrics(subset, core80).accuracy:.3f} |")
    lines.append("")

    if errors:
        lines += ["### Core errors (threshold 80)", ""]
        wrong = [c for c in cases if not is_correct(c["expected"], core80[c["id"]])]
        for c in wrong[:errors]:
            r = core[c["id"]]
            top = ", ".join(f"{x['pcode']} {x['name']} {x['score']}" for x in r["candidates"][:3])
            lines.append(
                f"- {c['id']} [{c['noise']}] {c['input']!r} parent={c.get('parent')} expected={c['expected']} "
                f"got={r['pcode']} {r['status']}/{r['method']} {r['score']} | hdx={hdx[c['id']]} | {top}"
            )
        lines.append(f"\n{len(wrong)} core errors in total")
    return "\n".join(lines)


def _group(cases: list[dict], key: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in cases:
        out.setdefault(str(c.get(key)), []).append(c)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fixtures", type=Path, default=FIXTURES_DIR)
    parser.add_argument("--sets", nargs="+", default=["synthetic", "curated"])
    parser.add_argument("--errors", type=int, default=20, help="list this many errors")
    parser.add_argument("--out", type=Path, help="also write the report here")
    args = parser.parse_args(argv)

    cases = load_cases(args.fixtures, tuple(args.sets))
    if not cases:
        raise SystemExit("no cases found")
    payloads = load_payloads(args.fixtures)
    oracle = Oracle(payloads)
    hdx = {c["id"]: oracle.match(c) for c in cases}
    data_dir = args.fixtures / "data"
    port = run_cli(cases, data_dir, "hdx")
    core = run_cli(cases, data_dir, "core")
    text = report(cases, hdx, port, core, args.errors)
    print(text)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(f"\nnoise mix: {dict(Counter(c['noise'] for c in cases))}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
