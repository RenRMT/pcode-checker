// Pure helpers shared by the task pane and custom functions. No Office APIs
// here, so they are unit tested in Node.

import type { Alias, MatchResult, Status } from "@pcode-checker/core";
import type { DataIndex } from "./data";

export const OUTPUT_HEADERS = ["pcode", "pcode_name", "pcode_score", "pcode_status"];
export const META_SHEET = "_pcode_meta";
export const META_HEADERS = ["iso3", "version", "valid_from", "stamped_at"];
export const ALIAS_SHEET = "_pcode_aliases";
export const ALIAS_HEADERS = ["iso3", "level", "parent", "name", "pcode", "pcode_name", "added_at"];

export const STATUS_COLOURS: Record<Status, string> = {
  exact: "#E2EFDA",
  fuzzy: "#FFF2CC",
  ambiguous: "#FCE4D6",
  none: "#F8CBAD",
};

export type Cell = string | number | boolean;

/** The four output cells for one result: p-code, matched name, score, status. */
export function outputRow(result: MatchResult | null): Cell[] {
  if (!result || !result.input) return ["", "", "", ""];
  return [result.pcode ?? "", result.name ?? "", result.score, result.status];
}

export function statusCounts(results: (MatchResult | null)[]): Record<Status, number> {
  const counts: Record<Status, number> = { exact: 0, fuzzy: 0, ambiguous: 0, none: 0 };
  for (const r of results) if (r && r.input) counts[r.status]++;
  return counts;
}

/** Indexes of rows a person should look at: ambiguous, unmatched, or low-scoring fuzzy. */
export function reviewQueue(results: (MatchResult | null)[], reviewBelow: number): number[] {
  const out: number[] = [];
  results.forEach((r, i) => {
    if (!r || !r.input) return;
    if (r.status === "ambiguous" || r.status === "none" || (r.status === "fuzzy" && r.score < reviewBelow)) out.push(i);
  });
  return out;
}

export interface MetaEntry {
  version: string;
  validFrom: string;
  stampedAt: string;
}

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** Read the _pcode_meta sheet (header row first). */
export function parseMeta(values: unknown[][]): Record<string, MetaEntry> {
  const out: Record<string, MetaEntry> = {};
  for (const row of values.slice(1)) {
    const iso3 = str(row[0]).toUpperCase();
    if (iso3) out[iso3] = { version: str(row[1]), validFrom: str(row[2]), stampedAt: str(row[3]) };
  }
  return out;
}

export function metaValues(meta: Record<string, MetaEntry>): string[][] {
  return [
    META_HEADERS,
    ...Object.keys(meta)
      .sort()
      .map((iso3) => [iso3, meta[iso3].version, meta[iso3].validFrom, meta[iso3].stampedAt]),
  ];
}

export interface Outdated {
  iso3: string;
  name: string;
  used: string;
  current: string;
}

/** Countries whose stamped version is older than the hosted one. */
export function outdated(meta: Record<string, MetaEntry>, index: DataIndex): Outdated[] {
  const out: Outdated[] = [];
  for (const [iso3, entry] of Object.entries(meta)) {
    const info = index.countries[iso3];
    if (info && entry.version && entry.version !== info.version) {
      out.push({ iso3, name: info.name, used: entry.version, current: info.version });
    }
  }
  return out.sort((a, b) => a.iso3.localeCompare(b.iso3));
}

export interface StoredAlias extends Alias {
  iso3: string;
}

/** Read the _pcode_aliases sheet (header row first). */
export function parseAliases(values: unknown[][]): StoredAlias[] {
  const out: StoredAlias[] = [];
  for (const row of values.slice(1)) {
    const iso3 = str(row[0]).toUpperCase();
    const level = Number(row[1]);
    const name = str(row[3]);
    const pcode = str(row[4]);
    if (iso3 && level && name && pcode) out.push({ iso3, level, parent: str(row[2]) || null, name, pcode });
  }
  return out;
}

export function aliasRow(alias: StoredAlias, pcodeName: string, when: Date): Cell[] {
  return [alias.iso3, alias.level, alias.parent ?? "", alias.name, alias.pcode, pcodeName, when.toISOString().slice(0, 19)];
}

export function aliasesFor(aliases: StoredAlias[], iso3: string): Alias[] {
  return aliases.filter((a) => a.iso3 === iso3.toUpperCase());
}

/** Guess the country of a p-code from its letters ("SY0102" -> SYR). */
export function countryForPcode(index: DataIndex, pcode: string): string | null {
  const letters = /^[A-Za-z]+/.exec(pcode.trim())?.[0]?.toUpperCase();
  if (!letters) return null;
  if (index.countries[letters]) return letters;
  let best: string | null = null;
  let bestLength = 0;
  for (const [iso3, info] of Object.entries(index.countries)) {
    const prefix = info.prefix?.toUpperCase();
    if (prefix && letters.startsWith(prefix) && prefix.length > bestLength) {
      best = iso3;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Column letters for a 0-based column index: 0 -> A, 27 -> AB. */
export function columnLetter(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** True if the four cells after a header look like a previous run's output. */
export function isOutputHeader(row: unknown[]): boolean {
  return OUTPUT_HEADERS.every((h, i) => str(row[i]).toLowerCase() === h);
}
