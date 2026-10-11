import { jaroWinkler, placeNameVeto, ratio, tokenSortRatio } from "./fuzz.js";
import { Gazetteer, keysOf, type CountryData, type Keys, type Scope, type Unit } from "./gazetteer.js";
import { convertPcodeLength, makePcodeSet, type PcodeSet } from "./pcode.js";
import { normalise } from "./text.js";

export type Status = "exact" | "fuzzy" | "ambiguous" | "none";

/** How a result was found. */
export type Method =
  | "alias"
  | "pcode"
  | "pcode-converted"
  | "exact"
  | "level-words"
  | "article"
  | "skeleton"
  | "fuzzy"
  | "none";

export interface Candidate {
  pcode: string;
  name: string;
  parent: string;
  level: number;
  score: number;
}

export interface MatchResult {
  input: string;
  /** Set when status is exact or fuzzy. */
  pcode: string | null;
  name: string | null;
  /** 0-100 similarity of the best candidate. */
  score: number;
  status: Status;
  method: Method;
  /** Best candidates, best first (up to maxCandidates). */
  candidates: Candidate[];
  /** The parent p-code the search was restricted to, if any. */
  parentPcode: string | null;
  /** Why the result is "none" or "ambiguous", for display. */
  note?: string;
}

/** A user-confirmed name -> p-code mapping, stored in the workbook. */
export interface Alias {
  name: string;
  pcode: string;
  level: number;
  /** Parent p-code the alias applies under; empty applies at the whole level. */
  parent?: string | null;
}

export interface MatchOptions {
  level: number;
  /** Parent p-code, or a parent name which is matched first at parentLevel. */
  parent?: string | null;
  /** Level of a parent given as a name. Defaults to level - 1. */
  parentLevel?: number;
  /** Minimum score for a fuzzy match, overriding the matcher's. */
  threshold?: number;
}

export interface MatcherConfig {
  /** Minimum score for a fuzzy match. Default 80. */
  threshold?: number;
  /** Scores closer than this to the best make the result ambiguous. Default 3. */
  ambiguityGap?: number;
  maxCandidates?: number;
  /** How many units the trigram index passes to the scorer. Default 60. */
  shortlist?: number;
  aliases?: Alias[];
  /** Similarity of two normalised names, 0-100. Defaults to similarity(). */
  scorer?: (a: string, b: string) => number;
}

const SKELETON_MIN_SCORE = 70;
const DEFAULTS = { threshold: 80, ambiguityGap: 3, maxCandidates: 5, shortlist: 60 };

/**
 * Similarity of two normalised names, 0-100: the best of token-sort ratio and
 * Jaro-Winkler, or 0 when hdx's place-name veto applies (the names share a word
 * but differ in another distinctive one, like "north kordofan" vs "south kordofan").
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (placeNameVeto(a, b) || numeralsDiffer(a, b)) return 0;
  const sorted = Math.max(ratio(a, b), tokenSortRatio(a, b));
  // Jaro-Winkler forgives typos near the end of long names, but rates short
  // names with a shared prefix too highly ("goudoumaria" vs "guma"), so it may
  // add at most JW_MAX_LIFT points over the edit-distance score.
  let score = Math.max(sorted, Math.min(jaroWinkler(a, b) * 100, sorted + JW_MAX_LIFT));
  const joined = ratio(a.replace(/ /g, ""), b.replace(/ /g, ""));
  if (joined >= 90) score = Math.max(score, joined);
  return score;
}

const JW_MAX_LIFT = 10;
const NUMERAL = /^(?:[ivx]+|\d+)$/;
// Words that tell neighbouring units apart: "Aba North" / "Aba South", "Upper Nile" / "Lower Nile".
const QUALIFIERS = new Set([
  "north", "south", "east", "west", "central", "centre", "center", "upper", "lower", "middle",
  "northern", "southern", "eastern", "western", "nord", "sud", "est", "ouest", "norte", "sur", "este", "oeste",
  "utara", "selatan", "timur", "barat", "tengah", "new", "old", "inner", "outer",
]);

function qualifiers(text: string): Set<string> {
  return new Set(text.split(" ").filter((w) => NUMERAL.test(w) || QUALIFIERS.has(w)));
}

/**
 * True when each name has a numeral or direction word the other lacks:
 * "Zinder I" vs "Zinder II", "Aba North" vs "Aba South". Such names are
 * different places however similar the strings are. "North" vs "North East"
 * is not a conflict, since a typo may have mangled "East".
 */
export function numeralsDiffer(a: string, b: string): boolean {
  const qa = qualifiers(a);
  const qb = qualifiers(b);
  return [...qa].some((w) => !qb.has(w)) && [...qb].some((w) => !qa.has(w));
}

function scoreKeys(q: Keys, u: Keys, scorer: (a: string, b: string) => number): number {
  let best = 0;
  for (const a of new Set([q.norm, q.stripped, q.bare])) {
    for (const b of new Set([u.norm, u.bare])) {
      best = Math.max(best, scorer(a, b));
      if (best === 100) return best;
    }
  }
  return best;
}

/** Matches names to p-codes for one country. */
export class Matcher {
  readonly gazetteer: Gazetteer;
  private readonly config: Required<Omit<MatcherConfig, "aliases" | "scorer">>;
  private readonly scorer: (a: string, b: string) => number;
  private aliasMap = new Map<string, string>();
  private readonly pcodeSets = new Map<number, PcodeSet>();
  private readonly cache = new Map<string, MatchResult>();

  constructor(country: CountryData | Gazetteer, config: MatcherConfig = {}) {
    this.gazetteer = country instanceof Gazetteer ? country : new Gazetteer(country);
    this.config = {
      threshold: config.threshold ?? DEFAULTS.threshold,
      ambiguityGap: config.ambiguityGap ?? DEFAULTS.ambiguityGap,
      maxCandidates: config.maxCandidates ?? DEFAULTS.maxCandidates,
      shortlist: config.shortlist ?? DEFAULTS.shortlist,
    };
    this.scorer = config.scorer ?? similarity;
    this.setAliases(config.aliases ?? []);
  }

  get iso3(): string {
    return this.gazetteer.iso3;
  }

  get version(): string {
    return this.gazetteer.version;
  }

  /** Replace the alias list. Aliases for other p-codes or levels are ignored. */
  setAliases(aliases: Alias[]): void {
    this.aliasMap = new Map();
    for (const alias of aliases) {
      const unit = this.gazetteer.unit(alias.pcode, alias.level);
      if (!unit) continue;
      const key = aliasKey(alias.level, alias.parent ?? "", normalise(alias.name));
      this.aliasMap.set(key, unit.pcode);
    }
    this.cache.clear();
  }

  match(input: unknown, options: MatchOptions): MatchResult {
    const text = input == null ? "" : String(input).trim();
    const parentText = options.parent == null ? "" : String(options.parent).trim();
    const threshold = options.threshold ?? this.config.threshold;
    const cacheKey = [options.level, parentText, options.parentLevel ?? "", threshold, text].join("\u0000");
    let result = this.cache.get(cacheKey);
    if (!result) {
      result = this.matchUncached(text, options.level, parentText, options.parentLevel ?? options.level - 1, threshold);
      if (this.cache.size > 50_000) this.cache.clear();
      this.cache.set(cacheKey, result);
    }
    return { ...result, input: text };
  }

  private matchUncached(text: string, level: number, parentText: string, parentLevel: number, threshold: number): MatchResult {
    if (!this.gazetteer.atLevel(level).length) {
      return none(text, null, `${this.iso3} has no admin level ${level}`);
    }
    if (!text) return none(text, null, "empty");

    let ancestor: Unit | undefined;
    if (parentText) {
      ancestor = this.resolveParent(parentText, level, parentLevel);
      if (!ancestor) return none(text, null, `parent "${parentText}" not found`);
    }
    const parentPcode = ancestor?.pcode ?? null;
    const q = keysOf(text);

    const aliased = this.aliasMap.get(aliasKey(level, parentPcode ?? "", q.norm)) ?? this.aliasMap.get(aliasKey(level, "", q.norm));
    if (aliased) {
      const unit = this.gazetteer.unit(aliased, level)!;
      return found(text, unit, 100, "exact", "alias", parentPcode, [this.candidate(unit, 100)]);
    }

    const pcodeResult = this.matchPcode(text, level, ancestor);
    if (pcodeResult) return { ...pcodeResult, parentPcode };

    if (!q.norm) return none(text, parentPcode, "no letters or digits");
    const scope = this.gazetteer.scope(level, ancestor);
    if (!scope.units.length) return none(text, parentPcode, "parent has no units at this level");

    const steps: [keyof Keys, string, Method][] = [
      ["norm", q.norm, "exact"],
      ["stripped", q.stripped, "level-words"],
      ["bare", q.bare, "article"],
    ];
    for (const [kind, key, method] of steps) {
      let units = scope.lookup(kind, key);
      if (!units.length && kind !== "norm") units = scope.lookup("norm", key);
      if (units.length === 1) return found(text, units[0], 100, "exact", method, parentPcode, [this.candidate(units[0], 100)]);
      if (units.length > 1) return this.ambiguous(text, units.map((u) => this.candidate(u, 100)), parentPcode, "same name");
    }

    // A shared skeleton is strong evidence, but short skeletons collide by chance.
    const skel = q.skel.length >= 3 ? this.rank(q, scope.lookup("skel", q.skel)) : [];
    if (skel.length && skel[0].score >= SKELETON_MIN_SCORE) {
      const scored = skel;
      const best = scored[0];
      const second = scored[1];
      if (!second || best.score - second.score >= this.config.ambiguityGap) {
        const unit = this.gazetteer.unit(best.pcode, level)!;
        const score = Math.max(best.score, threshold);
        return found(text, unit, score, "fuzzy", "skeleton", parentPcode, [{ ...best, score }, ...this.fuzzyCandidates(q, scope, unit)]);
      }
      return this.ambiguous(text, scored, parentPcode, "similar spellings");
    }

    const scored = this.rank(q, scope.candidates([q.norm, q.bare], this.config.shortlist));
    const best = scored[0];
    if (!best || best.score < threshold) {
      return { ...none(text, parentPcode, "no close match"), score: best?.score ?? 0, candidates: scored.slice(0, this.config.maxCandidates) };
    }
    const second = scored[1];
    if (second && best.score - second.score < this.config.ambiguityGap) {
      return this.ambiguous(text, scored, parentPcode, "close scores");
    }
    const unit = this.gazetteer.unit(best.pcode, level)!;
    return found(text, unit, best.score, "fuzzy", "fuzzy", parentPcode, scored.slice(0, this.config.maxCandidates));
  }

  /** P-code typed in place of a name: validate it, fixing length/prefix if needed. */
  private matchPcode(text: string, level: number, ancestor: Unit | undefined): MatchResult | null {
    const units = this.gazetteer.byCode(text);
    if (!units.length && !/^[A-Za-z]{2,3}\d+$/.test(text)) return null;
    let unit = units.find((u) => u.level === level);
    let method: Method = "pcode";
    if (!unit && !units.length) {
      const converted = convertPcodeLength(this.pcodeSet(level), text.toUpperCase());
      unit = converted ? this.gazetteer.unit(converted, level) : undefined;
      method = "pcode-converted";
    }
    if (!unit) {
      // Looks like a p-code but isn't one at this level. Names like "AB12" are rare,
      // so only stop here if it is a real p-code at another level.
      if (units.length) {
        return { ...none(text, null, `p-code is admin level ${units[0].level}`), candidates: [this.candidate(units[0], 100)] };
      }
      return null;
    }
    if (ancestor && !this.gazetteer.isDescendant(unit, ancestor)) {
      return { ...none(text, null, `p-code is not under ${ancestor.pcode}`), candidates: [this.candidate(unit, 100)] };
    }
    return found(text, unit, 100, "exact", method, null, [this.candidate(unit, 100)]);
  }

  private resolveParent(parentText: string, level: number, parentLevel: number): Unit | undefined {
    const byCode = this.gazetteer.byCode(parentText).filter((u) => u.level < level);
    if (byCode.length) return byCode.sort((a, b) => b.level - a.level)[0];
    if (parentLevel < 1) return undefined;
    const result = this.match(parentText, { level: parentLevel });
    return result.pcode ? this.gazetteer.unit(result.pcode, parentLevel) : undefined;
  }

  private pcodeSet(level: number): PcodeSet {
    let set = this.pcodeSets.get(level);
    if (!set) {
      set = makePcodeSet(this.iso3, this.gazetteer.data.lengths, level, this.gazetteer.atLevel(level).map((u) => u.pcode));
      this.pcodeSets.set(level, set);
    }
    return set;
  }

  private rank(q: Keys, units: Unit[]): Candidate[] {
    return units
      .map((u) => ({ unit: u, score: scoreKeys(q, this.gazetteer.keys(u), this.scorer) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.unit.order - b.unit.order)
      .map((x) => this.candidate(x.unit, x.score));
  }

  private fuzzyCandidates(q: Keys, scope: Scope, exclude: Unit): Candidate[] {
    return this.rank(q, scope.candidates([q.norm, q.bare], this.config.shortlist))
      .filter((c) => c.pcode !== exclude.pcode)
      .slice(0, this.config.maxCandidates - 1);
  }

  private ambiguous(text: string, candidates: Candidate[], parentPcode: string | null, why: string): MatchResult {
    const top = candidates.slice(0, Math.max(this.config.maxCandidates, candidates.filter((c) => c.score === 100).length));
    return {
      input: text,
      pcode: null,
      name: null,
      score: top[0]?.score ?? 0,
      status: "ambiguous",
      method: "none",
      candidates: top,
      parentPcode,
      note: parentPcode ? why : `${why}; add a parent column`,
    };
  }

  private candidate(unit: Unit, score: number): Candidate {
    return { pcode: unit.pcode, name: unit.name, parent: unit.parent, level: unit.level, score: round(score) };
  }
}

function aliasKey(level: number, parent: string, norm: string): string {
  return `${level}|${parent.toUpperCase()}|${norm}`;
}

function round(score: number): number {
  return Math.round(score * 10) / 10;
}

function found(
  input: string,
  unit: Unit,
  score: number,
  status: Status,
  method: Method,
  parentPcode: string | null,
  candidates: Candidate[],
): MatchResult {
  return { input, pcode: unit.pcode, name: unit.name, score: round(score), status, method, candidates, parentPcode };
}

function none(input: string, parentPcode: string | null, note: string): MatchResult {
  return { input, pcode: null, name: null, score: 0, status: "none", method: "none", candidates: [], parentPcode, note };
}
