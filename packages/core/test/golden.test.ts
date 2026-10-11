import { describe, expect, it } from "vitest";
import { Matcher, type MatchResult } from "../src/index.js";
import { caseSet, countries, readJson, type Case } from "./helpers.js";

const data = countries();
const matchers = Object.fromEntries(Object.entries(data).map(([iso3, d]) => [iso3, new Matcher(d)]));

function predict(c: Case): { predicted: string | null; result: MatchResult } {
  const result = matchers[c.iso3].match(c.input, { level: c.level, parent: c.parent });
  const predicted = result.status === "ambiguous" ? "AMBIGUOUS" : result.pcode;
  return { predicted, result };
}

function correct(expected: string | null, predicted: string | null): boolean {
  return expected === null ? predicted === null || predicted === "AMBIGUOUS" : predicted === expected;
}

describe("handwritten golden cases", () => {
  const cases = readJson<{ cases: Case[] }>("golden/handwritten.json").cases;
  it.each(cases)("$iso3 adm$level $input (parent $parent) -> $expected", (c) => {
    const { predicted, result } = predict(c);
    expect(predicted, JSON.stringify(result.candidates.slice(0, 3))).toBe(c.expected);
  });
});

describe("synthetic and curated cases: at least as good as hdx-python-country", () => {
  const all = [...caseSet("synthetic"), ...caseSet("curated")];
  for (const iso3 of Object.keys(data)) {
    const cases = all.filter((c) => c.iso3 === iso3);
    const oracle: Record<string, string | null> = readJson(`oracle/${iso3}.json`);
    it(`${iso3}: ${cases.length} cases`, () => {
      let core = 0;
      let hdx = 0;
      let coreWrong = 0;
      let hdxWrong = 0;
      for (const c of cases) {
        const { predicted } = predict(c);
        const h = oracle[c.id!] ?? null;
        core += +correct(c.expected, predicted);
        hdx += +correct(c.expected, h);
        if (predicted && predicted !== "AMBIGUOUS" && predicted !== c.expected) coreWrong++;
        if (h && h !== c.expected) hdxWrong++;
      }
      expect(core / cases.length).toBeGreaterThanOrEqual(0.98);
      expect(core).toBeGreaterThanOrEqual(hdx);
      expect(coreWrong).toBeLessThanOrEqual(hdxWrong);
    });
  }
});
