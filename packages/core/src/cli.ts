#!/usr/bin/env node
// Match JSON Lines from stdin and write results to stdout. Used by the Python
// evaluation (data-build/eval) and handy for batch jobs outside Excel.
//
//   pcode-match --data DIR [--mode core|hdx] [--threshold N] < cases.jsonl
//
// Input lines: {"id", "input", "iso3", "level", "parent"?}
// Output lines: {"id", "pcode", "status", "score", "method", "candidates"}
// DIR is either a data-build output dir (index.json + ISO3/version.json) or a
// dir of ISO3.json files such as fixtures/data.

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { CountryData } from "./gazetteer.js";
import { HdxAdminLevel } from "./hdx.js";
import { loadCountry } from "./load-node.js";
import { Matcher } from "./matcher.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      mode: { type: "string", default: "core" },
      threshold: { type: "string" },
    },
  });
  if (!values.data) throw new Error("--data is required");
  const dir = values.data;
  const threshold = values.threshold ? Number(values.threshold) : undefined;
  const matchers = new Map<string, Matcher>();
  const hdx = new Map<string, HdxAdminLevel>();
  const countries = new Map<string, CountryData>();
  const country = (iso3: string) => {
    let data = countries.get(iso3);
    if (!data) countries.set(iso3, (data = loadCountry(dir, iso3)));
    return data;
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    const iso3 = String(c.iso3).toUpperCase();
    let out: Record<string, unknown>;
    if (values.mode === "hdx") {
      const key = `${iso3}|${c.level}`;
      let admin = hdx.get(key);
      if (!admin) hdx.set(key, (admin = new HdxAdminLevel(country(iso3), c.level)));
      const [pcode] = admin.getPcode(c.input, { parent: c.parent });
      out = { id: c.id, pcode };
    } else {
      let matcher = matchers.get(iso3);
      if (!matcher) matchers.set(iso3, (matcher = new Matcher(country(iso3), { threshold })));
      const r = matcher.match(c.input, { level: c.level, parent: c.parent });
      out = { id: c.id, pcode: r.pcode, status: r.status, score: r.score, method: r.method, candidates: r.candidates };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
