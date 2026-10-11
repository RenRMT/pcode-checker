import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CountryData } from "../src/index.js";

export const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

export interface Case {
  id?: string;
  input: string;
  iso3: string;
  level: number;
  parent?: string;
  expected: string | null;
  noise?: string;
  note?: string;
}

export function readJson<T = any>(rel: string): T {
  return JSON.parse(readFileSync(FIXTURES + rel, "utf8"));
}

export function countries(): Record<string, CountryData> {
  const out: Record<string, CountryData> = {};
  for (const file of readdirSync(FIXTURES + "data")) {
    if (file.endsWith(".json")) out[file.slice(0, -5)] = readJson(`data/${file}`);
  }
  return out;
}

export function caseSet(name: string): Case[] {
  if (!existsSync(FIXTURES + name)) return [];
  return readdirSync(FIXTURES + name)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => readJson<{ cases: Case[] }>(`${name}/${f}`).cases ?? []);
}
