# 🧬 Adaptive Mutation Rate — Classifying 4-bit Parity from Random Noise

> 🌱 **Generation 1 starts from random noise** — `new Creature(4, 1)` with direct input→output
> synapses only. No hidden hint, no pretrained champion, no hand-crafted weights. NEAT-AI must
> **find** the parity classifier on its own; it is not given the answer.

**Acronyms.** _NEAT_ = NeuroEvolution of Augmenting Topologies — the algorithm that grows neural
network topology and weights together with an evolutionary search. _MSE_ = mean squared error.
_WASM_ = WebAssembly. _RL_ = reinforcement learning. _XOR_ = exclusive OR.

`adaptive_mutation.ts` evolves a NEAT-AI network that solves a **4-bit even-parity classification**
task — the textbook XOR generalisation. The minimal direct-only seed cannot represent parity at all
(parity is not linearly separable), so NEAT-AI **must** invent hidden neurons and inter-layer
synapses before the network can score above chance. That structural growth is exactly the signal the
demo is built around: the same NEAT-AI **adaptive mutation policy** that drives the growth naturally
tapers topology mutations as size rises and lets weight tuning take over.

Per the noise → competent policy in [`AGENTS.md`](../AGENTS.md), the example seeds NEAT-AI with
**only** `new Creature(4, 1)` (no warm start, no `network.json`, no hand-tuned shape), runs
`Creature.evolveDir(...)` over a binary `.bin` training set built from the 4-bit even-parity truth
table, and quotes real measured numbers from the latest local run.

![Adaptive mutation classification — topology grows, the analytic p(topology) decays, and
classification accuracy climbs from chance to the final solution](../docs/screenshots/adaptive_mutation.svg)

## 🌱 No warm start — gen 1 is uniform-random noise

The first generation is the bare `new Creature(4, 1)` constructor: four input neurons, one logistic
output neuron, four direct input→output synapses with uniform-random weights, a uniform-random
output bias, and **zero hidden neurons**. Per AGENTS.md every disqualifying form of warm start is
absent:

- ❌ No pretrained champion is loaded from disk.
- ❌ No hidden-layer hint or hand-crafted topology is set on the seed.
- ❌ No hand-crafted weights or biases — every initial parameter comes from NEAT-AI's seeded PRNG.
- ❌ No resumed population or checkpoint restore.

Gen 1's accuracy is little better than chance (around 0.5 on the balanced 16-row parity truth
table); from there NEAT-AI grows the topology and tunes the weights until the network classifies the
table to the configured target.

## 📈 Latest Measured Run

The numbers below come directly from the latest local run of `./adaptive_mutation/run.sh` — no
estimates, no qualifiers.

| Metric                    | Value                                  |
| ------------------------- | -------------------------------------- |
| Task                      | 4-bit even parity (16-row truth table) |
| Generations               | 461 (solved — `targetError` reached)   |
| Wall-clock                | 24.7 s                                 |
| Final training accuracy   | 0.9375 (15 of 16 rows correct)         |
| Held-out accuracy         | 0.9375                                 |
| Final best fitness        | 0.9500                                 |
| Held-out score (-MSE)     | -0.0487                                |
| Seed neurons / synapses   | 5 / 4                                  |
| Final neurons / synapses  | 30 / 70                                |
| `targetError`             | 0.05                                   |
| `timeoutMinutes` (safety) | 5                                      |

Topology genuinely changed: NEAT added 25 hidden neurons (5 → 30) and grew the synapse count from 4
to 70 across 461 generations, starting from a minimal direct-only seed that cannot represent parity
at all. Classification accuracy climbed from **0.5625 at gen 1** (about chance) to **0.9375 at the
final generation** — the captured noise → competent arc.

- Per-generation telemetry CSV:
  [`docs/data/adaptive_mutation/evolution.csv`](../docs/data/adaptive_mutation/evolution.csv)
- Schema: `generation, best_fitness, mean_fitness, accuracy, neuron_count, synapse_count`

![Adaptive Mutation — Classification Fitness per Generation](../docs/screenshots/adaptive_mutation/fitness.svg)

![Adaptive Mutation — Topology Growth (neuron and synapse counts per generation)](../docs/screenshots/adaptive_mutation/topology.svg)

## 🚀 How to Run

```bash
./adaptive_mutation/run.sh
```

The runner:

1. Generates the full 4-bit even-parity truth table (16 records, 4 binary inputs → 1 binary output)
   from `classification_task.ts`. Class balance is exact (8 even, 8 odd) by construction.
2. Writes the dataset as a Float32 `.bin` file under `.adaptive-mutation/data/`.
3. Seeds NEAT-AI with `new Creature(4, 1)` — minimal direct-only topology, no warm start.
4. Runs `Creature.evolveDir(dataDir, neatOptions)` with `targetError = 0.05` and
   `timeoutMinutes = 5`. The evolution loop is split into 50-iteration chunks so per-generation
   telemetry picks up structural growth and accuracy gains at fine resolution.
5. Writes the headline SVG, the classification-fitness chart, the topology chart, the per-generation
   CSV, and the champion creature JSON. The whole run completes well inside the 5-minute backstop on
   a developer machine.

## 🧠 Why NEAT-AI Adapts the Mutation Rate

NEAT-AI's evolutionary search picks one mutation operator per attempt. If every creature, regardless
of size, had the same chance of receiving an `ADD_NODE` mutation, big creatures would explode in
size without ever finishing weight tuning. NEAT-AI's mutation policy reads the creature's current
size and reduces the topology share as size grows.

A useful closed-form approximation of the policy is

```
p(topology) = baseTopologyProb / (1 + size / sizeScale)
```

with `baseTopologyProb = 0.6`, `sizeScale = 80`, and `size = hidden + synapses`. The headline SVG
above overlays this analytic curve (orange, right axis) against the **measured** size curve (green,
left axis) and the **measured classification accuracy** (blue, lower panel). As size rises across
the run, `p(topology)` collapses toward zero, exactly as the policy intends — and accuracy climbs in
step from near-chance to the target.

| Aspect         | Tiny seed (size ≈ 9) | Final creature (size ≈ 100) |
| -------------- | -------------------- | --------------------------- |
| Topology share | High — needs growth  | Lower — refines weights     |
| Failure mode   | Stuck at chance acc. | Bloat without refinement    |

## 🔧 How It Works

```mermaid
flowchart LR
    DATA["📊 4-bit even-parity truth table<br/>4 binary inputs → 1 binary label<br/>(16 rows, balanced 8/8)"]
    BIN["💾 training.bin<br/>(Float32 little-endian)"]
    SEED["🌱 Minimal NEAT seed<br/>new Creature(4, 1)<br/>direct edges only<br/>(uniform-random noise)"]
    EVOLVE["🧬 evolveDir<br/>targetError + timeoutMinutes:5<br/>chunked iterations"]
    POLICY["⚖️ Adaptive policy<br/>p(topology) tapers as size grows"]
    TELEMETRY["📈 Per-generation telemetry<br/>CSV + fitness.svg + topology.svg<br/>+ accuracy curve"]
    CHAMP["💾 champion.json"]

    DATA --> BIN --> EVOLVE
    SEED --> EVOLVE
    EVOLVE --> POLICY
    POLICY --> EVOLVE
    EVOLVE --> TELEMETRY
    EVOLVE --> CHAMP
```

The classification target is the textbook **even-parity detector**: given four bits, return `1` if
the number of `1` bits is even (count ∈ {0, 2, 4}), else `0`. This is the standard XOR
generalisation — a single direct input→output synapse layer cannot fit the truth table, so NEAT-AI
**must** invent hidden neurons before accuracy can move off chance. The captured noise → competent
arc — gen 1 ≈ chance, final ≥ target accuracy — is exactly what the demo is built to show.

### Why `evolveDir` rather than per-step `activate()`?

The training task is a pre-generated binary `(input, target)` set — the canonical "binary-data +
`evolveDir`" categorisation from the parent audit ([issue #203]). `evolveDir` exercises NEAT-AI's
full feature set (back-propagation, structure discovery, WASM/SIMD/GPU parallelism) and is orders of
magnitude faster than per-call `activate()` for supervised classification. Per-step `activate()` is
reserved for interactive simulations / RL agents where the next observation depends on the previous
action.

[issue #203]: https://github.com/stSoftwareAU/NEAT-AI-Examples/issues/203

## 📤 Output

- `docs/screenshots/adaptive_mutation.svg` — headline two-panel chart (measured size + analytic
  policy curve in the upper panel, measured classification accuracy in the lower panel), with a
  caption quoting the latest measured generations, wall-clock, final accuracy and held-out -MSE. A
  mirror copy is also written to `.adaptive-mutation/output/adaptive_mutation.svg`.
- `docs/screenshots/adaptive_mutation/fitness.svg` — best vs mean classification fitness per
  generation.
- `docs/screenshots/adaptive_mutation/topology.svg` — neuron and synapse counts per generation.
- `docs/data/adaptive_mutation/evolution.csv` — per-generation telemetry CSV with the schema
  `generation, best_fitness, mean_fitness, accuracy, neuron_count, synapse_count`.
- `.adaptive-mutation/creatures/champion.json` — final champion creature for downstream inspection.

## 🧪 Tests

`adaptive_mutation_test.ts` verifies (with "what" tests — no source-level grepping):

- `topologyProbability` decreases monotonically with size, matches the documented closed form, and
  rejects invalid policies / negative sizes.
- `runAdaptiveMutationDemo` rejects invalid configs, emits per-generation telemetry rows with finite
  `bestFitness`, a measured `accuracy` in `[0, 1]`, and positive neuron/synapse counts; returns a
  champion of the right I/O shape; and reports a finite held-out accuracy, held-out score and
  wall-clock.
- The demo evolves a real classification champion from the minimal seed — held-out accuracy lies in
  `[0, 1]` and at least one telemetry row carries a finite measured accuracy, with the live
  classifier accuracy agreeing with the returned champion.
- `creatureHeldOutScore` returns a finite non-positive value for any dataset and 0 for an empty one.
- `formatEvolutionCsv` emits the canonical header (now including the `accuracy` column) and one row
  per generation, replacing non-finite numbers with 0.
- The three SVG renderers produce well-formed output containing the expected CSS classes (including
  the new `classification-accuracy` curve on the headline SVG and the classification-fitness labels
  on the fitness chart) and reject empty input.
- `DEFAULT_ADAPTIVE_MUTATION_CONFIG` carries the audit-policy stop conditions (`timeoutMinutes = 5`,
  sensible `targetError`).
- The `classification_task.ts` primitives validate the truth table, deterministic dataset
  generation, binary `.bin` writing, and the classifier accuracy helper.

## 🧰 NEAT-AI Features Used

This example exercises NEAT-AI's adaptive-mutation policy through real evolution from a minimal seed
on a concrete classification problem.

Features exercised (links go to upstream
[`COMPARISON.md`](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md)):

- **[Hyperparameter Self-Adaptation](https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md#what-weve-implemented)**
  — captures the operator-distribution shift indirectly via the measured topology trajectory: the
  network grows aggressively from the minimal seed while the analytic policy curve collapses toward
  zero, exactly as the adaptive policy intends.
- **Binary `.bin` training set + `evolveDir`** — canonical fast supervised path; the parity truth
  table is pre-generated once and consumed by NEAT-AI's optimised evolution pipeline.
- **`targetError + timeoutMinutes` stop conditions** — the audit policy from issue #203.
- **Structural mutation from a minimal seed** — `ADD_NODE` and `ADD_CONN` operators invent the
  hidden topology that direct-only input→output edges cannot represent.
