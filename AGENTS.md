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

## 🌱 No warm starts — evolution must start from random noise

Every in-scope example in this repository starts evolution from **uniform-random noise**. That is
the whole point of these demos: gen 1 is barely better than chance, and the captured checkpoint
snapshots show the network climbing from there to a competent solution. Telling the noise →
competent story is non-negotiable for an in-scope example — without it the demo loses its narrative.

### What counts as a warm start

Any of the following disqualifies the first generation as "random noise":

- A pretrained champion JSON loaded from disk and used to seed the population.
- A hand-crafted starting topology (specific neurons, layers, or wiring chosen by the author).
- Hand-crafted starting weights or biases — anything other than uniformly random initialisation.
- A resumed saved population or checkpoint restored from a previous run.
- Any other non-uniform-random initialisation of the first generation.

### The story we tell

Gen 1 is little better than noise; the example evolves to a competent solution from there. The
captured milestones (typically generations 1, 10, 100, 1000, and 10000) are the demo — they show the
network growing structure and finding weights as evolution progresses.

### In-scope examples (must start from random noise)

These examples exist to demonstrate evolution from noise → competent and must obey the policy:

- `xor_classification`
- `cart_pole`
- `snake_game`
- `mnist_classification`
- `stock_market`
- `lunar_lander`
- `mountain_car`
- `maze_navigation`

### Exempt examples (hand-crafted state IS the demo)

These examples demonstrate specific techniques where hand-crafted or pre-existing state is the
entire point of the demo, so the no-warm-start policy does not apply:

- `crispr_injection` — splices a hand-crafted edit gene into a stalled population.
- `neuron_pruning` — injects deliberately-constant neurons so pruning has something to remove.
- `discovery` — recovers a removed neuron from a known-good creature.
- `discovery_at_scale` — recovers from injected defects in a large pre-built creature.
- `intelligent_design` — systematically optimises activation functions on an existing creature.
- `crossover` — breeds two parent creatures into an offspring.
- `memetic_evolution` — re-seeds the population from an archive of fittest creatures.
- `mcmc_acceptance` — pure Metropolis-Hastings sampler, not an evolution demo.
- `synthetic_synapse` — densify-train-prune on an evolved sparse creature.
- `adaptive_mutation` — visualises the mutation operator distribution on a pre-built creature.
- `evolution_showcase` — long-form flagship run (still seeded minimally; see its README).

### Enforcement

The no-warm-start policy is enforced by **review and agent instructions** — humans and AI agents
read this section before touching an example. It is **not** enforced by a CI test, because the only
way a test could detect a warm start is by inspecting source code for specific patterns (e.g.
`importJSON`, hand-coded synapse arrays). That would be a "how" test and is explicitly forbidden by
the [Testing Philosophy](#-testing-philosophy) above.

If you are adding or modifying an in-scope example, confirm in the PR description that the first
generation is initialised from uniform-random noise.

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

| Module                             | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `common/deterministic_random.ts`   | Seeded PRNG for reproducible data generation.                 |
| `common/synthetic_data.ts`         | Synthetic dataset generation and scoring.                     |
| `common/working_dirs.ts`           | Standard hidden working-directory layout for examples.        |
| `common/data_cache.ts`             | Download datasets into hidden directories with on-disk cache. |
| `common/evolution_chart.ts`        | Dual-axis SVG renderer for NEAT evolution histories.          |
| `common/evolution_snapshot.ts`     | Capture creature state at checkpoint generations.             |
| `common/evolution_progress_svg.ts` | Multi-panel animated SVG strip rendered from snapshots.       |
| `common/large_creature.ts`         | Deterministic large creatures (~10k synapses) for size demos. |
| `common/episode_runner.ts`         | Shared per-episode rollout loop for agent examples.           |
| `common/outcome_bar_chart.ts`      | Per-scenario outcome bar chart (count panel + cell strip).    |

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

### `common/evolution_progress_svg.ts`

`renderEvolutionProgressSvg(snapshots, opts?)` consumes the snapshots loaded via
`loadSnapshots(...)` and returns a single multi-panel animated SVG string showing how the network
and its score evolved across the captured generations. Each panel displays a small topology diagram,
the generation label (e.g. "Gen 1", "Gen 10000"), and the score formatted to a configurable
precision (default three decimals). A score-progression polyline links the panels, and SMIL
`<animate>` elements pulse each panel's background colour in sequence so the eye is led from the
first generation through to the last. Output is byte-deterministic for identical inputs — no
external dependencies are added.

```ts
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

const snaps = loadSnapshots(".synthetic-xor/snapshots");
const svg = renderEvolutionProgressSvg(snaps, {
  caption: {
    finalScore: snaps[snaps.length - 1].score,
    totalGenerations: 10000,
    wallClockMs: 65_000,
  },
});
await Deno.writeTextFile(".synthetic-xor/evolution_progress.svg", svg);
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
  evolution_progress_svg.ts        — Multi-panel animated SVG strip rendered from snapshots
  evolution_progress_svg_test.ts   — Unit tests for the evolution-progress renderer
  large_creature.ts                — Deterministic large creature builder for size-adaptive demos
  large_creature_test.ts           — Unit tests for the large creature builder
  episode_runner.ts                — Shared per-episode rollout loop for agent examples
  episode_runner_test.ts           — Unit tests for the episode runner helper
  outcome_bar_chart.ts             — Per-scenario outcome bar chart (count panel + cell strip)
  outcome_bar_chart_test.ts        — Unit tests for the outcome bar chart renderer

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
