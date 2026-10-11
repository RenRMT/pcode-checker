// Vectors recorded from hdx-python-utilities and rapidfuzz by data-build/oracle.py.
import { describe, expect, it } from "vitest";
import {
  defaultScorer,
  hdxNormalise,
  jaroWinkler,
  placeNameScorer,
  ratio,
  resolveNameParts,
  tokenSetRatio,
  tokenSortRatio,
} from "../src/index.js";
import { readJson } from "./helpers.js";

const vectors = readJson("scorers.json");
const CLOSE = 1e-6;

describe("hdxNormalise matches hdx.utilities.text.normalise", () => {
  it.each(vectors.normalise as [string, string][])("%j", (input, expected) => {
    expect(hdxNormalise(input)).toBe(expected);
  });
});

describe("scorers match rapidfuzz / hdx", () => {
  const pairs = vectors.pairs as Record<string, any>[];
  it(`agree on ${pairs.length} pairs`, () => {
    for (const p of pairs) {
      const ctx = `${JSON.stringify(p.a)} vs ${JSON.stringify(p.b)}`;
      expect(ratio(p.a, p.b), `ratio ${ctx}`).toBeCloseTo(p.ratio, 5);
      expect(tokenSortRatio(p.a, p.b), `token_sort ${ctx}`).toBeCloseTo(p.token_sort_ratio, 5);
      expect(tokenSetRatio(p.a, p.b), `token_set ${ctx}`).toBeCloseTo(p.token_set_ratio, 5);
      expect(Math.abs(jaroWinkler(p.a, p.b) - p.jaro_winkler), `jw ${ctx}`).toBeLessThan(CLOSE);
      expect(defaultScorer(p.a, p.b), `default ${ctx}`).toBeCloseTo(p.default_scorer, 5);
      expect(placeNameScorer(p.a, p.b), `place ${ctx}`).toBeCloseTo(p.place_name_scorer, 5);
    }
  });
});

describe("resolveNameParts matches hdx", () => {
  it.each(vectors.resolve_name_parts as any[])("$name", ({ name, ignore, lookup, result }) => {
    expect(resolveNameParts(name, new Map(Object.entries(lookup)), ignore)).toEqual(result);
  });
});
