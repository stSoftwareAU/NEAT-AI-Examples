# NEAT-AI-Examples

Companion programs demonstrating how to use [`NEAT-AI`](https://github.com/stSoftwareAU/NEAT-AI). Each
example is designed to be run alongside the library and the Rust discovery
extension so you can reproduce real-world scenarios without touching production
data.

## Discovery: Recover a Missing Neuron

`discovery/discover_missing_neuron.ts` generates a wide (1,600 inputs) and long
(6,000 records) synthetic dataset, removes a known hidden neuron from the
reference creature, and then calls `Creature.discoveryDir()` with the new
`discoveryFocusNeuronUUIDs` override. The workload intentionally stresses the
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
deno run --allow-read --allow-write --allow-env --allow-ffi \
  discovery/discover_missing_neuron.ts
```

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
