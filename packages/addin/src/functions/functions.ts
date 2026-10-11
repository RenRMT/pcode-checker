// Custom functions, in the PCODE namespace: =PCODE.GET(), =PCODE.NAME(),
// =PCODE.PARENT() and =PCODE.MATCH(). The JSDoc tags generate functions.json
// (custom-functions-metadata-plugin), which also registers each function.
// Excel names custom functions NAMESPACE.ID, so the plain lookup is PCODE.GET.

import type { Matcher, MatchResult } from "@pcode-checker/core";
import { countryForPcode } from "../shared/logic";
import { store } from "../shared/store";

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function fail(message: string, code = CustomFunctions.ErrorCode.notAvailable): never {
  throw new CustomFunctions.Error(code, message);
}

function checkLevel(level: number): number {
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1 || n > 5) fail("level must be 1-5", CustomFunctions.ErrorCode.invalidValue);
  return n;
}

async function matcherFor(iso3: string): Promise<Matcher> {
  const code = text(iso3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail("iso3 must be a 3-letter country code", CustomFunctions.ErrorCode.invalidValue);
  let matcher: Matcher;
  try {
    matcher = await store.matcher(code);
  } catch (err) {
    fail((err as Error).message);
  }
  const { index } = await store.index();
  const info = index.countries[code];
  if (info && matcher.version === info.version) store.stampLater(code, info.version, info.validFrom);
  return matcher;
}

async function lookup(name: unknown, iso3: string, level: number, parent: unknown): Promise<MatchResult> {
  const matcher = await matcherFor(iso3);
  return matcher.match(text(name), { level: checkLevel(level), parent: text(parent) || null });
}

/**
 * Looks up the p-code for a place name. Returns #N/A when there is no match
 * or the name is ambiguous.
 * @customfunction GET
 * @param name Place name, or a p-code to validate
 * @param iso3 ISO3 country code, e.g. "NGA"
 * @param level Admin level, 1-5
 * @param [parent] Parent p-code or name, for names that repeat within the country
 * @returns The p-code
 */
export async function getPcode(name: any, iso3: string, level: number, parent?: any): Promise<string> {
  const result = await lookup(name, iso3, level, parent);
  if (result.pcode) return result.pcode;
  fail(result.status === "ambiguous" ? `Ambiguous (${result.note})` : `No match${result.note ? ` (${result.note})` : ""}`);
}

/**
 * Looks up the place name for a p-code.
 * @customfunction NAME
 * @param pcode The p-code
 * @param [iso3] ISO3 country code. Worked out from the p-code if left out.
 * @returns The name
 */
export async function pcodeName(pcode: any, iso3?: string): Promise<string> {
  return (await findUnit(pcode, iso3)).name;
}

/**
 * Looks up the parent p-code of a p-code.
 * @customfunction PARENT
 * @param pcode The p-code
 * @param [iso3] ISO3 country code. Worked out from the p-code if left out.
 * @returns The parent p-code
 */
export async function pcodeParent(pcode: any, iso3?: string): Promise<string> {
  return (await findUnit(pcode, iso3)).parent;
}

async function findUnit(pcode: unknown, iso3?: string) {
  const code = text(pcode);
  if (!code) fail("empty p-code", CustomFunctions.ErrorCode.invalidValue);
  let country = text(iso3).toUpperCase();
  if (!country) {
    const { index } = await store.index();
    country = countryForPcode(index, code) ?? fail("can't tell the country; add iso3");
  }
  const matcher = await matcherFor(country);
  // MMR reuses adm2 p-codes at adm3; the higher level is the one people mean.
  return matcher.gazetteer.unit(code) ?? fail(`unknown p-code for ${country}`);
}

/**
 * Matches a place name and spills four cells: p-code, matched name, score
 * (0-100) and status (exact, fuzzy, ambiguous or none).
 * @customfunction MATCH
 * @param name Place name, or a p-code to validate
 * @param iso3 ISO3 country code, e.g. "NGA"
 * @param level Admin level, 1-5
 * @param [parent] Parent p-code or name, for names that repeat within the country
 * @returns p-code, name, score, status
 */
export async function pcodeMatch(name: any, iso3: string, level: number, parent?: any): Promise<any[][]> {
  const r = await lookup(name, iso3, level, parent);
  return [[r.pcode ?? "", r.name ?? "", r.score, r.status]];
}
