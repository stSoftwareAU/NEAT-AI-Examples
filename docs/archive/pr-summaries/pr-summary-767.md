# Remove unused `EXPERIMENTS_DIR` export (Issue #767)

## Summary

Deleted the dead `export const EXPERIMENTS_DIR = populationPoolDirs().experiments;` declaration (and
its doc comment) from `mnist_classification/population_pool.ts`. Closes #767.

The constant had no importer anywhere in the repository — not in a module, not in a `_test.ts` file,
not in a comment. A repository-wide identifier sweep across `.ts`, `.sh`, `.md`, `.json`, `.yml` and
`.js` (excluding the vendored `NEAT-AI-scorer` / `NEAT-AI-core` checkouts) found the declaration and
nothing else, so no dynamic or reflective lookup exists either. `deno.json` has no `exports` entry
that would expose it downstream.

Live callers already reach the same path through `populationPoolDirs(explorationRoot).experiments` —
`intelligentDesignOutputDir()` and `wipePopulationPool()` both do, and both honour the caller's
exploration root, which the module-level constant could not. Nothing else changed:
`populationPoolDirs()` and the sibling constants `CREATURES_DIR`, `SAMPLER_DIR` (both of which have
live importers) and `TRACE_DIR` (doc comment explicitly reserves it for future use) are untouched.

## Evidence

Backend/CLI change only — there is no web interface to screenshot.

Identifier sweep before the removal:

```
$ grep -rn "EXPERIMENTS_DIR" --include="*.ts" --include="*.sh" --include="*.md" \
    --include="*.json" --include="*.js" --include="*.yml" . \
    | grep -v "NEAT-AI-scorer\|NEAT-AI-core"
mnist_classification/population_pool.ts:44:export const EXPERIMENTS_DIR = populationPoolDirs().experiments;
```

One occurrence — the declaration itself. The same sweep for the siblings shows `CREATURES_DIR` and
`SAMPLER_DIR` imported by `population_pool_test.ts`, confirming the asymmetry.

Test run after the removal:

```
$ deno test --allow-all mnist_classification/population_pool_test.ts < /dev/null
running 4 tests from ./mnist_classification/population_pool_test.ts
priorLoopPhaseNames lists earlier sampler loops ... ok (378µs)
experiments directory is created and wiped via populationPoolDirs ... ok (1ms)
saveSamplerLoopChampion round-trips under .sampler ... ok (3ms)
loadPopulationPoolSeeds refreshes .creatures from prior loops ... ok (10ms)

ok | 4 passed | 0 failed (19ms)
```

## Test Plan

- Added
  `mnist_classification/population_pool_test.ts::"experiments directory is created and wiped
  via populationPoolDirs"`
  — a "what" test that pins the behaviour the deleted alias stood in for, against a
  `Deno.makeTempDir()` exploration root:
  - `populationPoolDirs(root).experiments` resolves to `<root>/experiments`;
  - `intelligentDesignOutputDir("LOGISTIC", root)` returns
    `<root>/experiments/intelligent-design/LOGISTIC` and creates it on disk;
  - `wipePopulationPool(root)` removes the experiments tree.

  It asserts on returned paths and observable filesystem side effects, never on source text.

- Existing tests in the same file are unchanged and still pass.
