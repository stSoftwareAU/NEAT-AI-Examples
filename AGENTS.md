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
- Remove a neuron and confirm the creature still validates and produces different output

### ❌ "How" tests (bad — do not write these)

- Grep source code for a pattern or function name.
- Assert that one function calls another.
- Check that a specific algorithm or data structure is used internally.
- Inspect function bodies or count lines of code.
- Assert reference identity between an input and a result (e.g. `result.champion === seed`) — that
  pins an in-place-mutation detail, not observable behaviour. Assert what the result _is_ instead,
  via [`common/champion_contract.ts`](common/champion_contract.ts)
  ([#725](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/725)).
- Pin a renderer's exact colour hex literals — or any other expected value pasted straight from
  current output — when the contract is structural. Select SVG elements by their semantic `class`
  hook and assert the _behaviour_ instead: each category gets a distinct fill, the two series use
  different strokes, the car's fill changes once it crosses the flag. A legitimate restyle must not
  turn a test red ([#726](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/726)).

**Why?** "How" tests break whenever the implementation is refactored, even when behaviour is
unchanged. They add maintenance cost without catching real bugs.

### 🧬 Never hand-roll a `CreatureExport`

`CreatureExport` is a plain value object, not a boundary. A hand-rolled literal agrees with whatever
the test asserts, hiding field-name typos, missing fields, and drift in the exported shape — and
`as unknown as CreatureExport` stops the compiler warning at all. Build fixtures with
`makeCreatureExport({ input, output, hidden?, seed? })` from
[`common/creature_export_fixture.ts`](common/creature_export_fixture.ts), which exports a genuine
`Creature`. Omit `hidden` for a fresh seed (`new Creature(input, output)`, random weights each
call); pass `hidden` with a `seed` for a deterministic evolved-style topology. See
[#722](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/722).

## 🌱 No warm starts — evolution must start from random noise

Every in-scope example in this repository starts evolution from **uniform-random noise**. That is
the whole point of these demos: gen 1 is barely better than chance, and the captured milestones
(typically generations 1, 10, 100, 1000, and 10000) show the network climbing from there to a
competent solution. Telling the noise → competent story is non-negotiable for an in-scope example —
without it the demo loses its narrative.

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
network growing structure and finding weights as evolution progresses. Milestones — surfaced via the
return value of `evolveDir` and the `evolverl_milestone` events emitted by `evolveRL` / `evolveEnv`
— are the supported telemetry surface; see
[#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298) for the decision record.

### In-scope examples (must start from random noise)

These examples exist to demonstrate evolution from noise → competent and must obey the policy:

- `xor_classification`
- `cart_pole`
- `snake_game`
- `mnist_classification` — **exception (issue #518, factory-adoption tracker #517):** the fresh-run
  seed is built via the data-derived `Creature.forDataset(records, { cost: "CROSS_ENTROPY" })`
  factory (SOFTMAX outputs, factory-sized hidden layer, dead-pixel pruning) rather than uniform-
  random noise or the legacy `[128, 64]` hidden lookup. Adopting the factory _is_ the demonstration;
  structural growth beyond the seed still comes purely from `evolveDir`'s mutation operators. The
  `evolveDir` configuration is unchanged. The training/selection cost was switched from
  `CATEGORICAL_ERROR` (non-differentiable `1 − argmax accuracy`, removed upstream in NEAT-AI #2798)
  to `CROSS_ENTROPY` (softmax + cross-entropy) under issue #523; top-1 argmax accuracy is still
  reported but no longer drives evolution.
- `stock_market` — **exception (issue #519, factory-adoption tracker #517):** the fresh-run seed is
  built via the data-derived `Creature.forDataset(...)` factory (linear output, target-mean bias,
  data-derived hidden capacity) rather than uniform-random noise. Adopting the factory _is_ the
  demonstration; structural growth beyond the seed still comes purely from `evolveDir`'s mutation
  operators. The `evolveDir` configuration is unchanged.
- `lunar_lander`
- `mountain_car`
- `maze_navigation`
- `adaptive_mutation` — **exception (issue #533, factory-adoption tracker #517):** the fresh-run
  seed is built via the data-derived
  `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })` factory (LOGISTIC output coupled
  to the cost, a conservative factory-sized hidden layer, He/Xavier weight-init scaling) rather than
  the legacy bare `new Creature(4, 1)`. Adopting the factory _is_ the demonstration; seed weights
  and biases stay random and structural growth beyond the seed still comes purely from `evolveDir`'s
  unchanged mutation operators. The bare constructor baseline is retained as
  `buildRandomSeedCreature` for test / resume fixtures. The noise → competent classification arc is
  still the demo (rewired under #263 / #264).

### Exempt examples (hand-crafted state IS the demo)

These examples demonstrate specific techniques where hand-crafted or pre-existing state is the
entire point of the demo, so the no-warm-start policy does not apply:

- `crispr_injection` — splices a hand-crafted edit gene into a stalled population.
- `neuron_pruning` — injects deliberately-constant neurons so pruning has something to remove.
- `discovery` — labels a binary `.bin` training set from a hand-crafted reference creature (the
  reference is the demo's hand-crafted state); the NEAT seed itself is the minimal
  `new Creature(input, output)` per issue #207.
- `discovery_at_scale` — labels a binary `.bin` training set from a hand-crafted reference creature
  built via `buildLargeCreature(...)` (the reference is the demo's hand-crafted state). The NEAT
  seed itself is **factory-adoption exception (issue #535, factory-adoption tracker #517):** built
  via the data-derived `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })` factory
  (LOGISTIC outputs coupled to the cost, a conservative factory-sized hidden layer, He/Xavier
  weight-init scaling) rather than the legacy bare `new Creature(input, output)` (#208). Seed
  weights and biases stay random and structural growth beyond the seed still comes purely from
  `evolveDir`'s unchanged mutation operators; the bare-constructor baseline is retained as
  `buildRandomSeedCreature` for test / resume fixtures.
- `intelligent_design` — evolves a creature from a minimal seed via `evolveDir`, then systematically
  optimises activation functions on the evolved champion (audited under #214); listed here because
  the squash improvement scan operates on a hand-curated creature, even though the seed itself is
  `new Creature(input, output)`.
- `crossover` — breeds two parent creatures into an offspring. The two hand-crafted parents (and the
  offspring bred from them) are the demo's hand-crafted state and live **outside** the NEAT seed, so
  the no-warm-start exemption still holds. The `evolveDir` seed for the second stage is a
  **factory-adoption exception (issue #537, factory-adoption tracker #517):** it is built via the
  data-derived `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })` factory (LOGISTIC
  output coupled to the cost — matching Parent A's `(0, 1)` sigmoid labels — a conservative
  factory-sized hidden layer, He/Xavier weight-init scaling) rather than the legacy bare
  `new Creature(3, 1)`. Seed weights and biases stay random and structural growth beyond the seed
  still comes purely from `evolveDir`'s unchanged mutation operators; the bare-constructor baseline
  is retained as `buildRandomSeedCreature` for test / resume fixtures.
- `memetic_evolution` — re-seeds the population from an archive of fittest creatures. The two
  `evolveDir` seeds (memetic + control) are a **factory-adoption exception (issue #536,
  factory-adoption tracker #517):** both are built via the data-derived
  `Creature.forDataset(records, { cost: "BINARY_CROSS_ENTROPY" })` factory (LOGISTIC output coupled
  to the cost — matching the oracle's `[0, 1]` sigmoid targets — a conservative factory-sized hidden
  layer, He/Xavier weight-init scaling) rather than the legacy bare `new Creature(2, 1)`. Migrating
  both seeds keeps the memetic / control comparison fair. Seed weights and biases stay random and
  structural growth beyond the seed still comes purely from `evolveDir`'s unchanged mutation
  operators; the bare-constructor baseline is retained as `buildRandomSeedCreature` for test /
  resume fixtures.
- `mcmc_acceptance` — pairs an analytical Metropolis-Hastings sampler over a synthetic fitness
  landscape (the historical demo from #89) with a minimal-seed `evolveDir` over a binary `.bin`
  regression task (audited under #215); listed here because the analytical sampler runs outside any
  NEAT-AI evolution loop, even though the audited second stage seeds NEAT-AI from
  `new Creature(input, output)`.
- `synthetic_synapse` — densify-train-prune on an evolved sparse creature.
- `evolution_showcase` — long-form flagship run. **Factory-adoption exception (issue #534,
  factory-adoption tracker #517):** the fresh-run seed is built via the data-derived
  `Creature.forDataset(records, { cost: "MSE" })` factory (linear `IDENTITY` output coupled to the
  regression cost, an output bias warm-started to the target mean, a conservative factory-sized
  hidden layer, He/Xavier weight-init scaling) rather than the legacy bare `new Creature(4, 1)`.
  Adopting the factory _is_ the demonstration; seed weights and biases stay random and structural
  growth beyond the seed still comes purely from `evolveDir`'s unchanged mutation operators. The
  bare constructor baseline is retained as `buildRandomSeedCreature` for test / resume fixtures. See
  its README.

### Enforcement

The no-warm-start policy is enforced by **review and agent instructions** — humans and AI agents
read this section before touching an example. It is **not** enforced by a CI test, because the only
way a test could detect a warm start is by inspecting source code for specific patterns (e.g.
`importJSON`, hand-coded synapse arrays). That would be a "how" test and is explicitly forbidden by
the [Testing Philosophy](#-testing-philosophy) above.

If you are adding or modifying an in-scope example, confirm in the PR description that the first
generation is initialised from uniform-random noise.

### Milestone-sanctioned exception — NEAT-AI factory adoption (#517)

The factory-adoption tracker ([#517](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/517))
deliberately departs from the no-warm-start policy: examples migrated to
`Creature.forDataset(records, { cost })` (or the Tier-0
`Creature.forProblem({ inputs, outputs, cost })` sibling) have a factory-derived topology and
weight-init scaling before evolution begins, instead of a bare `new Creature(input, output)`.

Seed weights and biases remain random — only topology and scaling are factory-derived — and all
structural growth beyond the seed still comes from the unchanged mutation operators. Every
factory-adoption PR must call out the deliberate departure in its summary. See
[`docs/factory_adoption.md`](docs/factory_adoption.md) for the per-example adoption status and the
group-by-group decisions for supervised (A), RL/control (B), and mechanic-demo (C) examples.

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

| Module                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/champion_contract.ts`          | Behavioural assertions for an evolved champion — validates, keeps the seed's arity, activates to finite output (from [#725](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/725)).                                                                                                                                                                                                                                                                                                   |
| `common/feed_forward_network.ts`       | Shared analytical evaluation core for exported creatures — creature → layered `Network` conversion, deterministic forward pass (index-ordered so hidden→hidden cascades read live upstream activations), and MSE / held-out scorers (from [#775](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/775)).                                                                                                                                                                              |
| `common/deterministic_random.ts`       | Seeded PRNG for reproducible data generation.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `common/synthetic_data.ts`             | Synthetic dataset generation and scoring, plus the single place the `evolveDir` binary-record contract is stated — `writeBinaryDataset(dataset, dataDir, inputCount, outputCount)` writes `training.bin` (inputs then targets, Float32, no header) and `generateNetworkDataset(target, size, seed)` labels uniform `[-1, 1]` inputs with a target network's own outputs (from [#777](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/777)).                                          |
| `common/working_dirs.ts`               | Standard hidden working-directory layout for examples.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `common/data_cache.ts`                 | Download datasets into hidden directories with on-disk cache.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `common/evolve_dir_summary.ts`         | Summarise the milestone stats returned by `evolveDir` (from [#284](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/284)).                                                                                                                                                                                                                                                                                                                                                            |
| `common/large_creature.ts`             | Deterministic large creatures (~10k synapses) for size demos.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `common/episode_runner.ts`             | Shared per-episode rollout loop for agent examples.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `common/outcome_bar_chart.ts`          | Per-scenario outcome bar chart (count panel + cell strip).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `common/milestone_chart.ts`            | Dual-axis SVG renderer for milestone statistics from `evolveDir` and `evolveRL` / `evolveEnv` (from [#287](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/287)).                                                                                                                                                                                                                                                                                                                    |
| `common/multi_run_state.ts`            | Multi-run persistence helper: load/save champion + merged milestones across runs, plus a `--fresh` / `--timeout` / `--target-error` CLI flag parser (from [#318](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/318)). Snaps sub-`1e-6` "regressions" in recorded `error` between successive milestones to the prior value so float-jitter on a resumed champion does not produce spurious monitoring alerts ([#447](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/447)). |
| `common/multi_run_error_chart.ts`      | Multi-run error-curve SVG renderer plotting error vs cumulative generation with faint run-boundary markers (from [#319](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/319)).                                                                                                                                                                                                                                                                                                       |
| `common/multi_run_complexity_chart.ts` | Multi-run complexity-curve SVG renderer plotting neuron + synapse counts vs cumulative generation with faint run-boundary markers (from [#320](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/320)).                                                                                                                                                                                                                                                                                |
| `common/chart_scale.ts`                | Shared chart-geometry maths for every SVG chart renderer — extents (`minBy` / `maxBy`), the linear and log-X scales, and tick generation (`niceTicks` / `logTicks` / `niceStep`) (from [#776](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/776)).                                                                                                                                                                                                                                 |
| `common/chart_axis.ts`                 | Shared axis renderers (`renderXAxis` / `renderLeftAxis` / `renderRightAxis`, with label, group class and integer-tick mode as parameters) plus the deterministic number formatting and XML escaping the chart bodies share (from [#776](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/776)).                                                                                                                                                                                       |

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
- Streams the response body to a sibling `<path>.part` scratch file and only renames it onto the
  final path after the body is fully received (and the digest verified, when one is supplied). A
  process kill or full disk mid-download cannot leave a truncated file at the final path.
- Verifies the digest after writing; on mismatch the scratch file is deleted and the call rejects.
- Tries each mirror in turn; an HTTP error or network failure on one mirror falls back to the next,
  and the final error message lists every URL that was tried.

The helper relies on Deno's built-in `fetch` and `crypto.subtle` — no extra dependencies are added.

**Security — URL provenance (issue #420).** `fetchDataset` validates every supplied URL before
invoking `fetch`:

- Only `https://` URLs are accepted (plain `http://` is tolerated only against loopback hosts so the
  in-process test server keeps working).
- Schemes other than `http`/`https` — `file://`, `ftp://`, `data:` — are rejected.
- Literal-IP hostnames in RFC1918 private ranges, the IPv4 link-local range (`169.254.0.0/16`, where
  the AWS / GCP / Azure metadata service lives), IPv6 link-local (`fe80::/10`), IPv6 unique-local
  (`fc00::/7`), and the `metadata.google.internal` DNS alias are rejected.
- `fetch` is invoked with `redirect: "error"` so a 3xx response is reported as a per-URL failure
  instead of transparently followed.

These defences block accidental misuse but do not replace careful URL hygiene — callers must still
supply URLs from a trusted source (hard-coded constants or a digest-pinned manifest) and should set
`sha256` whenever the bytes come from a third party.

### Milestone telemetry helpers

NEAT-AI does not expose telemetry on every generation — examples chart only the milestone statistics
returned by `evolveDir` or emitted by `evolveRL` / `evolveEnv`. Reach for these helpers when an
example needs to report or visualise progress:

- [`common/evolve_dir_summary.ts`](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/284) —
  summarise the milestone stats returned by `evolveDir` (final score, milestone generations,
  wall-clock time) into a deterministic JSON record an example can write next to its other
  artefacts.
- [`common/milestone_chart.ts`](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/287) —
  dual-axis SVG renderer for the same milestone stream (left axis: best score, mean episode steps;
  right axis: best-creature neuron and synapse counts), with an optional log-X mapping for the wide
  dynamic range typical of evolutionary runs.

See [#298](https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/298) for the canonical decision
record on the milestone-only telemetry surface.

## 📂 Project Structure

```
common/
  deterministic_random.ts          — Seeded PRNG for reproducible data generation
  deterministic_random_test.ts     — Unit tests for the PRNG
  feed_forward_network.ts          — Shared creature → network conversion, forward pass, and scorers
  feed_forward_network_test.ts     — Unit tests for the shared feed-forward helpers
  synthetic_data.ts                — Shared synthetic data generation and scoring
  synthetic_data_test.ts           — Unit tests for data generation and scoring
  working_dirs.ts                  — Shared working directory setup
  working_dirs_test.ts             — Unit tests for directory setup
  data_cache.ts                    — Hidden-directory dataset download with on-disk cache
  data_cache_test.ts               — Unit tests for the dataset cache
  large_creature.ts                — Deterministic large creature builder for size-adaptive demos
  large_creature_test.ts           — Unit tests for the large creature builder
  episode_runner.ts                — Shared per-episode rollout loop for agent examples
  episode_runner_test.ts           — Unit tests for the episode runner helper
  outcome_bar_chart.ts             — Per-scenario outcome bar chart (count panel + cell strip)
  outcome_bar_chart_test.ts        — Unit tests for the outcome bar chart renderer
  milestone_chart.ts               — Dual-axis SVG renderer for evolveRL() milestone statistics
  milestone_chart_test.ts          — Unit tests for the milestone chart renderer
  evolve_dir_summary.ts            — SVG summary chart for evolveDir() return values
  evolve_dir_summary_test.ts       — Unit tests for the evolveDir summary renderer
  multi_run_state.ts               — Multi-run persistence helper (cross-run evolution)
  multi_run_state_test.ts          — Unit tests for the multi-run state helper
  multi_run_error_chart.ts         — SVG renderer: error vs cumulative generations across runs
  multi_run_error_chart_test.ts    — Unit tests for the multi-run error chart renderer
  multi_run_complexity_chart.ts    — SVG renderer: neurons + synapses vs cumulative generations across runs
  multi_run_complexity_chart_test.ts — Unit tests for the multi-run complexity chart renderer
  multi_run_boundary_thinning.ts   — Shared run-boundary label/tick thinning policy for both renderers
  multi_run_boundary_thinning_test.ts — Unit tests for the boundary thinning policy
  chart_scale.ts                   — Shared chart geometry: extents, linear/log scales, tick generation
  chart_scale_test.ts              — Unit tests for the shared chart geometry
  chart_axis.ts                    — Shared axis renderers + deterministic SVG number/text formatting
  chart_axis_test.ts               — Unit tests for the shared axis renderers

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
quality/bash_syntax.sh             — `bash -n` syntax gate for every *.sh file
deno.json                          — Deno configuration and dependencies
```
