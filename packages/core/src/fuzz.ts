// String similarity scorers. ratio, tokenSortRatio, tokenSetRatio and
// jaroWinkler reproduce rapidfuzz 3.x (fuzz.* and distance.JaroWinkler);
// defaultScorer and placeNameScorer port hdx.utilities.matching.RapidFuzzMatcher.
// Scores are 0-100 except jaroWinkler, which is 0-1 like rapidfuzz.

let rowA = new Int32Array(64);
let rowB = new Int32Array(64);

/** Length of the longest common subsequence. */
export function lcsLength(a: string, b: string): number {
  if (a.length < b.length) [a, b] = [b, a];
  const m = b.length;
  if (m === 0) return 0;
  if (rowA.length <= m) {
    rowA = new Int32Array(m * 2 + 1);
    rowB = new Int32Array(m * 2 + 1);
  }
  let prev = rowA;
  let cur = rowB;
  prev.fill(0, 0, m + 1);
  for (let i = 0; i < a.length; i++) {
    const ca = a.charCodeAt(i);
    cur[0] = 0;
    for (let j = 1; j <= m; j++) {
      if (ca === b.charCodeAt(j - 1)) cur[j] = prev[j - 1] + 1;
      else cur[j] = prev[j] > cur[j - 1] ? prev[j] : cur[j - 1];
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}

export function indelDistance(a: string, b: string): number {
  return a.length + b.length - 2 * lcsLength(a, b);
}

function normDistance(dist: number, lensum: number): number {
  return lensum ? 100 - (100 * dist) / lensum : 100;
}

/** rapidfuzz.fuzz.ratio: normalised Indel similarity, 0-100. */
export function ratio(a: string, b: string): number {
  return normDistance(indelDistance(a, b), a.length + b.length);
}

function splitWords(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function sortedJoin(words: Iterable<string>): string {
  return [...words].sort(pyCompare).join(" ");
}

// Python sorts str by code point; JS default sort compares UTF-16 units. They
// agree except for astral characters, which normalised names never contain.
function pyCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** rapidfuzz.fuzz.token_sort_ratio */
export function tokenSortRatio(a: string, b: string): number {
  return ratio(sortedJoin(splitWords(a)), sortedJoin(splitWords(b)));
}

/** rapidfuzz.fuzz.token_set_ratio */
export function tokenSetRatio(a: string, b: string): number {
  const tokensA = new Set(splitWords(a));
  const tokensB = new Set(splitWords(b));
  if (!tokensA.size || !tokensB.size) return 0;
  const intersect: string[] = [];
  const diffAB: string[] = [];
  const diffBA: string[] = [];
  for (const t of tokensA) (tokensB.has(t) ? intersect : diffAB).push(t);
  for (const t of tokensB) if (!tokensA.has(t)) diffBA.push(t);
  if (intersect.length && (!diffAB.length || !diffBA.length)) return 100;

  const abJoined = sortedJoin(diffAB);
  const baJoined = sortedJoin(diffBA);
  const abLen = abJoined.length;
  const baLen = baJoined.length;
  const sectLen = intersect.join(" ").length;
  const sep = sectLen !== 0 ? 1 : 0;
  const sectAbLen = sectLen + sep + abLen;
  const sectBaLen = sectLen + sep + baLen;

  const result = normDistance(indelDistance(abJoined, baJoined), sectAbLen + sectBaLen);
  if (!sectLen) return result;
  const sectAbRatio = normDistance(sep + abLen, sectLen + sectAbLen);
  const sectBaRatio = normDistance(sep + baLen, sectLen + sectBaLen);
  return Math.max(result, sectAbRatio, sectBaRatio);
}

/** rapidfuzz.distance.Jaro.similarity, 0-1. */
export function jaro(s1: string, s2: string): number {
  if (!s1 && !s2) return 1;
  const patternLen = s1.length;
  const textLen = s2.length;
  if (!patternLen || !textLen) return 0;
  if (patternLen === 1 && textLen === 1) return s1 === s2 ? 1 : 0;

  let bound: number;
  if (textLen > patternLen) {
    bound = Math.floor(textLen / 2) - 1;
    if (textLen > patternLen + bound) s2 = s2.slice(0, patternLen + bound);
  } else {
    bound = Math.floor(patternLen / 2) - 1;
    if (patternLen > textLen + bound) s1 = s1.slice(0, textLen + bound);
  }
  const s1Flags = new Uint8Array(patternLen);
  const s2Flags = new Uint8Array(textLen);
  let common = 0;
  for (let i = 0; i < s1.length; i++) {
    const low = Math.max(0, i - bound);
    const hi = Math.min(i + bound, textLen - 1);
    const c = s1.charCodeAt(i);
    for (let j = low; j <= hi; j++) {
      if (!s2Flags[j] && s2.charCodeAt(j) === c) {
        s1Flags[i] = s2Flags[j] = 1;
        common++;
        break;
      }
    }
  }
  if (!common) return 0;
  let k = 0;
  let trans = 0;
  for (let i = 0; i < patternLen; i++) {
    if (!s1Flags[i]) continue;
    let j = k;
    for (; j < textLen; j++) {
      if (s2Flags[j]) {
        k = j + 1;
        break;
      }
    }
    if (s1.charCodeAt(i) !== s2.charCodeAt(j)) trans++;
  }
  trans = Math.floor(trans / 2);
  return (common / patternLen + common / textLen + (common - trans) / common) / 3;
}

/** rapidfuzz.distance.JaroWinkler.similarity with prefix_weight 0.1, 0-1. */
export function jaroWinkler(s1: string, s2: string, prefixWeight = 0.1): number {
  const maxPrefix = Math.min(s1.length, s2.length, 4);
  let prefix = 0;
  while (prefix < maxPrefix && s1[prefix] === s2[prefix]) prefix++;
  let sim = jaro(s1, s2);
  if (sim > 0.7) sim = Math.min(sim + prefix * prefixWeight * (1 - sim), 1);
  return sim;
}

const NON_WORD = /[\W_]+/g;

/** hdx RapidFuzzMatcher.default_scorer */
export function defaultScorer(name: string, possibleName: string): number {
  const score = tokenSetRatio(name, possibleName);
  const joined = ratio(name.replace(NON_WORD, ""), possibleName.replace(NON_WORD, ""));
  return joined >= 90 ? Math.max(score, joined) : score;
}

function longWords(words: Set<string>): Set<string> {
  return new Set([...words].filter((w) => w.length > 2));
}

/**
 * The veto in hdx RapidFuzzMatcher.place_name_scorer: true when the names
 * share a word, each has other words of 3+ characters, and one of the extra
 * words on the side with fewer has ratio < 60 to all of the other side's
 * ("central kalimantan" vs "kalimantan utara").
 */
export function placeNameVeto(name: string, possibleName: string): boolean {
  const words = new Set(splitWords(name));
  const possibleWords = new Set(splitWords(possibleName));
  const extra = longWords(new Set([...words].filter((w) => !possibleWords.has(w))));
  const possibleExtra = longWords(new Set([...possibleWords].filter((w) => !words.has(w))));
  const shared = [...words].some((w) => possibleWords.has(w));
  if (!shared || !extra.size || !possibleExtra.size) return false;
  const [fewer, more] = possibleExtra.size < extra.size ? [possibleExtra, extra] : [extra, possibleExtra];
  for (const word of fewer) {
    let best = 0;
    for (const other of more) best = Math.max(best, ratio(word, other));
    if (best < 60) return true;
  }
  return false;
}

/** hdx RapidFuzzMatcher.place_name_scorer */
export function placeNameScorer(name: string, possibleName: string): number {
  return placeNameVeto(name, possibleName) ? 0 : defaultScorer(name, possibleName);
}
