# P-code checker: plan

_Written 2026-10-11. Phases 1–5 implemented 2026-10-11 (see README.md and "Implementation notes" at the end). Still open: phase 0's hand-labelled real-world cases (`fixtures/curated`), the manual checks in Excel, and phase 6 (publish)._

## Context

Project 4 in the hobby outline: an Office add-in that turns a column of messy place names into p-codes inside the workbook. This plan looks at whether to build it as a Python library first with a TypeScript port for the add-in, and whether doing both is worth it. The data source is the HDX **Global P-code List**, with no dependency on other personal projects such as hdx-location-data.

## Data source: HDX Global P-code List (checked 2026-10-11)

- Dataset `global-pcodes`, published by OCHA ISS from the OCHA ArcGIS server. Updated every 30 days (last on 2026-09-16). Licence: **CC BY-IGO**, so attribution is required.
- Files:
  - `global_pcodes.csv` (17 MB, 324k rows) has all admin levels.
  - `global_pcodes_adm_1_2.csv` (1 MB, 23k rows) has admin 1 and 2 only.
  - `global_pcode_lengths.csv` gives p-code lengths per country and level.
- Columns: `Location` (ISO3), `Admin Level`, `P-Code`, `Name`, `Parent P-Code`, `Valid from date`, `Version`. The file starts with a UTF-8 BOM.
- Coverage: 112 countries. Rows per level: adm1 1.9k, adm2 21k, adm3 84k, adm4 216k, adm5 1.9k. Indonesia alone has 90k rows.
- What the data means for the design:
  - There is **one name per unit, usually the Latin-script name**. The file has no alternative names and no Arabic or French columns, so the outline's feature "reverse lookup in each language" can't be built from this source. Aliases have to come from users (stored in the workbook) or from a small curated alias file.
  - There are **26.6k groups of duplicate names** within the same country and level. Matching must use the hierarchy (a parent column) at adm3 and below.
  - `Version` and `Valid from date` are given per country, so every match can be stamped with the version it used. HDX only serves the latest version, so keeping old versions means storing our own snapshots.
  - HDX blocks some HTTP clients (WebFetch got a 403; curl with a browser User-Agent works). The fetch script should send a User-Agent and use the CKAN API (`/api/3/action/package_show?id=global-pcodes`) to read `last_modified` and the download URLs.

## Honest assessment: Python library + TypeScript port?

**Verdict: don't build two full matching libraries.** Use Python for the data build and for evaluation. Put the matcher in TypeScript only.

Reasons:
1. **A Python matcher already exists.** OCHA's `hdx-python-country` (MIT) has `hdx.location.adminlevel.AdminLevel`. It loads this same global p-codes CSV by default and does phonetic and fuzzy name matching, parent-aware lookups and p-code length conversion. A new Python library would mostly duplicate it.
2. **The real gap is matching inside Excel.** Excel can't run Python in a way that fits the goal (see the next section), so the matcher that ships has to be TypeScript anyway.
3. **Two implementations drift apart.** Unicode normalisation, regex behaviour and Jaro-Winkler variants differ slightly between Python and JS. Shared test fixtures reduce this, but every rule change then has to be made, tested and released twice.
4. **Python still earns its place:**
   - The data build (download, validate, split per country, snapshot versions) is natural Python work.
   - Evaluating matching quality is easiest in pandas and notebooks, with `hdx-python-country` as a free baseline to beat.
5. **When a Python port would be worth it:** only if a later project (Aid explorer, Satellite) needs matching in a Python pipeline *and* the TS matcher clearly beats `hdx-python-country` on the evaluation set. By then the rules are stable and the shared fixtures exist, so porting is cheap. The TS core also runs in Node, so a CLI doesn't need Python.

### Can the add-in run on top of hdx-python-country directly?

Technically yes, but none of the routes is a good fit. A TS port of its algorithm is the better choice.

| Route | Problem |
|---|---|
| Pyodide (Python compiled to WebAssembly) inside the add-in | The runtime is ~10 MB. `hdx-python-country` depends on `hdx-python-utilities`, which brings in frictionless, openpyxl, xlrd, xlwt, ruamel.yaml, loguru and more, all for about 1,000 lines of matching code. Each time the task pane opens, it takes several seconds to start. Calling Python from the async custom functions is fragile. You could vendor just `adminlevel.py`, `matching.py` and the text helpers and stub the rest, but then you're maintaining a fork anyway. |
| Python API on a server (an MC1 or a Cloudflare Worker) | Workbook data leaves the machine. It needs hosting and uptime, and locked-down corporate networks often block it. That cancels the add-in's main selling point. |
| Python in Excel | Only the fixed Anaconda package set is available, so `hdx-python-country` can't be installed. It also needs Microsoft 365 and runs in Microsoft's cloud. |

**Decision: port, don't wrap.**
- `packages/core` is a TypeScript port of the matching approach in `AdminLevel`, `hdx.utilities.matching` (`Phonetics`, `RapidFuzzMatcher.place_name_scorer`) and `hdx.utilities.text.normalise`. The code is MIT-licensed, so keep its copyright notice.
- Its config ideas are reused too, such as admin name replacements and a "don't fuzzy-match" list.
- During development, `hdx-python-country` is the **reference oracle**: the Python evaluation runs every fixture through both. The two must agree, or each difference must be a deliberate improvement that is written down.
- Only the matching core is ported (a few hundred lines). Logging, config loading and URL retrieval are not.

## Architecture

```
pcode-checker/
  data-build/          Python (uv): fetch, validate, split, snapshot, fixtures, evaluation
  packages/core/       TypeScript matcher, no Office dependency (vitest)
  packages/addin/      Office JS add-in: task pane + custom functions (shared runtime)
  fixtures/            golden test cases (JSON), used by core tests and Python evaluation
  .github/workflows/   test.yml, data-refresh.yml (monthly cron), deploy.yml (GitHub Pages)
```

Everything is hosted on **GitHub Pages** at the same origin as the add-in, so there are no CORS problems. R2 isn't needed at this data size.

### 1. Data build (Python, `data-build/`)
- `fetch.py`: reads metadata from CKAN, then downloads `global_pcodes.csv` and `global_pcode_lengths.csv` only when `last_modified` has changed.
- `validate.py` checks that:
  - p-codes are unique;
  - every parent exists;
  - p-code lengths match the lengths table;
  - no names are empty;
  - row counts per country haven't dropped sharply since the previous build. A sharp drop is flagged.
- `split.py` writes one compact JSON file per country: `{iso3, version, validFrom, units: [[pcode, name, parent, level], …]}`. These go to `site/data/{iso3}/{version}.json`. Old versions are kept, so stamped matches still resolve.
- It also writes `site/data/index.json`, listing countries, the current version, levels, sizes and hashes, plus the attribution text.
- `data-refresh.yml` runs monthly: fetch, validate, split, then open a PR or commit. If validation fails, it fails loudly.

### 2. Matching core (TypeScript, `packages/core/`)
- Start by porting `hdx-python-country`'s behaviour: `normalise`, the phonetic match (Refined Soundex) and `place_name_scorer`. The extensions below are added only where the evaluation shows they help.
- **P-code detection:** if the input already looks like a p-code (prefix plus the length from the lengths table), validate it and return it.
- **Normalisation:**
  - Unicode NFKD, strip diacritics, lowercase, turn punctuation into spaces, collapse spaces.
  - Remove level words such as "governorate", "province", "district", "commune", "LGA" and "county".
  - Handle prefixes and abbreviations: `al-`, `el-`, `ad-` and `St`/`Saint`.
- **Skeleton key** for transliteration variants: ou→u, kh→h, dj/j, sh/ch, q/k, double letters collapsed, and vowels dropped after the first letter. This catches Arabic and French transliteration differences.
- **Finding candidates, in order:**
  1. exact normalised name;
  2. exact skeleton;
  3. fuzzy search over a trigram index.

  Scoring every name in Indonesia's adm4 list for every input row would be too slow, so the index is needed. When a parent is known, the search only looks inside that parent.
- **Scoring:** the maximum of Jaro-Winkler and a token-sort ratio.
- **Result:** `{pcode, name, score, status: exact|fuzzy|ambiguous|none, candidates[]}`. A result is `ambiguous` when the top two candidates score too close together, or when names are duplicated and no parent was given.
- **Hierarchy:** match the parent column first, then restrict the child search to that parent.
- Aliases are passed in by the caller (from the workbook alias table) and are checked before fuzzy matching.

### 3. Add-in (`packages/addin/`)
- Scaffold with the Yeoman Office generator (`yo office`, TypeScript, task pane with custom functions and a shared runtime), so the task pane and the formulas share one data cache.
- **Task pane:**
  - choose the name column, an optional parent column, the country and the admin level;
  - write p-code, matched name, score and status into the adjacent columns;
  - colour cells by status.
- **Review panel:** steps through ambiguous and low-score rows and shows candidates. Confirming one writes it to a hidden `_pcode_aliases` sheet, which is reused in later runs.
- **Custom functions:**
  - `=PCODE(name, iso3, level, [parent])`
  - `=PCODE.NAME(pcode)`
  - `=PCODE.PARENT(pcode)`
  - `=PCODE.MATCH(name, iso3, level, [parent])`, which spills p-code, name, score and status.
- **Version stamping:** the COD version per country used in the workbook goes in a hidden `_pcode_meta` sheet. On open, the add-in warns if the hosted version is newer.
- **Caching:** country files are cached in IndexedDB, keyed by version, so the add-in works offline after the first load. All matching runs locally and no workbook data leaves the machine.
- An attribution footer meets the CC BY-IGO requirement.

## Phases

| # | Milestone | Done when |
|---|---|---|
| 0 | Spike (1 weekend) | Data profiled for SYR, NER, NGA and IDN. A messy sample of real names has been run through `hdx-python-country` to get a baseline score. Normalisation rules are drafted from real names. |
| 1 | Data build | Per-country JSON plus the index are generated and validated. The monthly workflow runs green. |
| 2 | Core matcher | Golden fixtures pass. The TS port agrees with `hdx-python-country` on the oracle cases, and every difference is documented. On the evaluation set, accuracy is at least as good as `hdx-python-country`. |
| 3 | Task pane batch matching | A 5k-row column for NGA adm2 matches in under 5 s in Excel on the web and desktop. |
| 4 | Custom functions | All four functions work in a sheet and share the cache. |
| 5 | Review panel, aliases, version stamp | Aliases persist across sessions. A version change triggers the warning. |
| 6 | Publish | Hosted on Pages, manifest sideloaded, write-up for the hub. |

## Test data (`fixtures/`, built in `data-build/fixtures.py`)
- **Synthetic cases** made from the real names: diacritics stripped, single-letter typos, transliteration swaps, level words added, `al-` removed, different capitalisation.
- **Curated real-world cases:** admin names taken from public 3W, HNO and assessment datasets on HDX for SYR, NER and NGA, labelled by hand. These measure real accuracy, not just accuracy on synthetic noise.
- Format: `{input, iso3, level, parent?, expected_pcode | "AMBIGUOUS" | null}`.

## Verification
- `uv run pytest` in `data-build/`: validation rules, the split round trip (row counts per country equal the CSV) and fixture generation.
- `npm test` in `packages/core/`: vitest over all golden fixtures, plus a speed test on IDN adm4.
- `uv run python -m eval`: precision and recall at different score thresholds for the TS core (run through Node) against `hdx-python-country` on the curated set.
- Manual checks:
  - sideload the add-in with `npm start` in Excel desktop and on the web;
  - batch-match a sample sheet;
  - check the formulas, alias saving, offline reload and the version warning, using a doctored `index.json`.

## Implementation notes (2026-10-11)

Decisions made while building, where the plan was silent or the data disagreed with it:

- **Data storage:** the country files live on an orphan `data` branch, not on `main`. `data-refresh.yml` opens a PR against `data`; merging it redeploys the site through a small `deploy-on-data.yml` kept on that branch. Pages is at `https://renrmt.github.io/pcode-checker/`.
- **Validation follows the real data.**
  - Empty names (502 of them) only warn.
  - P-codes must be unique per (p-code, level), because MMR reuses adm2 codes at adm3.
  - The lengths table's blanks and `a|b` alternatives are handled.
  - Every country's rows have to share one version.
- **Function names:** Excel always shows custom functions as `NAMESPACE.ID`, so `=PCODE(...)` becomes `=PCODE.GET(...)`. `PCODE.NAME` and `PCODE.PARENT` take an optional `iso3`; without it the country comes from the p-code prefix, which `index.json` now records.
- **Oracle:** `fixtures/oracle/*.json` stores hdx-python-country's answers, so the TS hdx port (`packages/core/src/hdx.ts`) is tested in vitest without Python. It agrees on 2,103 of 2,103 cases. Scorer vectors (rapidfuzz ratio, token-set and token-sort ratio, Jaro-Winkler, hdx normalise) are checked the same way.
- **Scoring:** the max of ratio, token-sort ratio and Jaro-Winkler. Jaro-Winkler may add at most 10 points, because without a cap it rated short negatives too highly. There are two vetoes: hdx's place-name veto, and conflicting numerals or direction words ("Zinder I"/"II", "Aba North"/"South").
- **Not ported:** `Phonetics` (Refined Soundex). hdx's own default is now RapidFuzz.
- **Tooling:** TypeScript is pinned to 6.0. TypeScript 7 (the native compiler) has no JS API, which ts-loader and custom-functions-metadata need.
- **Synthetic results** (SYR/NER/NGA, 2,103 cases):
  - hdx-python-country: accuracy 0.977, 42 wrong p-codes, 0/27 ambiguous flagged.
  - core (threshold 80): accuracy 0.996, 2 wrong p-codes, 27/27 ambiguous flagged.

  Curated real-world cases are still needed for a real accuracy number.
