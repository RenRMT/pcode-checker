# Fixtures

Shared test data for `packages/core` (vitest) and `data-build/eval` (Python).

| Path | What | Made by |
|---|---|---|
| `data/{ISO3}.json` | Country files for SYR, NER, NGA, in the same format the add-in loads | `data-build/fixtures.py` |
| `synthetic/{ISO3}.json` | Noisy variants of real names, with the right answer | `data-build/fixtures.py` |
| `curated/{ISO3}.json` | Real-world names, labelled by hand | you (see below) |
| `golden/handwritten.json` | Small hand-written cases that must all pass | by hand |
| `oracle/{ISO3}.json` | hdx-python-country's answer for every synthetic and curated case | `data-build/oracle.py` |
| `oracle/known-differences.json` | Cases where the TS hdx port may deliberately differ | by hand |
| `scorers.json` | Input/output vectors for hdx `normalise`, rapidfuzz scorers and `resolve_name_parts` | `data-build/oracle.py` |

## Case format

```json
{"id": "NGA-0042", "input": "Nassarawa", "iso3": "NGA", "level": 2, "parent": "NG020", "expected": "NG020031", "noise": "translit"}
```

- `parent` is optional: a parent p-code or name.
- `expected` is a p-code, `"AMBIGUOUS"` (the name is shared and nothing tells the units apart), or `null` (no unit should match).
- `noise` says how the input was made: `exact`, `case`, `diacritics`, `typo`, `translit`, `level_word`, `article`, `spacing`, `duplicate`, `duplicate_parent`, `negative`, or `curated`.

## Adding curated real-world cases

Synthetic noise is easy to beat; curated cases measure real accuracy. To add them:

1. Take admin names from a public 3W, HNO or assessment dataset on HDX for SYR, NER or NGA.
2. Copy `curated/TEMPLATE.json.example` to `curated/{ISO3}.json` and label each name with the right p-code, `"AMBIGUOUS"` or `null`. Give each case a unique `id`.
3. Regenerate the oracle answers: `cd data-build && uv run --group eval python oracle.py`.
4. Run `npm test -w @pcode-checker/core` and `uv run --group eval python -m eval --sets curated`.

For a country other than SYR, NER or NGA, first add its country file with `uv run python fixtures.py SYR NER NGA {ISO3}`.

## Regenerating

```sh
cd data-build
uv run python build.py                       # site/data from HDX
uv run python fixtures.py                    # data/ and synthetic/
uv run --group eval python oracle.py         # oracle/ and scorers.json
```

Synthetic cases are seeded, so they only change when the data does.
