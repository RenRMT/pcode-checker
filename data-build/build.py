"""Full data build: fetch -> validate -> split.

Used by the monthly data-refresh workflow. Exits non-zero when validation
fails. Writes a Markdown summary (for the PR body) with --summary, and sets
`changed=true|false` in $GITHUB_OUTPUT when running in GitHub Actions.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from common import CACHE_DIR, DEFAULT_OUT, LENGTHS_RESOURCE, PCODES_RESOURCE, read_lengths, read_units
from fetch import fetch, read_index
from split import split
from validate import DEFAULT_MAX_DROP, validate


def set_output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true", help="rebuild even if HDX is unchanged")
    parser.add_argument("--offline", action="store_true", help="use the CSVs already in .cache")
    parser.add_argument("--max-drop", type=float, default=DEFAULT_MAX_DROP)
    parser.add_argument("--allow-drop", default="", help="comma-separated ISO3s allowed to shrink")
    parser.add_argument("--summary", type=Path, help="write a Markdown summary here")
    args = parser.parse_args(argv)

    previous = read_index(args.out)
    if args.offline:
        source = (previous or {}).get("source")
        pcodes, lengths = CACHE_DIR / PCODES_RESOURCE, CACHE_DIR / LENGTHS_RESOURCE
    else:
        result = fetch(previous, force=args.force)
        if not result.changed:
            print("HDX data unchanged; nothing to do")
            set_output("changed", "false")
            return 0
        source = result.source
        pcodes, lengths = result.paths[PCODES_RESOURCE], result.paths[LENGTHS_RESOURCE]

    units = read_units(pcodes)
    length_table = read_lengths(lengths)
    allow_drop = {x.strip().upper() for x in args.allow_drop.split(",") if x.strip()}
    report = validate(units, length_table, previous, args.max_drop, allow_drop)
    print(report.format())
    if not report.ok:
        if args.summary:
            write_summary(args.summary, report, [], None)
        set_output("changed", "false")
        return 1

    index, notes = split(units, length_table, source, args.out, previous)
    for note in notes:
        print(note)
    if args.summary:
        write_summary(args.summary, report, notes, index)
    set_output("changed", "true")
    return 0


def write_summary(path: Path, report, notes: list[str], index: dict | None) -> None:
    lines = ["## Global P-code List refresh", ""]
    if index:
        src = index.get("source", {})
        lines.append(f"Source last modified: `{src.get('lastModified')}`")
        lines.append(f"Countries: {len(index['countries'])}, rows: {sum(c['rows'] for c in index['countries'].values())}")
        lines.append("")
    if report.errors:
        lines += ["### Errors", *[f"- {e}" for e in report.errors], ""]
    lines += ["### Changes", *([f"- {n}" for n in notes] or ["- none"]), ""]
    if report.warnings:
        lines += ["### Warnings", *[f"- {w}" for w in report.warnings], ""]
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
