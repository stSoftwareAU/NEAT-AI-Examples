# NEAT-AI-Examples

Companion programs demonstrating how to use
[`NEAT-AI`](https://github.com/stSoftwareAU/NEAT-AI). Each example is designed
to be run alongside the library and the Rust discovery extension so you can
reproduce real-world scenarios without touching production data.

## Intelligent Design: Squash Improvement Scan

`intelligent_design/improve_squash_example.ts` demonstrates how to use the
Intelligent Design module to systematically test different activation functions
(squashes) for each hidden neuron in a creature. This technique is used in
production workflows (e.g. at example.com/model-training) to optimise trained
models by finding better squash functions than those produced by random mutation.

### How it works

1. Creates a reference creature with several hidden neurons
2. Generates synthetic training data
3. Scores the baseline creature
4. Scans each hidden neuron, trying the target squash function
5. For neurons that improve, tries alternative squash functions
6. Combines the best improvements into a final creature

### Running the example

```bash
./intelligent_design/run.sh
```

By default, the example tries `GELU` as the target squash. You can specify a
different squash:

```bash
./intelligent_design/run.sh Swish
./intelligent_design/run.sh LeakyReLU
```

The script writes all artefacts to `.synthetic-intelligent-design/`, a hidden
directory ignored by git. You will find:

- `data/` – Binary training data for scoring
- `creatures/baseline.json` – The original reference creature
- `creatures/improved.json` – The improved creature (if improvements were found)
- `output/` – Individual improved creatures for each neuron

### Tacit Knowledge

In production workflows, successful squash substitutions are recorded as "tacit
knowledge" – mappings from neuron UUID to squash function. This knowledge can be
shared across machines (via a "hive" file in a git repository) or kept local.
When a model is loaded, tacit knowledge is applied to quickly reapply known-good
squash substitutions without rescanning.

See the [`NEAT-AI` Intelligent Design guide](../NEAT-AI/docs/INTELLIGENT_DESIGN.md)
for detailed documentation on the module and its APIs.

## Discovery: Recover a Missing Neuron

`discovery/discover_missing_neuron.ts` generates a wide (1,600 inputs) dataset,
removes a known hidden neuron from the reference creature, and then calls
`Creature.discoveryDir()` with the `discoveryFocusNeuronUUIDs` override. The
workload is tuned to finish within roughly a minute while still exercising the
Rust recorder and time-out logic so you can investigate failures such as
“Invalid string length” in a controlled setting.

### Prerequisites

- Clone `NEAT-AI`, `NEAT-AI-Discovery`, and this repository into the same parent
  directory.
- Build the Rust library via `../NEAT-AI-Discovery/scripts/runlib.sh` (which
  wraps `cargo build --release`) and expose the resulting artefact via
  `NEAT_AI_DISCOVERY_LIB_PATH` or by copying it into `~/.cargo/lib`.
- Grant Deno read/write, environment, and FFI permissions.

### Running the example

```bash
./discovery/run.sh
```

The helper script mirrors the production runner by pinning the Deno heap to
12 GB (`--v8-flags=--max-old-space-size=12288`) and forwards any additional
arguments to `deno run` so you can experiment with alternative discovery flags.

During startup the script logs each stage explicitly. The one-minute recording
and analysis timeouts apply only after the synthetic dataset has been generated,
so short bursts of silence while the data is written are expected.

By default the example deterministically removes the highest-error hidden
`LeakyReLU` neuron (based on a cached sample of synthetic records), ensuring the
crippled creature genuinely needs a new rectifier. You can still override the
target by exporting `DISCOVERY_TARGET_UUID=<neuron-uuid>` before running the
script, or set `DISCOVERY_TARGET_UUID=auto` to force the automatic selection. If
the overridden neuron barely changes the outputs (mean squared error below
`1e-4`) the script automatically falls back to the deterministic selection so it
remains a “perfect” demonstrator scenario.

Because the dataset is intentionally tiny, the script also lowers
`discoveryMinImprovementPercentage` to `0.0005` so that the subtle but genuine
improvements produced by rediscovering the missing neuron are accepted by the
Rust analysis stage.

When the removed neuron has direct observation inputs (for example
`input-791 → 1a814dd3-...`) the synthetic dataset “focuses” those observations
by zeroing every other input and scaling the drivers by `4×`. This makes the
missing neuron’s contribution obvious while keeping the rest of the creature
unchanged.

The script writes all artefacts to `.synthetic-discovery/`, a hidden directory
ignored by git. You will find:

- `data/` – Parquet-ready binary shards containing the synthetic observations.
- `creatures/baseline.json` – The untouched reference creature.
- `creatures/crippled.json` – The creature with the target neuron removed.
- `creatures/discovered.json` – The best candidate returned by discovery (when
  available).

Refer back to the [`NEAT-AI` discovery guide](../NEAT-AI/docs/DiscoveryDir.md)
for a detailed explanation of the surrounding orchestration and recommended job
flags.
