// Node-only loader for country files. Not exported from index.ts, which must
// stay browser-safe for the add-in.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CountryData } from "./gazetteer.js";

/**
 * Load a country from a data-build output dir (index.json + ISO3/version.json)
 * or from a dir of ISO3.json files such as fixtures/data.
 */
export function loadCountry(dir: string, iso3: string): CountryData {
  const index = join(dir, "index.json");
  if (existsSync(index)) {
    const entry = JSON.parse(readFileSync(index, "utf8")).countries[iso3];
    if (!entry) throw new Error(`${iso3} is not in ${index}`);
    return JSON.parse(readFileSync(join(dir, entry.file), "utf8"));
  }
  return JSON.parse(readFileSync(join(dir, `${iso3}.json`), "utf8"));
}
