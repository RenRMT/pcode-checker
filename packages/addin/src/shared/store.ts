// State shared by the task pane and the custom functions. Both run in one
// shared runtime, so they share this module instance and its caches: a
// country is downloaded and indexed once per session.

import { Matcher } from "@pcode-checker/core";
import { loadCountry, loadIndex, resolveVersion, type LoadedIndex } from "./data";
import { aliasesFor, aliasRow, type MetaEntry, type StoredAlias } from "./logic";
import { appendAliases, readAliases, readMeta, writeMeta } from "./workbook";

type Listener = () => void;

class Store {
  private indexPromise?: Promise<LoadedIndex>;
  private workbookPromise?: Promise<void>;
  private readonly matchers = new Map<string, Promise<Matcher>>();
  private readonly listeners = new Set<Listener>();
  private pendingStamps = new Map<string, { version: string; validFrom: string }>();
  private stampTimer?: ReturnType<typeof setTimeout>;
  meta: Record<string, MetaEntry> = {};
  aliases: StoredAlias[] = [];

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  index(refresh = false): Promise<LoadedIndex> {
    if (!this.indexPromise || refresh) {
      this.indexPromise = loadIndex().catch((err) => {
        this.indexPromise = undefined;
        throw err;
      });
    }
    return this.indexPromise;
  }

  /** Read _pcode_meta and _pcode_aliases. Safe to call repeatedly. */
  loadWorkbook(refresh = false): Promise<void> {
    if (!this.workbookPromise || refresh) {
      this.workbookPromise = (async () => {
        try {
          [this.meta, this.aliases] = await Promise.all([readMeta(), readAliases()]);
        } catch (err) {
          console.warn("Could not read p-code sheets", err);
        }
        this.applyAliases();
        this.changed();
      })();
    }
    return this.workbookPromise;
  }

  /** Matcher for a country at the workbook's stamped version (or the current one). */
  async matcher(iso3: string, version?: string): Promise<Matcher> {
    iso3 = iso3.trim().toUpperCase();
    await this.loadWorkbook();
    const { index } = await this.index();
    const v = resolveVersion(index, iso3, version ?? this.meta[iso3]?.version);
    const key = `${iso3}@${v.version}`;
    let promise = this.matchers.get(key);
    if (!promise) {
      promise = loadCountry(index, iso3, v.version).then(
        (data) => new Matcher(data, { aliases: aliasesFor(this.aliases, iso3) }),
      );
      promise.catch(() => this.matchers.delete(key));
      this.matchers.set(key, promise);
    }
    return promise;
  }

  /** Record the version a workbook uses for a country. */
  async stamp(iso3: string, version: string, validFrom: string): Promise<void> {
    this.meta = { ...this.meta, [iso3]: { version, validFrom, stampedAt: new Date().toISOString().slice(0, 19) } };
    await writeMeta(this.meta);
    this.changed();
  }

  /**
   * Stamp a country the first time a formula uses it, after the calculation
   * has finished rather than during it.
   */
  stampLater(iso3: string, version: string, validFrom: string): void {
    if (this.meta[iso3] || this.pendingStamps.has(iso3)) return;
    this.pendingStamps.set(iso3, { version, validFrom });
    clearTimeout(this.stampTimer);
    this.stampTimer = setTimeout(async () => {
      const pending = this.pendingStamps;
      this.pendingStamps = new Map();
      for (const [code, v] of pending) {
        if (!this.meta[code]) this.meta[code] = { ...v, stampedAt: new Date().toISOString().slice(0, 19) };
      }
      try {
        await writeMeta(this.meta);
      } catch (err) {
        console.warn("Could not stamp p-code versions", err);
      }
      this.changed();
    }, 2000);
  }

  async addAliases(items: { alias: StoredAlias; pcodeName: string }[]): Promise<void> {
    if (!items.length) return;
    const now = new Date();
    await appendAliases(items.map(({ alias, pcodeName }) => aliasRow(alias, pcodeName, now)));
    this.aliases = [...this.aliases, ...items.map((i) => i.alias)];
    this.applyAliases();
    this.changed();
  }

  private applyAliases(): void {
    for (const [key, promise] of this.matchers) {
      const iso3 = key.split("@")[0];
      promise.then((m) => m.setAliases(aliasesFor(this.aliases, iso3))).catch(() => undefined);
    }
  }
}

export const store = new Store();
