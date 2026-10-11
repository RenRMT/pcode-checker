import { describe, expect, it } from "vitest";
import type { MatchResult } from "@pcode-checker/core";
import type { DataIndex } from "../src/shared/data";
import {
  ALIAS_HEADERS,
  aliasesFor,
  aliasRow,
  columnLetter,
  countryForPcode,
  isOutputHeader,
  META_HEADERS,
  metaValues,
  outdated,
  outputRow,
  parseAliases,
  parseMeta,
  reviewQueue,
  statusCounts,
} from "../src/shared/logic";

function result(input: string, status: MatchResult["status"], score = 100, pcode: string | null = "XX01"): MatchResult {
  return { input, pcode, name: pcode ? "North" : null, score, status, method: "exact", candidates: [], parentPcode: null };
}

const index = {
  countries: {
    SYR: { name: "Syria", version: "v02", validFrom: "2020-12-17", prefix: "SY", versions: [] },
    NGA: { name: "Nigeria", version: "v02", validFrom: "2026-01-01", prefix: "NG", versions: [] },
    MMR: { name: "Myanmar", version: "v01", validFrom: "2024-02-15", prefix: "MMR", versions: [] },
  },
} as unknown as DataIndex;

describe("output", () => {
  it("writes four cells per row and blanks for empty input", () => {
    expect(outputRow(result("North", "exact"))).toEqual(["XX01", "North", 100, "exact"]);
    expect(outputRow(result("Nowhere", "none", 0, null))).toEqual(["", "", 0, "none"]);
    expect(outputRow(null)).toEqual(["", "", "", ""]);
  });

  it("recognises a previous run's headers", () => {
    expect(isOutputHeader(["pcode", "pcode_name", "pcode_score", "PCODE_STATUS"])).toBe(true);
    expect(isOutputHeader(["pcode", "name"])).toBe(false);
  });

  it("counts statuses and queues rows for review", () => {
    const results = [
      result("a", "exact"),
      result("b", "fuzzy", 95),
      result("c", "fuzzy", 82),
      result("d", "ambiguous", 100, null),
      result("e", "none", 40, null),
      null,
    ];
    expect(statusCounts(results)).toEqual({ exact: 1, fuzzy: 2, ambiguous: 1, none: 1 });
    expect(reviewQueue(results, 90)).toEqual([2, 3, 4]);
  });

  it("names columns like Excel", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
});

describe("version stamps", () => {
  it("round-trips the meta sheet", () => {
    const meta = { NGA: { version: "v01", validFrom: "2018-01-01", stampedAt: "2026-10-11T10:00:00" } };
    const values = metaValues(meta);
    expect(values[0]).toEqual(META_HEADERS);
    expect(parseMeta(values)).toEqual(meta);
  });

  it("flags countries stamped with an older version", () => {
    const meta = parseMeta([META_HEADERS, ["nga", "v01", "", ""], ["SYR", "v02", "", ""], ["ZZZ", "v01", "", ""]]);
    expect(outdated(meta, index)).toEqual([{ iso3: "NGA", name: "Nigeria", used: "v01", current: "v02" }]);
  });
});

describe("aliases", () => {
  it("round-trips alias rows and filters by country", () => {
    const alias = { iso3: "NGA", level: 2, parent: "NG020", name: "Nassarawa", pcode: "NG020031" };
    const row = aliasRow(alias, "Nasarawa", new Date("2026-10-11T12:00:00Z"));
    expect(row).toEqual(["NGA", 2, "NG020", "Nassarawa", "NG020031", "Nasarawa", "2026-10-11T12:00:00"]);
    const parsed = parseAliases([ALIAS_HEADERS, row, ["SYR", 1, "", "Sham", "SY01"], ["", "", "", "", ""]]);
    expect(parsed).toEqual([alias, { iso3: "SYR", level: 1, parent: null, name: "Sham", pcode: "SY01" }]);
    expect(aliasesFor(parsed, "nga")).toEqual([alias]);
  });
});

describe("countryForPcode", () => {
  it("finds the country from the p-code letters", () => {
    expect(countryForPcode(index, "SY0102")).toBe("SYR");
    expect(countryForPcode(index, " ng020031")).toBe("NGA");
    expect(countryForPcode(index, "MMR001001")).toBe("MMR");
    expect(countryForPcode(index, "10110")).toBeNull();
    expect(countryForPcode(index, "QQ01")).toBeNull();
  });
});
