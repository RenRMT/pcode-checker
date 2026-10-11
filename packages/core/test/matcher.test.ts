import { describe, expect, it } from "vitest";
import {
  Gazetteer,
  Matcher,
  normalise,
  numeralsDiffer,
  similarity,
  skeleton,
  stripLevelWords,
  type CountryData,
} from "../src/index.js";
import { countries } from "./helpers.js";

const { SYR, NGA } = countries();

const TOY: CountryData = {
  format: 1,
  iso3: "XXX",
  name: "Testland",
  version: "v01",
  validFrom: "2026-01-01",
  lengths: ["2", "2", "2", "2"],
  units: [
    ["XX01", "North", "XXX", 1],
    ["XX02", "South", "XXX", 1],
    ["XX0101", "Riverside", "XX01", 2],
    ["XX0201", "Riverside", "XX02", 2],
    ["XX0202", "Hilltop", "XX02", 2],
    ["XX010101", "Mill", "XX0101", 3],
    ["XX020101", "Mill", "XX0201", 3],
    ["XX020201", "القاهرة", "XX0202", 3],
    ["XX020202", "", "XX0202", 3],
  ],
};

describe("normalise", () => {
  it.each([
    ["Tillabéri", "tillaberi"],
    ["Ma'arrat An-Nu'man", "maarrat an numan"],
    ["St. Louis", "saint louis"],
    ["Zinder 2", "zinder ii"],
    ["Straße", "strasse"],
    ["القاهرة", "القاهرة"],
    ["  --  ", ""],
  ])("%s -> %s", (input, expected) => expect(normalise(input)).toBe(expected));

  it("strips level words but never to nothing", () => {
    expect(stripLevelWords("damascus governorate")).toBe("damascus");
    expect(stripLevelWords("governorate of damascus")).toBe("damascus");
    expect(stripLevelWords("kano state")).toBe("kano");
    expect(stripLevelWords("state")).toBe("state");
  });

  it("gives transliteration variants the same skeleton", () => {
    expect(skeleton("deir ez zor")).toBe(skeleton("dayr az zawr"));
    expect(skeleton("al hasakeh")).toBe(skeleton("hassaka"));
    expect(skeleton("lattakia")).toBe(skeleton("latakia"));
    expect(skeleton("damascus")).not.toBe(skeleton("homs"));
  });
});

describe("similarity", () => {
  it("vetoes different numerals and distinguishing words", () => {
    expect(numeralsDiffer("zinder i", "zinder ii")).toBe(true);
    expect(similarity("zinder i", "zinder ii")).toBe(0);
    expect(similarity("aba north", "aba south")).toBe(0);
    expect(similarity("damascus", "damascsu")).toBeGreaterThan(85);
  });
});

describe("Matcher", () => {
  const m = new Matcher(TOY);

  it("returns the full result shape", () => {
    const r = m.match("north", { level: 1 });
    expect(r).toMatchObject({ input: "north", pcode: "XX01", name: "North", score: 100, status: "exact", method: "exact" });
    expect(r.candidates[0].pcode).toBe("XX01");
  });

  it("flags duplicate names without a parent and resolves them with one", () => {
    const r = m.match("Riverside", { level: 2 });
    expect(r.status).toBe("ambiguous");
    expect(r.candidates.map((c) => c.pcode).sort()).toEqual(["XX0101", "XX0201"]);
    expect(m.match("Riverside", { level: 2, parent: "XX02" }).pcode).toBe("XX0201");
    expect(m.match("Riverside", { level: 2, parent: "south" }).pcode).toBe("XX0201");
  });

  it("restricts deeper levels to any ancestor", () => {
    expect(m.match("Mill", { level: 3 }).status).toBe("ambiguous");
    expect(m.match("Mill", { level: 3, parent: "XX02" }).pcode).toBe("XX020101");
    expect(m.match("Mill", { level: 3, parent: "XX0101" }).pcode).toBe("XX010101");
  });

  it("matches non-Latin names that hdx's normalise would erase", () => {
    expect(m.match("القاهرة", { level: 3 }).pcode).toBe("XX020201");
  });

  it("uses aliases before anything else, scoped by parent", () => {
    const withAliases = new Matcher(TOY, {
      aliases: [
        { name: "Upper Hill", pcode: "XX0202", level: 2 },
        { name: "Old Mill", pcode: "XX020101", level: 3, parent: "XX0201" },
        { name: "Ignored", pcode: "NOPE", level: 2 },
      ],
    });
    expect(withAliases.match("upper hill", { level: 2 })).toMatchObject({ pcode: "XX0202", method: "alias", status: "exact" });
    expect(withAliases.match("Old Mill", { level: 3, parent: "XX0201" }).method).toBe("alias");
    expect(withAliases.match("Old Mill", { level: 3 }).method).not.toBe("alias");
    withAliases.setAliases([]);
    expect(withAliases.match("upper hill", { level: 2 }).method).not.toBe("alias");
  });

  it("validates p-codes, including other levels and parents", () => {
    expect(m.match("xx0202", { level: 2 })).toMatchObject({ pcode: "XX0202", method: "pcode" });
    expect(m.match("XX0202", { level: 1 })).toMatchObject({ pcode: null, status: "none" });
    expect(m.match("XX0202", { level: 2, parent: "XX01" })).toMatchObject({ pcode: null, status: "none" });
    expect(m.match("XXX02", { level: 1 })).toMatchObject({ pcode: "XX02", method: "pcode-converted" });
  });

  it("explains empty and unmatched input", () => {
    expect(m.match(null, { level: 1 })).toMatchObject({ status: "none", note: "empty" });
    expect(m.match("Atlantis", { level: 1 }).status).toBe("none");
    expect(m.match("North", { level: 9 }).note).toMatch(/no admin level 9/);
  });

  it("ranks fuzzy matches with real data", () => {
    const syr = new Matcher(SYR);
    const r = syr.match("Damascsu", { level: 1 });
    expect(r).toMatchObject({ pcode: "SY01", status: "fuzzy" });
    expect(r.score).toBeGreaterThan(80);
    expect(r.score).toBeLessThan(100);
    expect(r.candidates.length).toBeGreaterThan(1);
  });
});

describe("Gazetteer", () => {
  it("indexes MMR-style p-codes reused across levels", () => {
    const g = new Gazetteer({
      ...TOY,
      units: [
        ["XX01", "North", "XXX", 1],
        ["XX01001", "Town", "XX01", 2],
        ["XX01001", "Town", "XX01001", 3],
      ],
    });
    expect(g.byCode("XX01001").map((u) => u.level)).toEqual([2, 3]);
    expect(g.scope(3, g.unit("XX01", 1)).units.map((u) => u.pcode)).toEqual(["XX01001"]);
  });

  it("finds all NGA LGAs under a state", () => {
    const g = new Gazetteer(NGA);
    const kano = g.unit("NG020", 1)!;
    expect(g.scope(2, kano).units.length).toBe(44);
  });
});
