"""Validate the Global P-code List before it is split and published.

Errors stop the build. Warnings are reported (and end up in the refresh PR)
but don't stop it, because the published data has known quirks:
- some units have no name (KGZ adm3, MMR and LKA adm4);
- MMR repeats adm2 p-codes at adm3, whose length is 0 in the lengths table.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from common import CACHE_DIR, LENGTHS_RESOURCE, PCODES_RESOURCE, Unit, expected_lengths, read_lengths, read_units

DEFAULT_MAX_DROP = 0.10


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def format(self) -> str:
        lines = [f"ERROR: {e}" for e in self.errors]
        lines += [f"warning: {w}" for w in self.warnings]
        return "\n".join(lines) if lines else "all checks passed"


def validate(
    units: list[Unit],
    lengths: dict[str, list[str]],
    previous_index: dict | None = None,
    max_drop: float = DEFAULT_MAX_DROP,
    allow_drop: set[str] = frozenset(),
) -> Report:
    report = Report()
    if not units:
        report.errors.append("no rows")
        return report
    check_unique(units, report)
    check_parents(units, report)
    check_lengths(units, lengths, report)
    check_names(units, report)
    check_versions(units, report)
    if previous_index:
        check_counts(units, previous_index, max_drop, allow_drop, report)
    return report


def check_unique(units: list[Unit], report: Report) -> None:
    by_level = Counter((u.iso3, u.level, u.pcode) for u in units)
    dupes = sorted(key for key, n in by_level.items() if n > 1)
    for iso3, level, pcode in dupes[:20]:
        report.errors.append(f"{iso3} adm{level}: p-code {pcode} is not unique")
    if len(dupes) > 20:
        report.errors.append(f"... and {len(dupes) - 20} more duplicate p-codes")

    levels_of = defaultdict(set)
    for u in units:
        levels_of[u.pcode].add(u.level)
    shared = Counter(u.iso3 for u in units if u.level == min(levels_of[u.pcode]) and len(levels_of[u.pcode]) > 1)
    for iso3, n in sorted(shared.items()):
        report.warnings.append(f"{iso3}: {n} p-codes are reused at more than one admin level")


def check_parents(units: list[Unit], report: Report) -> None:
    known = {(u.iso3, u.level, u.pcode) for u in units}
    missing = Counter()
    examples = {}
    for u in units:
        if u.level == 1:
            ok = u.parent.upper() == u.iso3
        else:
            ok = (u.iso3, u.level - 1, u.parent) in known
        if not ok:
            missing[(u.iso3, u.level)] += 1
            examples.setdefault((u.iso3, u.level), f"{u.pcode} -> {u.parent}")
    for (iso3, level), n in sorted(missing.items()):
        report.errors.append(
            f"{iso3} adm{level}: {n} units have no parent at adm{level - 1} (e.g. {examples[(iso3, level)]})"
        )


def check_lengths(units: list[Unit], lengths: dict[str, list[str]], report: Report) -> None:
    no_lengths = sorted({u.iso3 for u in units} - set(lengths))
    for iso3 in no_lengths:
        report.warnings.append(f"{iso3}: not in the p-code lengths table")
    bad = Counter()
    examples = {}
    for u in units:
        if u.iso3 not in lengths:
            continue
        expected = expected_lengths(lengths[u.iso3], u.level)
        if expected is not None and len(u.pcode) not in expected:
            bad[(u.iso3, u.level)] += 1
            examples.setdefault((u.iso3, u.level), (u.pcode, sorted(expected)))
    for (iso3, level), n in sorted(bad.items()):
        pcode, expected = examples[(iso3, level)]
        report.errors.append(
            f"{iso3} adm{level}: {n} p-codes have the wrong length (e.g. {pcode}, expected {expected})"
        )


def check_names(units: list[Unit], report: Report) -> None:
    empty = Counter((u.iso3, u.level) for u in units if not u.name)
    for (iso3, level), n in sorted(empty.items()):
        report.warnings.append(f"{iso3} adm{level}: {n} units have no name")


def check_versions(units: list[Unit], report: Report) -> None:
    versions = defaultdict(set)
    for u in units:
        versions[u.iso3].add((u.version, u.valid_from))
    for iso3, found in sorted(versions.items()):
        if len(found) > 1:
            report.errors.append(f"{iso3}: more than one version in one file: {sorted(found)}")


def check_counts(
    units: list[Unit],
    previous_index: dict,
    max_drop: float,
    allow_drop: set[str],
    report: Report,
) -> None:
    counts = Counter(u.iso3 for u in units)
    for iso3, info in sorted(previous_index.get("countries", {}).items()):
        before = info.get("rows", 0)
        after = counts.get(iso3, 0)
        if before and after < before * (1 - max_drop):
            message = f"{iso3}: row count dropped from {before} to {after}"
            if iso3 in allow_drop:
                report.warnings.append(message + " (allowed)")
            else:
                report.errors.append(message)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pcodes", type=Path, default=CACHE_DIR / PCODES_RESOURCE)
    parser.add_argument("--lengths", type=Path, default=CACHE_DIR / LENGTHS_RESOURCE)
    args = parser.parse_args(argv)
    report = validate(read_units(args.pcodes), read_lengths(args.lengths))
    print(report.format())
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
