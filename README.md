# P-code checker

An Excel add-in that turns a column of messy place names into OCHA p-codes inside the workbook. It uses the [HDX Global P-code List](https://data.humdata.org/dataset/global-pcodes) (112 countries, 324k units). All matching runs locally, and no workbook data leaves the machine.

- **Task pane**: pick a name column (plus an optional parent column), a country and an admin level. P-code, matched name, score and status are written into four new columns next to the names, coloured by status. A review panel steps through ambiguous and low-scoring rows. Confirmed choices are saved as aliases in a hidden `_pcode_aliases` sheet and reused on later runs.
- **Formulas**: `=PCODE.GET(name, iso3, level, [parent])`, `=PCODE.NAME(pcode, [iso3])`, `=PCODE.PARENT(pcode, [iso3])`, and `=PCODE.MATCH(name, iso3, level, [parent])`, which spills p-code, name, score and status.
- **Versions**: the COD version used per country is stamped in a hidden `_pcode_meta` sheet. When the workbook opens and a newer version is hosted, the add-in warns. Old versions stay hosted, so stamped workbooks still resolve.
- **Offline**: country files are cached in IndexedDB by version after the first load.

Excel names custom functions `NAMESPACE.FUNCTION`, so the plain lookup is `PCODE.GET` rather than `PCODE`.

## Layout

```
data-build/          Python (uv): fetch, validate, split, fixtures, oracle, evaluation
packages/core/       TypeScript matcher, no Office dependency (vitest)
packages/addin/      Office add-in: task pane + custom functions in one shared runtime
fixtures/            golden cases shared by the core tests and the Python evaluation
.github/workflows/   test.yml, data-refresh.yml (monthly), deploy.yml (GitHub Pages)
```

The plan and the reasoning behind this split (Python for data and evaluation, the matcher in TypeScript only) are in [PLAN.md](PLAN.md). How the matcher works, and where it deliberately differs from `hdx-python-country`, is in [packages/core/README.md](packages/core/README.md).

## Development

You need Node 22+, and Python 3.11+ with [uv](https://docs.astral.sh/uv/).

```sh
npm install

# Data: download from HDX, validate, split into site/data (gitignored)
cd data-build
uv run python build.py
uv run pytest

# Matcher
cd ..
npm test                          # core + add-in unit tests
PCODE_DATA_DIR=site/data npm test -w @pcode-checker/core   # adds a real IDN adm4 speed test

# Evaluation against hdx-python-country (needs the core built)
npm run build -w @pcode-checker/core
cd data-build && uv run --group eval python -m eval

# Add-in: dev server on https://localhost:3000, serving site/data at /data
cd packages/addin
npm run dev-server
npm start            # sideload into Excel desktop
npm run start:web    # Excel on the web (see office-addin-debugging docs for the document URL)
```

The first `npm start` installs a localhost development certificate, which asks for confirmation.

## Data pipeline

`data-build/build.py` reads the dataset metadata from the CKAN API. It downloads the CSVs (sending a User-Agent and checking the MD5) only when `last_modified` has changed, then validates, then writes:

- `{ISO3}/{version}.json`: `{iso3, name, version, validFrom, lengths, units: [[pcode, name, parent, level], ...]}`;
- `index.json`: countries, current versions, every published version with its SHA-256, per-level counts, p-code prefixes, and the attribution text.

**Validation errors** stop the build:
- a duplicate p-code within one level;
- a missing parent;
- a p-code of the wrong length for the lengths table;
- more than one version in one country;
- a country whose row count drops by more than 10% (override with `--allow-drop ISO3`).

**Warnings** are reported but don't stop it. They cover known quirks of the source:
- 502 units have no name (KGZ adm3, MMR and LKA adm4, one COL adm3);
- MMR reuses 75 adm2 p-codes at adm3;
- the lengths table has blanks (LBN adm3 codes have no prefix) and alternatives (`2|3`).

## Deployment (GitHub Pages)

Everything is served from `https://renrmt.github.io/pcode-checker/`: the add-in at the root and the data under `/data/`. Serving both from one origin avoids CORS problems.

- **main** holds the code. `deploy.yml` builds the add-in and copies the `data` branch into `/data`.
- **data** is an orphan branch that holds the generated country files. Old versions accumulate there, which keeps `main` small.
- `data-refresh.yml` runs monthly (and on demand). It opens a PR against `data` with a summary of what changed. If validation fails, the run fails. Merging the PR redeploys the site through `deploy-on-data.yml` on the data branch.

One-time setup after pushing to GitHub:

1. **Settings → Pages → Source: GitHub Actions.**
2. **Settings → Actions → General → Workflow permissions**: allow GitHub Actions to create and approve pull requests.
3. Run **data-refresh** once by hand. It creates the `data` branch and triggers the first deploy.
4. Sideload `https://renrmt.github.io/pcode-checker/manifest.xml` in Excel (Insert → Add-ins → Upload My Add-in).

## Attribution

P-codes come from the Global P-code List published by UN OCHA's Information Systems Section on the Humanitarian Data Exchange, under [CC BY-IGO](https://creativecommons.org/licenses/by/3.0/igo/). The task pane shows this attribution, and `index.json` carries it.

The matcher ports parts of `hdx-python-country` and `hdx-python-utilities` (MIT, © 2016 Michael Rans) and of rapidfuzz's scorers (MIT); see [packages/core/NOTICE](packages/core/NOTICE).
