// Hidden sheets that store per-workbook state: the COD version used per
// country (_pcode_meta) and confirmed aliases (_pcode_aliases).

import {
  ALIAS_HEADERS,
  ALIAS_SHEET,
  META_SHEET,
  metaValues,
  parseAliases,
  parseMeta,
  type Cell,
  type MetaEntry,
  type StoredAlias,
} from "./logic";

async function readSheet(name: string): Promise<unknown[][]> {
  return Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItemOrNullObject(name);
    await ctx.sync();
    if (sheet.isNullObject) return [];
    const used = sheet.getUsedRangeOrNullObject(true);
    used.load("values");
    await ctx.sync();
    return used.isNullObject ? [] : used.values;
  });
}

function hiddenSheet(ctx: Excel.RequestContext, name: string, existing: Excel.Worksheet): Excel.Worksheet {
  if (!existing.isNullObject) return existing;
  const sheet = ctx.workbook.worksheets.add(name);
  sheet.visibility = Excel.SheetVisibility.hidden;
  return sheet;
}

export async function readMeta(): Promise<Record<string, MetaEntry>> {
  return parseMeta(await readSheet(META_SHEET));
}

export async function writeMeta(meta: Record<string, MetaEntry>): Promise<void> {
  const values = metaValues(meta);
  await Excel.run(async (ctx) => {
    const existing = ctx.workbook.worksheets.getItemOrNullObject(META_SHEET);
    await ctx.sync();
    const sheet = hiddenSheet(ctx, META_SHEET, existing);
    sheet.getRange().clear(Excel.ClearApplyTo.contents);
    sheet.getRangeByIndexes(0, 0, values.length, values[0].length).values = values;
    await ctx.sync();
  });
}

export async function readAliases(): Promise<StoredAlias[]> {
  return parseAliases(await readSheet(ALIAS_SHEET));
}

export async function appendAliases(rows: Cell[][]): Promise<void> {
  if (!rows.length) return;
  await Excel.run(async (ctx) => {
    const existing = ctx.workbook.worksheets.getItemOrNullObject(ALIAS_SHEET);
    await ctx.sync();
    const sheet = hiddenSheet(ctx, ALIAS_SHEET, existing);
    const used = sheet.getUsedRangeOrNullObject(true);
    used.load("rowCount,rowIndex");
    await ctx.sync();
    let next = 0;
    if (used.isNullObject) {
      sheet.getRangeByIndexes(0, 0, 1, ALIAS_HEADERS.length).values = [ALIAS_HEADERS];
      next = 1;
    } else {
      next = used.rowIndex + used.rowCount;
    }
    sheet.getRangeByIndexes(next, 0, rows.length, ALIAS_HEADERS.length).values = rows;
    await ctx.sync();
  });
}
