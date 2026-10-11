# @pcode-checker/core

Matches messy place names to OCHA p-codes. Plain TypeScript with no Office dependency: it runs in the add-in, in Node and in the CLI.

```ts
import { Matcher } from "@pcode-checker/core";

const matcher = new Matcher(countryData); // a country file from data-build
matcher.match("Nassarawa LGA", { level: 2, parent: "Kano" });
// { pcode: "NG020031", name: "Nasarawa", score: 97.4, status: "fuzzy", method: "skeleton", candidates: [...], parentPcode: "NG020" }
```

`status` is one of:
- `exact`: the name, an alias or a p-code matched exactly, after normalisation;
- `fuzzy`: the best candidate scored at least the threshold (default 80) and clearly beat the rest;
- `ambiguous`: several units fit equally well, usually a name that repeats without a parent;
- `none`: nothing scored high enough.

## How a name is matched

Within the scope (the whole level, or the descendants of a parent given as a p-code or a name), the steps are tried in this order:

1. **Aliases** passed in by the caller (confirmed matches stored in the workbook).
2. **P-codes**: if the input is a p-code at this level, it is returned. Wrong prefixes and digit counts are fixed (`SYR02` and `SY2` both give `SY02`). This is ported from hdx's `convert_admin_pcode_length`.
3. **Exact** normalised name. Then the same without level words ("Kano State", "Governorate of Damascus"), then without Arabic articles ("Al-Hasakeh" becomes "Hasakeh").
4. **Skeleton**: a coarse key that is the same for common transliteration variants ("Deir-ez-Zor" and "Dayr az Zawr" both give `drzr`).
5. **Fuzzy**: a trigram index picks up to 60 candidates, which are scored with the best of ratio, token-sort ratio and Jaro-Winkler. Jaro-Winkler can add at most 10 points.

There are two vetoes, which score 0 whatever the strings look like:
- hdx's place-name veto: the names share a word but differ in another distinctive one.
- Numerals and direction words that conflict: "Zinder I" vs "Zinder II", "Aba North" vs "Aba South".

## Relationship to hdx-python-country

`src/hdx.ts` is a line-by-line port of `AdminLevel.get_pcode` and its default `RapidFuzzMatcher` + `place_name_scorer`. Its job is to check the port against `hdx-python-country` on the shared fixtures. It currently agrees on every case (`test/hdx.test.ts`, and `python -m eval` in `data-build`). Licence: see `NOTICE`.

`Matcher` builds on that behaviour. These differences are deliberate, and each one was kept because the evaluation showed it helps:

| Difference | Why |
|---|---|
| `normalise` keeps non-Latin letters, folds ß/æ/ø/ł…, expands St/Ste/Mt and writes 1-20 as Roman numerals | hdx's `normalise` drops all non-ASCII characters, so the Arabic names in EGY become "". "Zinder 2" should match "Zinder II". |
| Reports `ambiguous` instead of picking one | hdx returns one of the duplicates. On the fixtures it gets all 27 duplicate-name cases wrong without a parent. |
| No substring step | hdx matches any name containing the input ("Kano" matches "Kano Municipal"), which gives confident wrong answers. |
| Level-word, article and skeleton steps | They catch transliteration and labelling variants before fuzzy scoring. |
| Score = max(ratio, token-sort, capped Jaro-Winkler) instead of token-set ratio | Token-set gives 100 to any name whose words are a subset of the other's. |
| Numeral/direction veto | Without it, "Zinder I" vs "Zinder II" were ambiguous or wrong. |
| Trigram candidate index | Scoring all 82k IDN adm4 names for every row is too slow. |
| No Phonetics (Refined Soundex) option | hdx's default is RapidFuzz; Soundex encodes English pronunciation. |

On the synthetic fixtures (2,103 cases, SYR/NER/NGA):

| | accuracy | wrong p-codes | ambiguous flagged |
|---|---|---|---|
| hdx-python-country | 0.977 | 42 | 0/27 |
| core, threshold 80 | 0.996 | 2 | 27/27 |

Synthetic noise is easier than real data. Curated real-world cases (`fixtures/curated`) are the real test.

## Speed

The vitest speed tests, on a laptop:
- 5,000 messy NGA adm2 rows: about 0.4 s.
- IDN adm4 with a parent: about 0.3 ms per row.
- 82k adm4 units without a parent: about 1 ms per row, plus about 1.3 s once to build the index.

## CLI

```sh
npm run build -w @pcode-checker/core
echo '{"id":1,"input":"Dayr az Zawr","iso3":"SYR","level":1}' | node packages/core/dist/cli.js --data site/data
```

`--mode hdx` runs the hdx port instead.
