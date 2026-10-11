// Port of hdx.location.adminlevel.AdminLevel.get_pcode with its default
// matcher (RapidFuzzMatcher + place_name_scorer), for one country and level.
// It exists to check the port against hdx-python-country on shared fixtures;
// the add-in uses Matcher (matcher.ts), which builds on this behaviour.

import { placeNameScorer, ratio } from "./fuzz.js";
import type { CountryData } from "./gazetteer.js";
import { convertPcodeLength, looksLikePcode, makePcodeSet, type PcodeSet } from "./pcode.js";
import { hdxNormalise } from "./text.js";

export interface HdxConfig {
  /** {"NAME" | "ISO3|NAME" | "PARENT|NAME": pcode} */
  adminNameMappings?: Record<string, string>;
  /** {"TEXT" | "ISO3|TEXT" | "PARENT|TEXT": replacement}, applied to normalised names */
  adminNameReplacements?: Record<string, string>;
  /** ["name" | "ISO3|name" | "PARENT|name"]: names never to fuzzy match */
  adminFuzzyDont?: string[];
}

const LIST_SEPARATORS = /\s*(?:[,;/:&\n]|\s(?:and|et)\s)\s*/i;
const HYPHEN = /\s*-\s*/;

function splitName(name: string, separators: RegExp): string[] {
  return name
    .split(separators)
    .map((p) => p.trim())
    .filter((p) => hdxNormalise(p));
}

/** Port of hdx.utilities.matching.resolve_name_parts. Returns [code, isList]. */
export function resolveNameParts(
  name: string,
  nameToCode: Map<string, string>,
  ignore?: string | null,
): [string | null, boolean] {
  let parts = splitName(name, LIST_SEPARATORS);
  if (parts.length > 2) return [null, true];
  if (parts.length < 2) {
    parts = splitName(name, HYPHEN);
    if (parts.length !== 2) return [null, false];
  }
  let normalised = parts.map(hdxNormalise);
  if (ignore != null && normalised.includes(ignore)) {
    const index = 1 - normalised.indexOf(ignore);
    parts = [parts[index]];
    normalised = [normalised[index]];
  }
  const codes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = nameToCode.get(parts[i]) ?? nameToCode.get(normalised[i]);
    if (!code) return [null, false];
    codes.push(code);
  }
  const code = codes[0];
  if (codes.length === 1) return [code, false];
  const other = codes[1];
  if (code === other || other.startsWith(`${code}-`)) return [other, false];
  if (code.startsWith(`${other}-`)) return [code, false];
  return [null, true];
}

/** Port of hdx.utilities.matching.multiple_replace. */
export function multipleReplace(text: string, replacements: Record<string, string>): string {
  const keys = Object.keys(replacements);
  if (!keys.length) return text;
  const escaped = keys
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(escaped.join("|"), "gs"), (m) => replacements[m]);
}

type Transform = (name: string) => string | null;

function alTransform1(name: string): string | null {
  const prefix = name.slice(0, 3);
  if (prefix === "al ") return `ad ${name.slice(3)}`;
  if (prefix === "ad ") return `al ${name.slice(3)}`;
  return null;
}

function alTransform2(name: string): string | null {
  const prefix = name.slice(0, 3);
  return prefix === "al " || prefix === "ad " ? name.slice(3) : null;
}

/** Port of RapidFuzzMatcher.match with place_name_scorer. Returns an index or null. */
export function rapidFuzzMatch(
  possibleNames: string[],
  name: string,
  alternativeName: string | null,
  transforms: Transform[],
  threshold = 65,
): number | null {
  let best: [number, number] | null = null;
  let index: number | null = null;
  const names = [name.toLowerCase()];
  if (alternativeName) names.push(alternativeName.toLowerCase());
  const all: Transform[] = [(x) => x, ...transforms];
  possibleNames.forEach((possible, i) => {
    for (const transform of all) {
      let transformed = transform(possible);
      if (!transformed) continue;
      transformed = transformed.toLowerCase();
      for (const query of names) {
        const score: [number, number] = [placeNameScorer(query, transformed), ratio(query, transformed)];
        if (!best || score[0] > best[0] || (score[0] === best[0] && score[1] > best[1])) {
          best = score;
          index = i;
        }
      }
    }
  });
  if (!best || (best as [number, number])[0] < threshold) return null;
  return index;
}

export interface HdxGetPcodeOptions {
  parent?: string | null;
  fuzzyMatch?: boolean;
  fuzzyLength?: number;
}

/** AdminLevel for one country and admin level. */
export class HdxAdminLevel {
  readonly iso3: string;
  readonly level: number;
  private readonly pcodeSet: PcodeSet;
  private readonly pcodeToName = new Map<string, string>();
  private readonly pcodeToParent = new Map<string, string>();
  private readonly nameToPcode = new Map<string, string>();
  private readonly nameParentToPcode = new Map<string, Map<string, string>>();
  private readonly parentPcodeToName = new Map<string, string>();
  private readonly config: Required<HdxConfig>;

  constructor(data: CountryData, level: number, config: HdxConfig = {}) {
    this.iso3 = data.iso3.toUpperCase();
    this.level = level;
    this.config = {
      adminNameMappings: config.adminNameMappings ?? {},
      adminNameReplacements: config.adminNameReplacements ?? {},
      adminFuzzyDont: config.adminFuzzyDont ?? [],
    };
    const pcodes: string[] = [];
    for (const [rawPcode, name, parent, unitLevel] of data.units) {
      const pcode = rawPcode.toUpperCase();
      if (unitLevel !== level) {
        if (unitLevel === level - 1 && name) this.parentPcodeToName.set(pcode, hdxNormalise(name));
        continue;
      }
      pcodes.push(pcode);
      this.pcodeToName.set(pcode, name ?? "");
      if (!name) continue;
      const normalised = hdxNormalise(name);
      this.nameToPcode.set(normalised, pcode);
      let byParent = this.nameParentToPcode.get(parent);
      if (!byParent) this.nameParentToPcode.set(parent, (byParent = new Map()));
      byParent.set(normalised, pcode);
      this.pcodeToParent.set(pcode, parent);
    }
    this.pcodeSet = makePcodeSet(this.iso3, data.lengths, level, pcodes);
  }

  private relevant(key: string, parent: string | null): string | null {
    if (!key.includes("|")) return key;
    const [prefix, name] = key.split("|");
    if (parent && prefix === parent) return name;
    if (prefix === this.iso3) return name;
    return null;
  }

  private nameReplacements(parent: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.config.adminNameReplacements)) {
      const name = this.relevant(key, parent);
      if (name !== null && !(name in out)) out[name] = value;
    }
    return out;
  }

  private fuzzyDont(parent: string | null): string[] {
    const out: string[] = [];
    for (const value of this.config.adminFuzzyDont) {
      const name = this.relevant(value, parent);
      if (name !== null && !out.includes(name)) out.push(name);
    }
    return out;
  }

  private nameMappedPcode(name: string, parent: string | null): string | undefined {
    const m = this.config.adminNameMappings;
    let pcode = parent ? (m[`${parent}|${name}`] ?? m[`${this.iso3}|${name}`]) : m[`${this.iso3}|${name}`];
    return pcode ?? m[name];
  }

  /** Port of AdminLevel.get_pcode. Returns [pcode, exact]. */
  getPcode(name: string, options: HdxGetPcodeOptions = {}): [string | null, boolean] {
    const { fuzzyMatch = true, fuzzyLength = 4 } = options;
    const parent = options.parent || null;
    if (parent) {
      const pcode = this.config.adminNameMappings[`${parent}|${name}`];
      if (pcode && this.pcodeToName.has(pcode)) return [pcode, true];
    }
    const mapped = this.nameMappedPcode(name, parent);
    if (mapped && this.pcodeToName.has(mapped)) {
      if (!parent || this.pcodeToParent.get(mapped) === parent) return [mapped, true];
    }
    if (looksLikePcode(name)) {
      if (this.pcodeSet.pcodes.has(name.toUpperCase())) return [name, true];
      return [convertPcodeLength(this.pcodeSet, name.toUpperCase()), true];
    }
    const normalised = hdxNormalise(name);
    const lookup = parent ? this.nameParentToPcode.get(parent) : this.nameToPcode;
    const exact = lookup?.get(normalised);
    if (exact) return [exact, true];
    if (!fuzzyMatch || normalised.length < fuzzyLength) return [null, true];
    return [this.fuzzyPcode(name, normalised, parent), false];
  }

  private fuzzyPcode(name: string, normalised: string, parent: string | null): string | null {
    const nameToPcode = parent ? this.nameParentToPcode.get(parent) : this.nameToPcode;
    if (!nameToPcode || !nameToPcode.size) return null;
    const alt = multipleReplace(normalised, this.nameReplacements(parent));
    let pcode = nameToPcode.get(normalised) ?? nameToPcode.get(alt) ?? null;
    if (!pcode && this.fuzzyDont(parent).includes(name.toLowerCase())) return null;
    if (!pcode) {
      for (const [mapName, code] of nameToPcode) {
        if (mapName.includes(normalised)) {
          pcode = code;
          break;
        }
      }
      for (const [mapName, code] of nameToPcode) {
        if (mapName.includes(alt)) {
          pcode = code;
          break;
        }
      }
    }
    if (!pcode) {
      const [code, isList] = resolveNameParts(name, nameToPcode, parent ? this.parentPcodeToName.get(parent) : null);
      if (isList) return null;
      pcode = code;
    }
    if (!pcode) {
      const mapNames = [...nameToPcode.keys()];
      const index = rapidFuzzMatch(mapNames, normalised, alt, [alTransform1, alTransform2]);
      if (index === null) return null;
      pcode = nameToPcode.get(mapNames[index])!;
    }
    return pcode;
  }
}
