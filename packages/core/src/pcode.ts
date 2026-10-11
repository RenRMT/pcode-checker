// P-code detection and length conversion, ported from
// hdx.location.adminlevel.AdminLevel.convert_admin_pcode_length.

export const PCODE_RE = /^([a-zA-Z]{2,3})(\d+)$/;

/** True if text has the general shape of a p-code: 2-3 letters then digits. */
export function looksLikePcode(text: string): boolean {
  return PCODE_RE.test(text);
}

/**
 * The p-code format the way hdx reads it: [country length, adm1, adm2, adm3]
 * lengths, stopping at the first blank or alternative ("2|3") value.
 */
export function pcodeFormat(lengths: string[] | null | undefined): number[] | null {
  if (!lengths || !lengths.length || !lengths[0]) return null;
  const format = [parseInt(lengths[0], 10)];
  for (let level = 1; level < 4; level++) {
    const length = lengths[level];
    if (!length || length.includes("|")) break;
    format.push(parseInt(length, 10));
  }
  return format;
}

export interface PcodeSet {
  iso3: string;
  /** Letters that start this country's p-codes, e.g. "SY" (from the data). */
  prefix: string;
  format: number[] | null;
  level: number;
  pcodes: Set<string>;
  /** Positions at which some p-code at this level has a "0". */
  zeroes: Set<number>;
}

export function makePcodeSet(iso3: string, lengths: string[] | null, level: number, pcodes: string[]): PcodeSet {
  const set = new Set(pcodes.map((p) => p.toUpperCase()));
  const zeroes = new Set<number>();
  for (const p of set) for (let i = 0; i < p.length; i++) if (p[i] === "0") zeroes.add(i);
  const first = [...set].find((p) => PCODE_RE.test(p));
  const prefix = first ? PCODE_RE.exec(first)![1] : iso3;
  return { iso3: iso3.toUpperCase(), prefix, format: pcodeFormat(lengths), level, pcodes: set, zeroes };
}

/**
 * Standardise a p-code's country prefix and digit groups to the country's
 * format (eg. "SY01" vs "SYR01" vs "SY1") and return it if it exists.
 */
export function convertPcodeLength(set: PcodeSet, pcode: string): string | null {
  const match = PCODE_RE.exec(pcode);
  if (!match) return null;
  const format = set.format;
  if (!format) return set.level === 1 ? convertAdmin1PcodeLength(set, pcode) : null;
  const [, countryiso, digits] = match;
  let parts: string[];
  if (countryiso.length > format[0]) parts = [set.prefix, digits];
  else if (countryiso.length < format[0]) parts = [set.iso3, digits];
  else parts = [countryiso, digits];
  let newPcode = parts.join("");
  if (set.pcodes.has(newPcode)) return newPcode;

  const totalLength = format.slice(0, set.level + 1).reduce((a, b) => a + b, 0);
  for (let adminNo = 1; adminNo <= set.level; adminNo++) {
    const lenNew = newPcode.length;
    if (lenNew === totalLength) break;
    const adminLength = format[adminNo];
    let part = parts[adminNo];
    if (adminLength === undefined || part === undefined) break;
    const partLength = part.length;
    if (partLength === adminLength) break;
    const pos = format.slice(0, adminNo).reduce((a, b) => a + b, 0);
    if (partLength < adminLength) {
      if (set.zeroes.has(pos)) {
        parts[adminNo] = `0${part}`;
        newPcode = parts.join("");
      }
      break;
    } else if (partLength > adminLength && adminNo === set.level) {
      if (part[0] === "0") {
        parts[adminNo] = part.slice(1);
        newPcode = parts.join("");
        break;
      }
    }
    if (lenNew < totalLength) {
      if (adminLength > 2 && set.zeroes.has(pos)) part = `0${part}`;
    } else if (lenNew > totalLength) {
      if (adminLength <= 2 && part[0] === "0") part = part.slice(1);
    }
    parts[adminNo] = part.slice(0, adminLength);
    parts.push(part.slice(adminLength));
    newPcode = parts.join("");
  }
  return set.pcodes.has(newPcode) ? newPcode : null;
}

function convertAdmin1PcodeLength(set: PcodeSet, pcode: string): string | null {
  const countryLength = set.pcodes.size ? [...set.pcodes][set.pcodes.size - 1].length : 0;
  const length = pcode.length;
  if (!countryLength || length === countryLength || length < 4 || length > 6) return null;
  const iso2 = set.prefix.length === 2 ? set.prefix : null;
  let candidate: string | null = null;
  if (countryLength === 4) candidate = iso2 && `${iso2}${pcode.slice(-2)}`;
  else if (countryLength === 5) candidate = length === 4 ? `${pcode.slice(0, 2)}0${pcode.slice(-2)}` : iso2 && `${iso2}${pcode.slice(-3)}`;
  else if (countryLength === 6) candidate = length === 4 ? `${set.iso3}0${pcode.slice(-2)}` : `${set.iso3}${pcode.slice(-3)}`;
  return candidate && set.pcodes.has(candidate) ? candidate : null;
}
