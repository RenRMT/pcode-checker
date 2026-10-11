// Text normalisation for name matching.
//
// hdxNormalise is an exact port of hdx.utilities.text.normalise and is only
// used by the hdx-compatible matcher. normalise is the matcher's own, wider
// version: it keeps non-Latin letters (hdx drops them, so Arabic names in EGY
// normalise to ""), folds letters NFKD can't decompose (ß, æ, ø, ł ...),
// expands St/Ste/Mt and writes numbers 1-20 as Roman numerals.

const PY_PUNCTUATION = "!\"#$%&()*+,-./:;<=>?@[\\]^_`{|}~"; // string.punctuation minus '
const PY_WHITESPACE = " \t\n\r\x0b\x0c";
const HDX_TO_SPACE = new Set([...PY_PUNCTUATION, ...PY_WHITESPACE]);

/** Port of hdx.utilities.text.normalise. ASCII letters and digits only. */
export function hdxNormalise(text: string): string {
  let out = "";
  let space = false;
  for (const ch of text.normalize("NFD")) {
    const c = ch.charCodeAt(0);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += ch;
      space = false;
    } else if (c >= 65 && c <= 90) {
      out += ch.toLowerCase();
      space = false;
    } else if (HDX_TO_SPACE.has(ch)) {
      if (space) continue;
      out += " ";
      space = true;
    }
  }
  return out.trim();
}

const FOLD: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
  ħ: "h",
  ŧ: "t",
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");
// Apostrophes and transliteration marks for ayn/hamza vanish, as in hdx.
const APOSTROPHES = /['’‘ʼʻʿʾ`´]/g;
const MARKS = /\p{M}/gu;
const NOT_WORD = /[^\p{L}\p{N}]+/gu;

const ROMAN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];
const EXPANSIONS: Record<string, string> = { st: "saint", ste: "sainte", mt: "mount" };
// "Zinder 2" and "Zinder II" are written both ways.
ROMAN.forEach((roman, n) => {
  if (n) EXPANSIONS[String(n)] = roman;
});

/** Lowercase, strip diacritics and punctuation, keep letters of any script. */
export function normalise(text: string): string {
  const base = text
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(FOLD_RE, (c) => FOLD[c])
    .replace(APOSTROPHES, "")
    .replace(NOT_WORD, " ")
    .trim();
  if (!base) return "";
  return base
    .split(" ")
    .map((w) => EXPANSIONS[w] ?? w)
    .join(" ");
}

// Words for admin units, in the languages of the countries covered. Matched on
// normalised text, so "Sub-district" is "sub district".
const LEVEL_PHRASES = [
  "local government area",
  "local government",
  "sub district",
  "sous prefecture",
  "governorate",
  "gouvernorat",
  "mohafazat",
  "muhafazat",
  "mohafaza",
  "muhafaza",
  "province",
  "provincia",
  "prefecture",
  "region",
  "district",
  "departement",
  "department",
  "commune",
  "municipality",
  "municipio",
  "lga",
  "county",
  "state",
  "ward",
  "cercle",
  "arrondissement",
  "wilayat",
  "wilaya",
  "nahiya",
  "nahia",
  "woreda",
  "kebele",
  "upazila",
  "zila",
  "tehsil",
  "localite",
  "locality",
];
const LEVEL_RE = new RegExp(`(?:^| )(?:${LEVEL_PHRASES.join("|")})(?: of)?(?= |$)`, "g");

/** Remove admin-level words ("governorate", "LGA" ...) from normalised text. */
export function stripLevelWords(normalised: string): string {
  const stripped = normalised.replace(LEVEL_RE, " ").replace(/ +/g, " ").trim();
  return stripped || normalised;
}

const ARTICLES = new Set([
  "al", "el", "ad", "ed", "ar", "er", "as", "es", "az", "ez", "an", "en", "at", "et",
  "ash", "esh", "ath", "adh", "ul", "il",
]);

/** Remove Arabic article words ("al", "el", "ad" ...) unless that empties the text. */
export function stripArticles(normalised: string): string {
  const words = normalised.split(" ").filter((w) => !ARTICLES.has(w));
  return words.length ? words.join(" ") : normalised;
}

const SKELETON_RULES: [RegExp, string][] = [
  [/tch/g, "ch"],
  [/ou/g, "u"],
  [/kh/g, "h"],
  [/gh/g, "g"],
  [/dj/g, "j"],
  [/dh/g, "d"],
  [/th/g, "t"],
  [/ph/g, "f"],
  [/sh|ch/g, "s"],
  [/q/g, "k"],
  [/ck/g, "k"],
  [/ee/g, "i"],
  [/[yw]/g, "i"],
];

function collapseDoubles(s: string): string {
  return s.replace(/(.)\1+/g, "$1");
}

function skeletonWord(word: string): string {
  let w = word;
  for (const [re, to] of SKELETON_RULES) w = w.replace(re, to);
  w = collapseDoubles(w);
  // keep the first letter, drop vowels and h after it
  w = w[0] + w.slice(1).replace(/[aeiouh]/g, "");
  return collapseDoubles(w);
}

/**
 * A coarse key that is equal for common transliteration variants of the same
 * name: "Deir-ez-Zor" and "Dayr az Zawr" -> "drzr", "Al-Hasakeh" and
 * "Hassaka" -> "hsk". Takes normalised text.
 */
export function skeleton(normalised: string): string {
  const words = stripArticles(normalised).split(" ").filter(Boolean);
  return words.map(skeletonWord).join("");
}

/** Padded character trigrams of a normalised name, for the candidate index. */
export function trigrams(text: string): string[] {
  const padded = `  ${text} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return [...out];
}
