/**
 * Benchmarks for the synthetic-synapse training demo (audit #206).
 *
 * Measures the cost of the small reusable helpers (forward pass,
 * dataset generation, densify, prune) plus a single end-to-end run of
 * the new evolveDir-driven demo. The end-to-end bench is gated behind
 * a tiny config so `deno bench` finishes in seconds rather than the
 * 5-minute upper bound used by the runner.
 *
 * Run with:
 *
 *   deno bench --allow-read --allow-write --allow-env synthetic_synapse/
 */
import { Creature } from "@stsoftware/neat-ai";

import {
  buildTargetNetwork,
  densifyCreature,
  forward,
  generateDataset,
  INPUT_COUNT,
  OUTPUT_COUNT,
  pruneCreature,
  runSyntheticSynapseDemo,
  type SyntheticSynapseConfig,
} from "./synthetic_synapse_example.ts";

const BENCH_CONFIG: SyntheticSynapseConfig = {
  seed: 850850850,
  trainingSize: 16,
  heldOutSize: 16,
  targetError: 0.0001,
  timeoutMinutes: 0.05,
  populationSize: 6,
  maxIterationsPerPhase: 3,
  pruneThreshold: 0.04,
};

const target = buildTargetNetwork(BENCH_CONFIG);
const benchInput = new Float32Array(INPUT_COUNT).fill(0.3);

Deno.bench("synthetic_synapse: forward pass on target network", () => {
  forward(target, benchInput);
});

Deno.bench("synthetic_synapse: generate dataset (32 records)", () => {
  generateDataset(target, 32, 7);
});

Deno.bench("synthetic_synapse: densify + prune on a fresh seed creature", () => {
  const creature = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  const synthKeys = densifyCreature(creature);
  pruneCreature(creature, synthKeys, 0.001);
});

Deno.bench("synthetic_synapse: full demo run (small config)", async () => {
  await runSyntheticSynapseDemo(BENCH_CONFIG);
});
