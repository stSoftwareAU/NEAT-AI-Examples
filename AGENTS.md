# 🤖 AGENTS.md — Guidelines for Humans and AI Agents

## 🇦🇺 Language

Use Australian English spelling in all code, comments, and documentation (e.g. colour, behaviour,
organisation, favour, metre, centre).

## 🧪 Testing Philosophy

Every test in this project must be a **"what" test** — it verifies _what_ the code produces
(outputs, side effects, structure), never _how_ it produces it.

### ✅ "What" tests (good)

- Call a function with known input and assert the output value.
- Create a creature, activate it, and check that the result is finite.
- Generate data files and verify their existence and size.
- Remove a neuron and confirm the creature still validates and produces different output.

### ❌ "How" tests (bad — do not write these)

- Grep source code for a pattern or function name.
- Assert that one function calls another.
- Check that a specific algorithm or data structure is used internally.
- Inspect function bodies or count lines of code.

**Why?** "How" tests break whenever the implementation is refactored, even when behaviour is
unchanged. They add maintenance cost without catching real bugs.

## ⚡ Unit Tests vs Benchmarks

| Aspect                 | Unit test                      | Benchmark                       |
| ---------------------- | ------------------------------ | ------------------------------- |
| **Purpose**            | Verify correct results         | Measure execution time          |
| **Runs in parallel?**  | Yes (via `deno test`)          | No — run in isolation           |
| **Timing assertions?** | Never                          | Always                          |
| **Location**           | `*_test.ts` next to the module | `*_bench.ts` next to the module |
| **Runner**             | `deno test`                    | `deno bench`                    |

### 🤔 Why separate them?

Unit tests run in parallel with other tests, so any timing measurement is unreliable. If you switch
"quick sort" to "bubble sort", the unit tests should still pass (the output is the same), but a
benchmark will expose the regression.

### 📏 Rules

1. **Do not put timing assertions in unit tests.** If a test checks `performance.now()` or
   `Date.now()` deltas it belongs in a benchmark.
2. **Do not reduce iteration counts to make a "performance test" faster.** That defeats the purpose.
   Write a proper benchmark instead.
3. **Benchmarks are expected to take time.** That is their job.

## ✍️ Writing Tests

- Place test files next to the module they test, named `<module>_test.ts`.
- Use `Deno.test(...)` with descriptive names.
- Import the functions under test directly — do not shell out or grep files.
- Each test must exercise real code: import a function, call it with test data, and assert on
  results, exit codes, or side effects.
- Clean up temporary files in a `finally` block.
- Use `Deno.makeTempDirSync()` for any file I/O so tests never pollute the working tree.

## ✅ Running Quality Checks

Run `./quality.sh` before merging. It executes linting, formatting, unit tests, and all example
programs. See [README.md](README.md#-quality-check) for full details.

## 📦 Shared Utilities

The `common/` directory holds helpers that every example may reuse. Reach for these before
reinventing equivalent logic in a new example.

| Module                           | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `common/deterministic_random.ts` | Seeded PRNG for reproducible data generation.                 |
| `common/synthetic_data.ts`       | Synthetic dataset generation and scoring.                     |
| `common/working_dirs.ts`         | Standard hidden working-directory layout for examples.        |
| `common/data_cache.ts`           | Download datasets into hidden directories with on-disk cache. |
| `common/evolution_chart.ts`      | Dual-axis SVG renderer for NEAT evolution histories.          |
| `common/evolution_snapshot.ts`   | Capture creature state at checkpoint generations.             |

### `common/data_cache.ts`

`fetchDataset(opts)` downloads a dataset file into a hidden per-example directory (e.g.
`.synthetic-mnist/data/train.csv`) and caches it on disk so subsequent runs do not re-download. Pass
a single URL or an array of mirror URLs and (optionally) a SHA-256 digest:

```ts
import { fetchDataset } from "../common/data_cache.ts";

await fetchDataset({
  url: [
    "https://primary.example.com/mnist/train.csv",
    "https://mirror.example.com/mnist/train.csv",
  ],
  path: ".synthetic-mnist/data/train.csv",
  sha256: "abc123…",
});
```

Behaviour:

- Skips the download when the file already exists (and, when a digest is supplied, when the on-disk
  digest matches).
- Streams the response body straight to disk — no in-memory buffering.
- Verifies the digest after writing; on mismatch the partial file is deleted and the call rejects.
- Tries each mirror in turn; an HTTP error or network failure on one mirror falls back to the next,
  and the final error message lists every URL that was tried.

The helper relies on Deno's built-in `fetch` and `crypto.subtle` — no extra dependencies are added.

### `common/evolution_snapshot.ts`

`captureSnapshot(config, generation, creature, score, sampleOutputs?)` writes a snapshot file when
`generation` matches one of `config.checkpoints` (default `[1, 10, 100, 1000, 10000]`).
`loadSnapshots(outputDir)` reads them back, sorted by generation. Snapshots are byte-deterministic —
no timestamps, no run-specific paths — so reruns with the same seed produce identical files.

```ts
import { captureSnapshot, DEFAULT_CHECKPOINTS } from "../common/evolution_snapshot.ts";

const config = {
  checkpoints: [...DEFAULT_CHECKPOINTS],
  outputDir: ".synthetic-xor/snapshots",
};

for (let gen = 1; gen <= 10000; gen++) {
  captureSnapshot(config, gen, champion.exportJSON(), score, samples);
}
```

## 📂 Project Structure

```
common/
  deterministic_random.ts          — Seeded PRNG for reproducible data generation
  deterministic_random_test.ts     — Unit tests for the PRNG
  synthetic_data.ts                — Shared synthetic data generation and scoring
  synthetic_data_test.ts           — Unit tests for data generation and scoring
  working_dirs.ts                  — Shared working directory setup
  working_dirs_test.ts             — Unit tests for directory setup
  data_cache.ts                    — Hidden-directory dataset download with on-disk cache
  data_cache_test.ts               — Unit tests for the dataset cache
  evolution_chart.ts               — Dual-axis SVG renderer for NEAT evolution histories
  evolution_chart_test.ts          — Unit tests for the evolution chart renderer
  evolution_snapshot.ts            — Capture creature state at checkpoint generations
  evolution_snapshot_test.ts       — Unit tests for the evolution snapshot helper

crossover/
  crossover_example.ts             — Example: breed two creatures (crossover)
  crossover_example_test.ts        — Unit tests for the above
  run.sh                           — Runner script for the example

crispr_injection/
  crispr_injection.ts              — Example: splice a hand-crafted gene into a stalled population
  crispr_injection_test.ts         — Unit tests for the above
  svg.ts                           — SVG renderer for gene topology + fitness curve
  run.sh                           — Runner script for the example

discovery/
  discover_missing_neuron.ts       — Example: recover a removed neuron
  discover_missing_neuron_test.ts  — Unit tests for the above
  discover_missing_neuron_bench.ts — Benchmarks for the above
  run.sh                           — Runner script for the example

intelligent_design/
  improve_squash_example.ts        — Example: optimise activation functions
  improve_squash_example_test.ts   — Unit tests for the above
  improve_squash_example_bench.ts  — Benchmarks for the above
  run.sh                           — Runner script for the example

suggest_improvements/
  suggest_improvements.ts          — Analyse project and suggest improvements
  suggest_improvements_test.ts     — Unit tests for the above
  run.sh                           — Runner script for the example

quality.sh                         — Runs all tests and examples
deno.json                          — Deno configuration and dependencies
```
