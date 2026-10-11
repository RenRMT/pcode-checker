import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Matcher, type CountryData, type UnitRow } from "../src/index.js";
import { loadCountry } from "../src/load-node.js";
import { countries } from "./helpers.js";

function typo(name: string, i: number): string {
  const p = 1 + (i % Math.max(1, name.length - 2));
  return name.slice(0, p) + name.slice(p + 1);
}

/** A country the size of Indonesia: 34 / 520 / 7,000 / 82,000 units. */
function bigCountry(): CountryData {
  const syll = ["ba", "ka", "ma", "na", "ra", "sa", "ta", "jo", "ri", "lu", "ngi", "wa", "de", "su", "po", "kem", "bang", "jaya"];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const word = () => Array.from({ length: 2 + Math.floor(rand() * 3) }, () => syll[Math.floor(rand() * syll.length)]).join("");
  const name = () => (rand() < 0.3 ? `${word()} ${word()}` : word()).replace(/^./, (c) => c.toUpperCase());
  const units: UnitRow[] = [];
  let parents = ["ZZZ"];
  [34, 520, 7000, 82000].forEach((n, depth) => {
    const level: string[] = [];
    for (let i = 0; i < n; i++) {
      const pcode = `ZZ${depth}${String(i).padStart(6, "0")}`;
      units.push([pcode, name(), parents[Math.floor(rand() * parents.length)], depth + 1]);
      level.push(pcode);
    }
    parents = level;
  });
  return { format: 1, iso3: "ZZZ", name: "Big", version: "v01", validFrom: "2026-01-01", lengths: null, units };
}

describe("speed", () => {
  it("matches 5,000 messy NGA adm2 rows in well under 5 s", () => {
    const nga = countries().NGA;
    const lgas = nga.units.filter((u) => u[3] === 2);
    const inputs = Array.from({ length: 5000 }, (_, i) => {
      const [, name, parent] = lgas[(i * 7919) % lgas.length];
      return { name: i % 3 === 0 ? typo(name, i) : `${name}${i % 5 === 0 ? " LGA" : ""}`, parent: i % 2 ? parent : undefined };
    });
    const m = new Matcher(nga);
    const start = performance.now();
    for (const x of inputs) m.match(x.name, { level: 2, parent: x.parent });
    const ms = performance.now() - start;
    console.log(`NGA adm2: 5,000 rows in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2500);
  });

  it("matches against 82,000 adm4 units without a parent via the trigram index", () => {
    const big = bigCountry();
    const adm4 = big.units.filter((u) => u[3] === 4);
    const m = new Matcher(big);
    let start = performance.now();
    m.match("warmup", { level: 4 });
    const indexMs = performance.now() - start;
    start = performance.now();
    for (let i = 0; i < 1000; i++) m.match(typo(adm4[(i * 104729) % adm4.length][1], i), { level: 4 });
    const ms = performance.now() - start;
    console.log(`synthetic adm4: index ${indexMs.toFixed(0)} ms, 1,000 unique rows in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(10_000);
  });

  const dataDir = process.env.PCODE_DATA_DIR;
  it.runIf(!!dataDir && existsSync(`${dataDir}/index.json`))("matches real IDN adm4 names (PCODE_DATA_DIR)", () => {
    const idn = loadCountry(dataDir!, "IDN");
    const adm4 = idn.units.filter((u) => u[3] === 4 && u[1]);
    const m = new Matcher(idn);
    const start = performance.now();
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      const [pcode, name, parent] = adm4[(i * 104729) % adm4.length];
      if (m.match(typo(name, i), { level: 4, parent }).pcode === pcode) hits++;
    }
    const ms = performance.now() - start;
    console.log(`IDN adm4 with parent: 1,000 rows in ${ms.toFixed(0)} ms, ${hits} correct`);
    expect(ms).toBeLessThan(10_000);
  });
});
