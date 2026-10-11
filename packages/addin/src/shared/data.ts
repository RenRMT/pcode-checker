// Loads the p-code index and country files from the same origin as the add-in
// (GitHub Pages), caching them in IndexedDB by version so the add-in works
// offline after the first load.

import type { CountryData } from "@pcode-checker/core";
import { idbGet, idbSet } from "./idb";

declare const __DATA_BASE__: string;

export interface VersionInfo {
  version: string;
  validFrom: string;
  file: string;
  sha256: string;
}

export interface CountryInfo {
  name: string;
  version: string;
  validFrom: string;
  file: string;
  bytes: number;
  sha256: string;
  rows: number;
  /** Letters that start this country's p-codes, e.g. "SY". */
  prefix?: string;
  levels: Record<string, number>;
  versions: VersionInfo[];
}

export interface DataIndex {
  format: number;
  generated: string;
  license: string;
  attribution: string;
  sourceUrl: string;
  countries: Record<string, CountryInfo>;
}

export interface LoadedIndex {
  index: DataIndex;
  /** True when served from the cache because the network failed. */
  offline: boolean;
}

const INDEX_KEY = "index";
const memory = new Map<string, Promise<CountryData>>();

export function dataBase(): string {
  return new URL(__DATA_BASE__, document.baseURI).href;
}

export async function loadIndex(): Promise<LoadedIndex> {
  try {
    const response = await fetch(`${dataBase()}index.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`);
    const index = (await response.json()) as DataIndex;
    await idbSet(INDEX_KEY, index);
    return { index, offline: false };
  } catch (err) {
    const cached = await idbGet<DataIndex>(INDEX_KEY);
    if (cached) return { index: cached, offline: true };
    throw new Error(`Can't load the p-code index and nothing is cached yet (${(err as Error).message}).`);
  }
}

/** The version to load: the one given if the index knows it, else the current one. */
export function resolveVersion(index: DataIndex, iso3: string, version?: string | null): VersionInfo {
  const info = index.countries[iso3];
  if (!info) throw new Error(`No p-codes for ${iso3}`);
  return (
    (version && info.versions.find((v) => v.version === version)) || {
      version: info.version,
      validFrom: info.validFrom,
      file: info.file,
      sha256: info.sha256,
    }
  );
}

export function loadCountry(index: DataIndex, iso3: string, version?: string | null): Promise<CountryData> {
  const v = resolveVersion(index, iso3, version);
  const key = `${iso3}@${v.version}`;
  let promise = memory.get(key);
  if (!promise) {
    promise = fetchCountry(key, v).catch((err) => {
      memory.delete(key);
      throw err;
    });
    memory.set(key, promise);
  }
  return promise;
}

async function fetchCountry(key: string, v: VersionInfo): Promise<CountryData> {
  const cached = await idbGet<CountryData>(key);
  if (cached) return cached;
  const response = await fetch(`${dataBase()}${v.file}`);
  if (!response.ok) throw new Error(`${v.file}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (v.sha256 && (await sha256(bytes)) !== v.sha256) throw new Error(`${v.file}: checksum mismatch`);
  const data = JSON.parse(new TextDecoder().decode(bytes)) as CountryData;
  await idbSet(key, data);
  return data;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
