// The TS port of AdminLevel.get_pcode must give the same answer as
// hdx-python-country (recorded by data-build/oracle.py) for every fixture case,
// except differences listed in fixtures/oracle/known-differences.json.
import { describe, expect, it } from "vitest";
import { HdxAdminLevel } from "../src/index.js";
import { caseSet, countries, readJson } from "./helpers.js";

const data = countries();
const known: Record<string, string> = (() => {
  try {
    return readJson("oracle/known-differences.json").differences ?? {};
  } catch {
    return {};
  }
})();

describe("TS hdx port agrees with hdx-python-country", () => {
  for (const iso3 of Object.keys(data)) {
    const oracle: Record<string, string | null> = readJson(`oracle/${iso3}.json`);
    const cases = [...caseSet("synthetic"), ...caseSet("curated")].filter((c) => c.iso3 === iso3 && c.id! in oracle);
    it(`${iso3}: ${cases.length} cases`, () => {
      const admins = new Map<number, HdxAdminLevel>();
      const mismatches: string[] = [];
      for (const c of cases) {
        if (c.id! in known) continue;
        let admin = admins.get(c.level);
        if (!admin) admins.set(c.level, (admin = new HdxAdminLevel(data[iso3], c.level)));
        const [pcode] = admin.getPcode(c.input, { parent: c.parent });
        if (pcode !== oracle[c.id!]) mismatches.push(`${c.id} ${JSON.stringify(c.input)}: ts=${pcode} python=${oracle[c.id!]}`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});
