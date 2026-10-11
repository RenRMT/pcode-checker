// Registers the custom functions. Both run in this one shared runtime.
import "../functions/functions";

import { normalise, type Matcher, type MatchResult, type Status } from "@pcode-checker/core";
import type { DataIndex } from "../shared/data";
import {
  columnLetter,
  isOutputHeader,
  outdated,
  OUTPUT_HEADERS,
  outputRow,
  reviewQueue,
  STATUS_COLOURS,
  statusCounts,
  type Cell,
} from "../shared/logic";
import { store } from "../shared/store";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface ColumnRef {
  sheet: string;
  columnIndex: number;
  rowIndex: number;
  rowCount: number;
}

interface Run {
  sheet: string;
  nameCol: number;
  outCol: number;
  /** Sheet row index of the first data row. */
  dataTop: number;
  iso3: string;
  level: number;
  parentLevel: number;
  matcher: Matcher;
  inputs: string[];
  parents: string[];
  results: (MatchResult | null)[];
  queue: number[];
  pos: number;
  resolved: Set<number>;
}

let index: DataIndex | null = null;
let nameRef: ColumnRef | null = null;
let parentRef: ColumnRef | null = null;
let run: Run | null = null;
let shownForOutdated = false;

const settings = () => Office.context.document.settings;

Office.onReady(async (info) => {
  $("loading").hidden = true;
  $("app").hidden = false;
  if (info.host !== Office.HostType.Excel) {
    showBanner("This add-in works in Excel only.");
    return;
  }
  wire();
  store.onChange(() => {
    renderVersionInfo();
    void checkVersions();
  });
  try {
    const loaded = await store.index();
    index = loaded.index;
    populateCountries();
    if (loaded.offline) showBanner(`Offline: using p-codes cached on this computer (from ${loaded.index.generated.slice(0, 10)}).`);
  } catch (err) {
    showBanner((err as Error).message, true);
    return;
  }
  await store.loadWorkbook();
});

function wire(): void {
  $("useName").onclick = () => pickColumn("name");
  $("useParent").onclick = () => pickColumn("parent");
  $("clearParent").onclick = () => {
    parentRef = null;
    $<HTMLInputElement>("parentRange").value = "";
  };
  $<HTMLSelectElement>("country").onchange = () => {
    populateLevels();
    renderVersionInfo();
  };
  $<HTMLSelectElement>("level").onchange = populateParentLevels;
  $("run").onclick = () => guard(matchColumn);
  $("openReview").onclick = () => guard(openReview);
  $("closeReview").onclick = closeReview;
  $("prev").onclick = () => guard(() => step(-1));
  $("skip").onclick = () => guard(() => step(1));
  $("confirm").onclick = () => guard(confirmChoice);
  $("manualPcode").onfocus = () => ($<HTMLInputElement>("manualChoice").checked = true);
}

async function guard(action: () => Promise<void> | void): Promise<void> {
  const buttons = document.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await action();
  } catch (err) {
    console.error(err);
    progress(`Error: ${(err as Error).message}`, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function progress(text: string, error = false): void {
  const el = $("progress");
  el.textContent = text;
  el.className = error ? "error" : "muted";
}

function showBanner(text: string, error = false, action?: { label: string; run: () => Promise<void> }): void {
  const el = $("banner");
  el.hidden = false;
  el.className = error ? "banner error" : "banner";
  el.replaceChildren(document.createTextNode(text));
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.onclick = () => guard(action.run);
    el.append(document.createElement("br"), button);
  }
}

function hideBanner(): void {
  $("banner").hidden = true;
}

// ---- selections -------------------------------------------------------------

async function pickColumn(kind: "name" | "parent"): Promise<void> {
  await Excel.run(async (ctx) => {
    const range = ctx.workbook.getSelectedRange();
    range.load("address,columnIndex,rowIndex,rowCount,columnCount");
    range.worksheet.load("name");
    await ctx.sync();
    const ref = { sheet: range.worksheet.name, columnIndex: range.columnIndex, rowIndex: range.rowIndex, rowCount: range.rowCount };
    const input = $<HTMLInputElement>(kind === "name" ? "nameRange" : "parentRange");
    input.value = range.columnCount > 1 ? `${range.address} (first column only)` : range.address;
    if (kind === "name") nameRef = ref;
    else parentRef = ref;
  });
}

// ---- country / level pickers -------------------------------------------------

function populateCountries(): void {
  if (!index) return;
  const select = $<HTMLSelectElement>("country");
  const entries = Object.entries(index.countries).sort((a, b) => a[1].name.localeCompare(b[1].name));
  select.replaceChildren(...entries.map(([iso3, info]) => new Option(`${info.name} (${iso3})`, iso3)));
  const saved = settings().get("iso3") as string | null;
  if (saved && index.countries[saved]) select.value = saved;
  $<HTMLInputElement>("header").checked = settings().get("header") ?? true;
  $<HTMLInputElement>("threshold").value = String(settings().get("threshold") ?? 80);
  $<HTMLInputElement>("reviewBelow").value = String(settings().get("reviewBelow") ?? 90);
  populateLevels();
  renderVersionInfo();
}

function populateLevels(): void {
  const info = index?.countries[$<HTMLSelectElement>("country").value];
  const select = $<HTMLSelectElement>("level");
  const previous = select.value || String(settings().get("level") ?? "");
  const levels = Object.entries(info?.levels ?? {});
  select.replaceChildren(...levels.map(([level, n]) => new Option(`Admin ${level} (${n.toLocaleString()} units)`, level)));
  if (levels.some(([l]) => l === previous)) select.value = previous;
  populateParentLevels();
}

function populateParentLevels(): void {
  const level = Number($<HTMLSelectElement>("level").value) || 1;
  const select = $<HTMLSelectElement>("parentLevel");
  const options = [new Option("the level above (default)", "")];
  for (let l = 1; l < level; l++) options.push(new Option(`Admin ${l}`, String(l)));
  select.replaceChildren(...options);
}

function renderVersionInfo(): void {
  const iso3 = $<HTMLSelectElement>("country").value;
  const info = index?.countries[iso3];
  if (!info || !index) return;
  const used = store.meta[iso3]?.version;
  const usedText = used && used !== info.version ? ` This workbook uses ${used}.` : "";
  $("versionInfo").textContent =
    `${info.name}: COD version ${info.version}, valid from ${info.validFrom}.${usedText} ` +
    `Data checked ${index.generated.slice(0, 10)}.`;
}

// ---- version warning -----------------------------------------------------------

async function checkVersions(): Promise<void> {
  if (!index) return;
  const old = outdated(store.meta, index);
  if (!old.length) {
    if (!$("banner").classList.contains("error")) hideBanner();
    return;
  }
  const list = old.map((o) => `${o.name} ${o.used} (now ${o.current})`).join(", ");
  showBanner(`This workbook was matched with older p-codes: ${list}.`, false, {
    label: "Use the latest p-codes",
    run: async () => {
      for (const o of old) {
        const info = index!.countries[o.iso3];
        await store.stamp(o.iso3, info.version, info.validFrom);
      }
      await Excel.run(async (ctx) => {
        ctx.workbook.application.calculate(Excel.CalculationType.full);
        await ctx.sync();
      });
      showBanner("Formulas now use the latest p-codes. Run Match again to update matched columns.");
    },
  });
  if (!shownForOutdated) {
    shownForOutdated = true;
    // The runtime may have started with the workbook, before the pane was opened.
    Office.addin.showAsTaskpane().catch(() => undefined);
  }
}

// ---- batch matching --------------------------------------------------------------

async function matchColumn(): Promise<void> {
  if (!nameRef) throw new Error("Select the column of place names and click Use selection.");
  const iso3 = $<HTMLSelectElement>("country").value;
  const level = Number($<HTMLSelectElement>("level").value);
  if (!iso3 || !level) throw new Error("Choose a country and admin level.");
  if (parentRef && parentRef.sheet !== nameRef.sheet) throw new Error("The parent column must be on the same sheet.");
  const header = $<HTMLInputElement>("header").checked;
  const threshold = clamp(Number($<HTMLInputElement>("threshold").value), 50, 100, 80);
  const reviewBelow = clamp(Number($<HTMLInputElement>("reviewBelow").value), 50, 100, 90);
  const parentLevel = Number($<HTMLSelectElement>("parentLevel").value) || level - 1;
  settings().set("iso3", iso3);
  settings().set("level", level);
  settings().set("header", header);
  settings().set("threshold", threshold);
  settings().set("reviewBelow", reviewBelow);
  settings().saveAsync();

  closeReview();
  progress(`Loading p-codes for ${index?.countries[iso3]?.name ?? iso3}…`);
  const started = performance.now();
  const matcher = await store.matcher(iso3);
  const ref = nameRef;
  const pref = parentRef;

  const read = await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(ref.sheet);
    const used = sheet.getUsedRange(true);
    used.load("rowIndex,rowCount");
    await ctx.sync();
    const top = Math.max(ref.rowIndex, used.rowIndex);
    const bottom = Math.min(ref.rowIndex + ref.rowCount, used.rowIndex + used.rowCount);
    if (bottom <= top) throw new Error("The selected column is empty.");
    const n = bottom - top;
    const names = sheet.getRangeByIndexes(top, ref.columnIndex, n, 1);
    names.load("values");
    const parents = pref ? sheet.getRangeByIndexes(top, pref.columnIndex, n, 1) : null;
    parents?.load("values");
    const after = sheet.getRangeByIndexes(top, ref.columnIndex + 1, 1, OUTPUT_HEADERS.length);
    after.load("values");
    await ctx.sync();
    return {
      top,
      names: names.values.map((r) => r[0]),
      parents: parents ? parents.values.map((r) => r[0]) : null,
      reuse: header && isOutputHeader(after.values[0]),
    };
  });

  const skip = header ? 1 : 0;
  const inputs = read.names.slice(skip).map(cellText);
  const parents = (read.parents ?? []).slice(skip).map(cellText);
  const results: (MatchResult | null)[] = [];
  for (let i = 0; i < inputs.length; i++) {
    results.push(inputs[i] ? matcher.match(inputs[i], { level, parent: parents[i] || null, parentLevel, threshold }) : null);
    if (i % 1000 === 999) {
      progress(`Matched ${i + 1} of ${inputs.length}…`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  progress("Writing results…");
  const outCol = ref.columnIndex + 1;
  const dataTop = read.top + skip;
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(ref.sheet);
    if (!read.reuse) {
      sheet.getRangeByIndexes(0, outCol, 1, OUTPUT_HEADERS.length).getEntireColumn().insert(Excel.InsertShiftDirection.right);
    }
    if (header) sheet.getRangeByIndexes(read.top, outCol, 1, OUTPUT_HEADERS.length).values = [OUTPUT_HEADERS];
    if (inputs.length) {
      const out = sheet.getRangeByIndexes(dataTop, outCol, inputs.length, OUTPUT_HEADERS.length);
      out.values = results.map(outputRow);
      out.conditionalFormats.clearAll();
      const statusRef = `$${columnLetter(outCol + 3)}${dataTop + 1}`;
      for (const status of Object.keys(STATUS_COLOURS) as Status[]) {
        const cf = out.conditionalFormats.add(Excel.ConditionalFormatType.custom);
        cf.custom.rule.formula = `=${statusRef}="${status}"`;
        cf.custom.format.fill.color = STATUS_COLOURS[status];
      }
    }
    await ctx.sync();
  });
  if (!read.reuse && pref && pref.columnIndex > ref.columnIndex) {
    // the parent column moved right by the inserted output columns
    pref.columnIndex += OUTPUT_HEADERS.length;
    $<HTMLInputElement>("parentRange").value = `${pref.sheet}!${columnLetter(pref.columnIndex)}:${columnLetter(pref.columnIndex)}`;
  }

  const data = matcher.gazetteer.data;
  if (store.meta[iso3]?.version !== data.version) await store.stamp(iso3, data.version, data.validFrom);
  try {
    // Load the runtime with the workbook from now on, so formulas work and the
    // version check runs when it is opened.
    await Office.addin.setStartupBehavior(Office.StartupBehavior.load);
  } catch {
    /* not supported on this platform */
  }

  run = {
    sheet: ref.sheet,
    nameCol: ref.columnIndex,
    outCol,
    dataTop,
    iso3,
    level,
    parentLevel,
    matcher,
    inputs,
    parents,
    results,
    queue: reviewQueue(results, reviewBelow),
    pos: 0,
    resolved: new Set(),
  };
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  progress(`Matched ${inputs.filter(Boolean).length} names against ${data.name} ${data.version} in ${seconds} s.`);
  renderSummary();
}

function cellText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function renderSummary(): void {
  if (!run) return;
  const counts = statusCounts(run.results);
  $("counts").replaceChildren(
    ...(Object.keys(counts) as Status[]).map((status) => {
      const li = document.createElement("li");
      li.className = status;
      li.textContent = `${counts[status]} ${status}`;
      return li;
    }),
  );
  const open = run.queue.filter((i) => !run!.resolved.has(i)).length;
  const button = $<HTMLButtonElement>("openReview");
  button.hidden = open === 0;
  button.textContent = `Review ${open} row${open === 1 ? "" : "s"}`;
  $("summary").hidden = false;
}

// ---- review panel ----------------------------------------------------------------

async function openReview(): Promise<void> {
  if (!run || !run.queue.length) return;
  run.pos = run.queue.findIndex((i) => !run!.resolved.has(i));
  if (run.pos < 0) return;
  $("matchPanel").hidden = true;
  $("reviewPanel").hidden = false;
  await renderItem();
}

function closeReview(): void {
  $("reviewPanel").hidden = true;
  $("matchPanel").hidden = false;
  renderSummary();
}

async function step(direction: 1 | -1): Promise<void> {
  if (!run) return;
  const r = run;
  const open = (p: number) => !r.resolved.has(r.queue[p]);
  if (!r.queue.some((_, p) => open(p))) {
    closeReview();
    progress("All rows reviewed.");
    return;
  }
  // Move to the next open row in this direction, wrapping round the queue.
  const n = r.queue.length;
  let pos = r.pos;
  for (let k = 0; k < n; k++) {
    pos = (pos + direction + n) % n;
    if (open(pos)) break;
  }
  r.pos = pos;
  await renderItem();
}

async function renderItem(): Promise<void> {
  if (!run) return;
  const row = run.queue[run.pos];
  const result = run.results[row]!;
  const parent = run.parents[row];
  const gazetteer = run.matcher.gazetteer;
  const remaining = run.queue.filter((i) => !run!.resolved.has(i)).length;
  $("reviewPosition").textContent = `${run.pos + 1} of ${run.queue.length} (${remaining} open)`;
  $("reviewCell").textContent = `${run.sheet}!${columnLetter(run.nameCol)}${run.dataTop + row + 1}`;
  $("reviewText").textContent = result.input;
  $("reviewParent").textContent = parent ? ` in ${parent}` : "";
  $("reviewNote").textContent =
    result.status === "fuzzy"
      ? `Fuzzy match, score ${result.score}.`
      : `${result.status === "ambiguous" ? "Ambiguous" : "No match"}${result.note ? `: ${result.note}` : ""}.`;
  $("reviewError").hidden = true;
  $<HTMLInputElement>("manualPcode").value = "";

  const list = $("candidates");
  list.replaceChildren(
    ...result.candidates.map((c, i) => {
      const label = document.createElement("label");
      label.className = "candidate";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "candidate";
      radio.value = c.pcode;
      radio.checked = i === 0;
      const text = document.createElement("span");
      const parentName = c.level > 1 ? gazetteer.unit(c.parent, c.level - 1)?.name : null;
      text.append(c.name, document.createElement("br"));
      const small = document.createElement("span");
      small.className = "muted small";
      small.textContent = `${c.pcode}${parentName ? ` · in ${parentName}` : ""}`;
      text.append(small);
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = String(c.score);
      label.append(radio, text, score);
      return label;
    }),
  );
  if (!result.candidates.length) $<HTMLInputElement>("manualChoice").checked = true;

  const r = run;
  await Excel.run(async (ctx) => {
    ctx.workbook.worksheets.getItem(r.sheet).getRangeByIndexes(r.dataTop + row, r.nameCol, 1, 1).select();
    await ctx.sync();
  }).catch(() => undefined);
}

async function confirmChoice(): Promise<void> {
  if (!run) return;
  const r = run;
  const row = r.queue[r.pos];
  const result = r.results[row]!;
  const choice = document.querySelector<HTMLInputElement>('input[name="candidate"]:checked')?.value;
  const pcode = choice === "__manual" || !choice ? $<HTMLInputElement>("manualPcode").value.trim() : choice;
  const unit = pcode ? r.matcher.gazetteer.unit(pcode, r.level) : undefined;
  if (!unit) {
    const error = $("reviewError");
    error.textContent = pcode ? `${pcode} is not an admin ${r.level} p-code for ${r.iso3}.` : "Pick a unit or type a p-code.";
    error.hidden = false;
    return;
  }

  // Apply to every open row with the same name and parent.
  const key = (i: number) => `${normalise(r.inputs[i])}\u0000${r.parents[i] ?? ""}`;
  const target = key(row);
  const rows = r.queue.filter((i) => !r.resolved.has(i) && key(i) === target);
  const values: Cell[] = [unit.pcode, unit.name, 100, "exact"];
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(r.sheet);
    for (const i of rows) sheet.getRangeByIndexes(r.dataTop + i, r.outCol, 1, values.length).values = [values];
    await ctx.sync();
  });
  for (const i of rows) {
    r.resolved.add(i);
    r.results[i] = { ...r.results[i]!, pcode: unit.pcode, name: unit.name, score: 100, status: "exact", method: "alias" };
  }
  if ($<HTMLInputElement>("remember").checked) {
    await store.addAliases([
      {
        alias: { iso3: r.iso3, level: r.level, parent: result.parentPcode, name: result.input, pcode: unit.pcode },
        pcodeName: unit.name,
      },
    ]);
  }
  progress(`Set ${rows.length} row${rows.length === 1 ? "" : "s"} to ${unit.name} (${unit.pcode}).`);
  await step(1);
}
