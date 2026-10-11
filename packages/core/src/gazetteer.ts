import { normalise, skeleton, stripArticles, stripLevelWords, trigrams } from "./text.js";

/** One row of a country file: [p-code, name, parent p-code, admin level]. */
export type UnitRow = [pcode: string, name: string, parent: string, level: number];

/** A per-country file as written by data-build/split.py. */
export interface CountryData {
  format: number;
  iso3: string;
  name: string;
  version: string;
  validFrom: string;
  /** [country, adm1, adm2 ...] p-code lengths; "" is unknown, "2|3" lists alternatives. */
  lengths: string[] | null;
  units: UnitRow[];
}

export interface Unit {
  pcode: string;
  name: string;
  parent: string;
  level: number;
  /** Position in the country file, used to break ties the same way every time. */
  order: number;
}

/** Matching keys derived from a name. */
export interface Keys {
  norm: string;
  /** norm without admin-level words */
  stripped: string;
  /** stripped without Arabic articles */
  bare: string;
  skel: string;
}

export function keysOf(text: string): Keys {
  const norm = normalise(text);
  const stripped = stripLevelWords(norm);
  const bare = stripArticles(stripped);
  return { norm, stripped, bare, skel: skeleton(bare) };
}

const LINEAR_SCAN_MAX = 400;

/** A set of units that a search runs over: a whole level, or one parent's descendants. */
export class Scope {
  readonly units: Unit[];
  private readonly gazetteer: Gazetteer;
  private maps?: {
    norm: Map<string, Unit[]>;
    stripped: Map<string, Unit[]>;
    bare: Map<string, Unit[]>;
    skel: Map<string, Unit[]>;
  };
  private grams?: Map<string, Int32Array>;
  private counts?: Uint16Array;

  constructor(gazetteer: Gazetteer, units: Unit[]) {
    this.gazetteer = gazetteer;
    this.units = units;
  }

  keys(unit: Unit): Keys {
    return this.gazetteer.keys(unit);
  }

  lookup(kind: keyof Keys, key: string): Unit[] {
    if (!key) return [];
    if (!this.maps) {
      const maps = { norm: new Map(), stripped: new Map(), bare: new Map(), skel: new Map() };
      for (const unit of this.units) {
        const k = this.keys(unit);
        if (!k.norm) continue;
        for (const kind of ["norm", "stripped", "bare", "skel"] as const) push(maps[kind], k[kind], unit);
      }
      this.maps = maps;
    }
    return this.maps[kind].get(key) ?? [];
  }

  /** Units likely to be similar to the query, best first. All units for small scopes. */
  candidates(queries: string[], limit: number): Unit[] {
    if (this.units.length <= LINEAR_SCAN_MAX) return this.units;
    const grams = this.gramIndex();
    const postings = [...new Set(queries.flatMap(trigrams))]
      .map((g) => grams.get(g))
      .filter((p): p is Int32Array => !!p)
      .sort((a, b) => a.length - b.length);
    // Trigrams shared by many units say little and cost most; skip the commonest
    // once the rarer ones have been counted.
    const common = Math.max(200, this.units.length / 20);
    const counts = (this.counts ??= new Uint16Array(this.units.length));
    const touched: number[] = [];
    postings.forEach((list, n) => {
      if (n >= 3 && list.length > common) return;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (counts[i]++ === 0) touched.push(i);
      }
    });
    touched.sort((a, b) => counts[b] - counts[a] || a - b);
    const out = touched.slice(0, limit).map((i) => this.units[i]);
    for (const i of touched) counts[i] = 0;
    return out;
  }

  private gramIndex(): Map<string, Int32Array> {
    if (!this.grams) {
      const lists = new Map<string, number[]>();
      this.units.forEach((unit, i) => {
        const k = this.keys(unit);
        for (const g of new Set([...trigrams(k.norm), ...trigrams(k.bare)])) push(lists, g, i);
      });
      this.grams = new Map([...lists].map(([g, list]) => [g, Int32Array.from(list)]));
    }
    return this.grams;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Indexes one country's units for lookups by level, p-code and parent. */
export class Gazetteer {
  readonly data: CountryData;
  readonly iso3: string;
  readonly version: string;
  readonly units: Unit[];
  readonly levels: number[];
  private readonly byLevel = new Map<number, Unit[]>();
  private readonly byPcode = new Map<string, Unit[]>();
  private readonly byParent = new Map<string, Unit[]>();
  private readonly keyCache = new Map<Unit, Keys>();
  private readonly scopes = new Map<string, Scope>();

  constructor(data: CountryData) {
    this.data = data;
    this.iso3 = data.iso3.toUpperCase();
    this.version = data.version;
    this.units = data.units.map(([pcode, name, parent, level], order) => ({ pcode, name, parent, level, order }));
    for (const unit of this.units) {
      push(this.byLevel, unit.level, unit);
      push(this.byPcode, unit.pcode.toUpperCase(), unit);
      push(this.byParent, `${unit.level}|${unit.parent.toUpperCase()}`, unit);
    }
    this.levels = [...this.byLevel.keys()].sort((a, b) => a - b);
  }

  keys(unit: Unit): Keys {
    let k = this.keyCache.get(unit);
    if (!k) {
      k = keysOf(unit.name);
      this.keyCache.set(unit, k);
    }
    return k;
  }

  atLevel(level: number): Unit[] {
    return this.byLevel.get(level) ?? [];
  }

  /** Units with this p-code (case-insensitive). MMR reuses some p-codes across levels. */
  byCode(pcode: string): Unit[] {
    return this.byPcode.get(pcode.trim().toUpperCase()) ?? [];
  }

  unit(pcode: string, level?: number): Unit | undefined {
    const units = this.byCode(pcode);
    return level === undefined ? units[0] : units.find((u) => u.level === level);
  }

  parentOf(unit: Unit): Unit | undefined {
    return unit.level > 1 ? this.unit(unit.parent, unit.level - 1) : undefined;
  }

  /** P-codes of a unit's ancestors, nearest first. */
  ancestors(unit: Unit): Unit[] {
    const out: Unit[] = [];
    for (let p = this.parentOf(unit); p; p = this.parentOf(p)) out.push(p);
    return out;
  }

  /** Units at a level, optionally restricted to the descendants of an ancestor unit. */
  scope(level: number, ancestor?: Unit): Scope {
    const key = ancestor ? `${level}|${ancestor.level}|${ancestor.pcode}` : `${level}`;
    let scope = this.scopes.get(key);
    if (!scope) {
      let units = this.atLevel(level);
      if (ancestor) {
        units = [ancestor];
        for (let l = ancestor.level + 1; l <= level; l++) units = units.flatMap((u) => this.children(u, l));
        units.sort((a, b) => a.order - b.order);
      }
      scope = new Scope(this, units);
      if (this.scopes.size > 5000) this.scopes.clear();
      this.scopes.set(key, scope);
    }
    return scope;
  }

  /** Units at `level` whose parent is `unit`. */
  children(unit: Unit, level = unit.level + 1): Unit[] {
    return this.byParent.get(`${level}|${unit.pcode.toUpperCase()}`) ?? [];
  }

  isDescendant(unit: Unit, ancestor: Unit): boolean {
    if (unit.level <= ancestor.level) return false;
    let u: Unit | undefined = unit;
    while (u && u.level > ancestor.level + 1) u = this.parentOf(u);
    return !!u && u.parent.toUpperCase() === ancestor.pcode.toUpperCase();
  }
}
