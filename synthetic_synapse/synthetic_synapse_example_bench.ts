/**
 * Benchmarks for the synthetic-synapse training demo.
 *
 * Measures the cost of each phase of the densify-then-prune workflow plus
 * the supporting building blocks (forward pass, dataset generation, full
 * end-to-end run). Run with:
 *
 *   deno bench --allow-read --allow-write --allow-env synthetic_synapse/
 */
import {
  buildStudentNetwork,
  buildTargetNetwork,
  DEFAULT_SYNTHETIC_SYNAPSE_CONFIG,
  densify,
  forward,
  generateDataset,
  prune,
  runSyntheticSynapseDemo,
  type SyntheticSynapseConfig,
  trainNetwork,
} from "./synthetic_synapse_example.ts";
import { renderSyntheticSynapseSVG } from "./svg.ts";

const BENCH_CONFIG: SyntheticSynapseConfig = {
  inputs: 4,
  hidden: 12,
  outputs: 2,
  sparseDensity: 0.18,
  seed: 850850850,
  heldOutSize: 32,
  trainingSize: 32,
  sparseEpochs: 20,
  densifiedEpochs: 20,
  learningRate: 0.05,
  pruneThreshold: 0.04,
};

const target = buildTargetNetwork(BENCH_CONFIG);
const trainingSet = generateDataset(target, BENCH_CONFIG.trainingSize, 1);
const benchInput = new Float32Array(BENCH_CONFIG.inputs).fill(0.3);

Deno.bench("synthetic_synapse: forward pass on student", () => {
  const network = buildStudentNetwork(BENCH_CONFIG);
  forward(network, benchInput);
});

Deno.bench("synthetic_synapse: generate held-out dataset (64 records)", () => {
  generateDataset(target, 64, 7);
});

Deno.bench("synthetic_synapse: train sparse phase only", () => {
  const network = buildStudentNetwork(BENCH_CONFIG);
  trainNetwork(network, trainingSet, BENCH_CONFIG.sparseEpochs, BENCH_CONFIG.learningRate);
});

Deno.bench("synthetic_synapse: densify only", () => {
  const network = buildStudentNetwork(BENCH_CONFIG);
  densify(network);
});

Deno.bench("synthetic_synapse: train densified phase", () => {
  const network = buildStudentNetwork(BENCH_CONFIG);
  trainNetwork(network, trainingSet, BENCH_CONFIG.sparseEpochs, BENCH_CONFIG.learningRate);
  densify(network);
  trainNetwork(network, trainingSet, BENCH_CONFIG.densifiedEpochs, BENCH_CONFIG.learningRate);
});

Deno.bench("synthetic_synapse: prune only", () => {
  const network = buildStudentNetwork(BENCH_CONFIG);
  densify(network);
  prune(network, BENCH_CONFIG.pruneThreshold);
});

Deno.bench("synthetic_synapse: full demo run (small config)", () => {
  runSyntheticSynapseDemo(BENCH_CONFIG);
});

Deno.bench("synthetic_synapse: full demo run (default config)", () => {
  runSyntheticSynapseDemo(DEFAULT_SYNTHETIC_SYNAPSE_CONFIG);
});

const renderResult = runSyntheticSynapseDemo(BENCH_CONFIG);
Deno.bench("synthetic_synapse: render SVG", () => {
  renderSyntheticSynapseSVG({
    phases: renderResult.phases,
    controlScore: renderResult.controlScore,
    controlSynapseCount: renderResult.controlSynapseCount,
    topologies: renderResult.topologies,
  });
});
