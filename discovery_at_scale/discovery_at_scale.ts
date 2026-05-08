#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi

/**
 * Discovery-at-Scale demo (issue #84).
 *
 * Demonstrates the NEAT-AI Discovery pipeline on a creature that is large
 * enough that random mutation alone cannot recover from injected damage.
 * The flow is:
 *
 * 1. Build a deterministic large creature with `buildLargeCreature`
 *    (~200 neurons, ~1k synapses).
 * 2. Generate synthetic training data from the pristine creature.
 * 3. Inject a mix of structural defects: saturated activation neurons,
 *    dead neurons, dormant synapses, and a bottleneck.
 * 4. Score baseline vs crippled to show the performance loss.
 * 5. Run `Creature.discoveryDir(...)` to attempt recovery.
 * 6. Detect defects on baseline + crippled by running activations across
 *    the dataset and bucketing each neuron by its statistics.
 * 7. Render `output/discovery_at_scale.svg` showing the before / after
 *    topology with defective neurons highlighted by category, plus a
 *    legend mapping each colour to a defect type.
 *
 * Discovery is wrapped in a try/catch — the underlying FFI library may be
 * unavailable in CI. When it fails the demo still produces the SVG and
 * reports baseline / crippled scores so the visualisation flow is fully
 * exercised.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, type NeatOptions } from "@stsoftware/neat-ai";

import { buildLargeCreature } from "../common/large_creature.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";

import { renderDiscoveryAtScaleSVG } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".discovery-at-scale";

/** Path to the SVG snapshot the runner emits, mirrored under docs/. */
export const SCREENSHOT_PATH = "docs/screenshots/discovery_at_scale.svg";

/** Mirror copy of the SVG written under WORKING_ROOT/output/. */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "discovery_at_scale.svg");

/** Configuration for {@link runDiscoveryAtScaleDemo}. */
export interface DiscoveryAtScaleConfig {
  /** Number of input neurons. */
  inputs: number;
  /** Number of hidden neurons. Should be large enough that random mutation
   * alone cannot recover from injected damage (issue #84). */
  hidden: number;
  /** Number of output neurons. */
  outputs: number;
  /** Connection density of the underlying sparse creature, in [0, 1]. */
  density: number;
  /** Random seed for the creature, dataset, and defect injection. */
  seed: number;
  /** Number of saturated-activation defects to inject. */
  saturatedCount: number;
  /** Number of dead-output defects to inject. */
  deadCount: number;
  /** Number of dormant (low-variance) defects to inject. */
  dormantCount: number;
  /** Number of dormant-synapse defects to inject (low-weight outgoing edges). */
  dormantSynapseCount: number;
  /** Total records in the synthetic dataset. */
  totalRecords: number;
  /** Maximum number of records per binary file. */
  recordsPerFile: number;
}

/**
 * Defaults sized so the demo runs end-to-end in well under two minutes on
 * a developer machine while still exercising the size-adaptive thesis of
 * issue #75.
 */
export const DEFAULT_DISCOVERY_AT_SCALE_CONFIG: DiscoveryAtScaleConfig = {
  inputs: 8,
  hidden: 200,
  outputs: 4,
  density: 0.05,
  seed: 84_840_084,
  saturatedCount: 4,
  deadCount: 4,
  dormantCount: 4,
  dormantSynapseCount: 8,
  totalRecords: 64,
  recordsPerFile: 32,
};

/** Defect category assigned to each neuron after analysis. */
export type DefectCategory =
  | "healthy"
  | "saturated"
  | "dead"
  | "dormant"
  | "bimodal"
  | "bottleneck";

/** Map from neuron index → defect category. */
export type DefectMap = Record<number, DefectCategory>;

/** Topology snapshot used by the SVG renderer. */
export interface TopologySnapshot {
  inputCount: number;
  hiddenCount: number;
  outputCount: number;
  neuronCount: number;
  /** Per-neuron defect category. */
  defects: DefectMap;
  /** Synapse list. `dormant` flags low-weight synapses. */
  edges: Array<{ from: number; to: number; dormant: boolean }>;
}

/** Combined result returned by {@link runDiscoveryAtScaleDemo}. */
export interface DiscoveryAtScaleResult {
  /** Baseline (pristine) score on the synthetic dataset. */
  baselineScore: number;
  /** Crippled (post-injection) score on the synthetic dataset. */
  crippledScore: number;
  /** Score of the discovery candidate, when discovery succeeded. */
  discoveredScore: number | null;
  /** Wall-clock duration of the discovery step in milliseconds. */
  discoveryDurationMs: number;
  /** Whether discovery returned a candidate creature. */
  discoveryFound: boolean;
  /** Optional reason why discovery did not run / produce output. */
  discoveryNote: string | null;
  /** Topology snapshot of the crippled creature. */
  beforeTopology: TopologySnapshot;
  /** Topology snapshot of the discovered (or crippled fallback) creature. */
  afterTopology: TopologySnapshot;
  /** Total neurons before discovery. */
  preNeuronCount: number;
  /** Total neurons after discovery. */
  postNeuronCount: number;
}

/* ------------------------------------------------------------------ */
/*  Defect injection                                                   */
/* ------------------------------------------------------------------ */

interface RawNeuron {
  type: "input" | "hidden" | "output" | "constant";
  squash?: string;
  bias?: number;
  index: number;
  uuid: string;
}

interface RawSynapse {
  from: number;
  to: number;
  weight: number;
  type?: "positive" | "negative" | "condition";
}

interface RawCreature {
  neurons: RawNeuron[];
  synapses: RawSynapse[];
  input: number;
  output: number;
}

/** Categorised indices of the neurons each defect was injected into. */
export interface InjectedDefects {
  saturated: number[];
  dead: number[];
  dormant: number[];
  /** Outgoing synapse keys ("from->to") that were marked dormant. */
  dormantSynapses: string[];
  /** Index of the bottleneck neuron, or -1 if not injected. */
  bottleneck: number;
}

/**
 * Inject a mix of structural defects into the cloned creature JSON. Returns
 * the indices grouped by defect category so the demo can report what was
 * injected.
 *
 * Saturated: a large positive bias makes TANH/LOGISTIC saturate.
 * Dead: zero incoming weights and bias 0 — activation collapses to 0 / 0.5.
 * Dormant: zero incoming weights and bias 0 (similar shape to dead, but for
 *          neurons whose squash is not centred at 0 — caught as low variance).
 * Dormant synapse: outgoing edges given weights of magnitude < 1e-4.
 * Bottleneck: route every output through one shared hidden neuron by adding
 *             an extra edge from that neuron to every output.
 */
export function injectDefects(
  creature: RawCreature,
  config: DiscoveryAtScaleConfig,
): InjectedDefects {
  const inputCount = creature.input;
  const outputCount = creature.output;
  const hiddenStart = inputCount;
  const hiddenEnd = creature.neurons.length - outputCount;
  const hiddenIndices: number[] = [];
  for (let i = hiddenStart; i < hiddenEnd; i++) hiddenIndices.push(i);

  // Deterministic shuffle driven by the config seed so injection is
  // reproducible across runs.
  const shuffleRng = makeRng(config.seed ^ 0xdeadbeef);
  for (let i = hiddenIndices.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    [hiddenIndices[i], hiddenIndices[j]] = [hiddenIndices[j], hiddenIndices[i]];
  }

  let cursor = 0;
  const take = (n: number): number[] => {
    const slice = hiddenIndices.slice(cursor, cursor + n);
    cursor += n;
    return slice;
  };

  const saturated = take(config.saturatedCount);
  const dead = take(config.deadCount);
  const dormant = take(config.dormantCount);

  // Saturated: enormous positive bias swamps any input — TANH → ~1.0.
  for (const idx of saturated) {
    creature.neurons[idx].bias = 12;
    creature.neurons[idx].squash = "TANH";
  }

  // Dead: zero all incoming synapses + zero bias → activation collapses.
  const deadSet = new Set(dead);
  const dormantSet = new Set(dormant);
  for (const synapse of creature.synapses) {
    if (deadSet.has(synapse.to) || dormantSet.has(synapse.to)) {
      synapse.weight = 0;
    }
  }
  for (const idx of dead) {
    creature.neurons[idx].bias = 0;
    creature.neurons[idx].squash = "TANH";
  }
  // Dormant: bias positioned so output is small but non-zero, low variance.
  for (const idx of dormant) {
    creature.neurons[idx].bias = 0.001;
    creature.neurons[idx].squash = "TANH";
  }

  // Dormant synapses: pick edges that survive (i.e. their `to` is healthy)
  // and shrink their weight to near zero.
  const protectedNeurons = new Set<number>([...saturated, ...dead, ...dormant]);
  const candidates: number[] = [];
  for (let i = 0; i < creature.synapses.length; i++) {
    const s = creature.synapses[i];
    if (protectedNeurons.has(s.to) || protectedNeurons.has(s.from)) continue;
    candidates.push(i);
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const dormantSynapses: string[] = [];
  for (let k = 0; k < Math.min(config.dormantSynapseCount, candidates.length); k++) {
    const synapse = creature.synapses[candidates[k]];
    synapse.weight = 1e-5;
    dormantSynapses.push(`${synapse.from}->${synapse.to}`);
  }

  // Bottleneck: pick one healthy hidden neuron and add an edge from it to
  // every output. The neuron now has unusually high outgoing degree —
  // detectable structurally.
  let bottleneck = -1;
  while (cursor < hiddenIndices.length) {
    bottleneck = hiddenIndices[cursor++];
    break;
  }
  if (bottleneck >= 0) {
    const seen = new Set<string>();
    for (const synapse of creature.synapses) {
      seen.add(`${synapse.from}->${synapse.to}`);
    }
    for (let o = 0; o < outputCount; o++) {
      const to = hiddenEnd + o;
      const key = `${bottleneck}->${to}`;
      if (!seen.has(key)) {
        creature.synapses.push({ from: bottleneck, to, weight: 0.4 });
        seen.add(key);
      }
    }
  }

  return { saturated, dead, dormant, dormantSynapses, bottleneck };
}

/* ------------------------------------------------------------------ */
/*  Defect detection                                                   */
/* ------------------------------------------------------------------ */

/** Thresholds used by {@link detectDefects}. */
export interface DetectionThresholds {
  /** Variance below which a neuron is treated as "low variance". */
  varianceLow: number;
  /** |mean activation| above which a low-variance neuron is "saturated". */
  saturatedAbsMean: number;
  /** |mean activation| below which a low-variance neuron is "dead". */
  deadAbsMean: number;
  /** Distinct activation values (rounded to 3 dp) below which "bimodal". */
  bimodalDistinctMax: number;
  /** Outgoing degree above which a neuron is structurally a "bottleneck". */
  bottleneckOutDegree: number;
  /** Synapse weight below which the synapse is "dormant". */
  dormantSynapseAbsWeight: number;
}

export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  varianceLow: 1e-3,
  saturatedAbsMean: 0.9,
  deadAbsMean: 0.05,
  bimodalDistinctMax: 3,
  bottleneckOutDegree: 6,
  dormantSynapseAbsWeight: 1e-4,
};

/**
 * Detect structural defects on the creature by running it forward through
 * a sampled dataset and bucketing each hidden neuron by its activation
 * statistics. Inputs and outputs are always classified as "healthy" so the
 * external interface of the network is never reported.
 *
 * Returns the per-neuron map plus a flagged copy of the synapse list.
 */
export function detectDefects(
  creature: RawCreature,
  samples: Float32Array[],
  thresholds: DetectionThresholds = DEFAULT_THRESHOLDS,
): { defects: DefectMap; edges: TopologySnapshot["edges"] } {
  const N = creature.neurons.length;
  const inputCount = creature.input;
  const outputCount = creature.output;

  // Per-neuron Welford accumulators + a Set of rounded activations for
  // bimodal detection.
  const mean = new Float64Array(N);
  const m2 = new Float64Array(N);
  const distinct: Array<Set<number>> = Array.from({ length: N }, () => new Set<number>());
  let n = 0;

  // Build incoming-by-target index for the forward pass.
  const incoming: Array<Array<{ from: number; weight: number }>> = Array.from(
    { length: N },
    () => [],
  );
  for (const s of creature.synapses) {
    incoming[s.to].push({ from: s.from, weight: s.weight });
  }

  for (const sample of samples) {
    if (sample.length !== inputCount) continue;
    const acts = forward(creature, sample, incoming);
    n++;
    for (let i = 0; i < N; i++) {
      const x = acts[i];
      const delta = x - mean[i];
      mean[i] += delta / n;
      m2[i] += delta * (x - mean[i]);
      // Round to 3 decimal places to count "distinct" values.
      distinct[i].add(Math.round(x * 1000) / 1000);
    }
  }

  // Per-neuron outgoing degree for bottleneck detection. We only count
  // hidden neurons towards the mean so input/output structural fan-out
  // does not skew the threshold.
  const outDegree = new Int32Array(N);
  for (const s of creature.synapses) {
    outDegree[s.from]++;
  }
  let hiddenSum = 0;
  let hiddenSquaredSum = 0;
  let hiddenN = 0;
  for (let i = inputCount; i < N - outputCount; i++) {
    const d = outDegree[i];
    hiddenSum += d;
    hiddenSquaredSum += d * d;
    hiddenN++;
  }
  const hiddenMean = hiddenN > 0 ? hiddenSum / hiddenN : 0;
  const hiddenVariance = hiddenN > 0
    ? Math.max(0, hiddenSquaredSum / hiddenN - hiddenMean * hiddenMean)
    : 0;
  const hiddenStddev = Math.sqrt(hiddenVariance);
  // Bottleneck = at least the static threshold AND well above the mean
  // outgoing degree of healthy hidden neurons (mean + 2σ). This stops the
  // detector flagging every above-average neuron in densely-connected
  // creatures while still catching the deliberately-injected bottleneck.
  const bottleneckCutoff = Math.max(
    thresholds.bottleneckOutDegree,
    Math.ceil(hiddenMean + 2 * hiddenStddev),
  );

  const defects: DefectMap = {};
  for (let i = 0; i < N; i++) {
    if (i < inputCount || i >= N - outputCount) {
      defects[i] = "healthy";
      continue;
    }
    const variance = n > 0 ? m2[i] / n : 0;
    const absMean = Math.abs(mean[i]);
    if (variance <= thresholds.varianceLow && absMean >= thresholds.saturatedAbsMean) {
      defects[i] = "saturated";
    } else if (variance <= thresholds.varianceLow && absMean <= thresholds.deadAbsMean) {
      defects[i] = "dead";
    } else if (variance <= thresholds.varianceLow) {
      defects[i] = "dormant";
    } else if (distinct[i].size <= thresholds.bimodalDistinctMax) {
      defects[i] = "bimodal";
    } else if (outDegree[i] >= bottleneckCutoff) {
      defects[i] = "bottleneck";
    } else {
      defects[i] = "healthy";
    }
  }

  const edges: TopologySnapshot["edges"] = creature.synapses.map((s) => ({
    from: s.from,
    to: s.to,
    dormant: Math.abs(s.weight) < thresholds.dormantSynapseAbsWeight,
  }));

  return { defects, edges };
}

/** Capture the topology snapshot needed by the SVG renderer. */
export function snapshotTopology(
  creature: RawCreature,
  samples: Float32Array[],
  thresholds: DetectionThresholds = DEFAULT_THRESHOLDS,
): TopologySnapshot {
  const { defects, edges } = detectDefects(creature, samples, thresholds);
  return {
    inputCount: creature.input,
    hiddenCount: creature.neurons.length - creature.input - creature.output,
    outputCount: creature.output,
    neuronCount: creature.neurons.length,
    defects,
    edges,
  };
}

/* ------------------------------------------------------------------ */
/*  Forward pass                                                       */
/* ------------------------------------------------------------------ */

function activateScalar(squash: string | undefined, z: number): number {
  switch ((squash ?? "IDENTITY").toUpperCase()) {
    case "IDENTITY":
      return z;
    case "TANH":
      return Math.tanh(z);
    case "LEAKYRELU":
      return z >= 0 ? z : 0.01 * z;
    case "RELU":
      return z >= 0 ? z : 0;
    case "SELU": {
      const a = 1.6732632423543772;
      const s = 1.0507009873554805;
      return z >= 0 ? s * z : s * a * (Math.exp(z) - 1);
    }
    case "LOGISTIC":
    default: {
      if (z >= 0) {
        const e = Math.exp(-z);
        return 1 / (1 + e);
      }
      const e = Math.exp(z);
      return e / (1 + e);
    }
  }
}

function forward(
  creature: RawCreature,
  input: ArrayLike<number>,
  incoming: Array<Array<{ from: number; weight: number }>>,
): Float32Array {
  const N = creature.neurons.length;
  const acts = new Float32Array(N);
  for (let i = 0; i < creature.input; i++) {
    acts[i] = activateScalar(creature.neurons[i].squash, input[i]);
  }
  for (let i = creature.input; i < N; i++) {
    let z = creature.neurons[i].bias ?? 0;
    const inc = incoming[i];
    for (let k = 0; k < inc.length; k++) {
      z += inc[k].weight * acts[inc[k].from];
    }
    acts[i] = activateScalar(creature.neurons[i].squash, z);
  }
  return acts;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Tiny seeded LCG — local to keep this module self-contained. */
function makeRng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    // Map signed int into [0, 1)
    return ((s >>> 0) % 0xffffff) / 0xffffff;
  };
}

/** Read every file in `dataDir` as Float32 records and return the inputs. */
export function loadDatasetSamples(
  dataDir: string,
  inputCount: number,
  outputCount: number,
): Float32Array[] {
  const recordFloats = inputCount + outputCount;
  const samples: Float32Array[] = [];
  for (const entry of Deno.readDirSync(dataDir)) {
    if (!entry.isFile || !entry.name.endsWith(".bin")) continue;
    const bytes = Deno.readFileSync(join(dataDir, entry.name));
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    for (let i = 0; i + recordFloats <= view.length; i += recordFloats) {
      samples.push(Float32Array.from(view.subarray(i, i + inputCount)));
    }
  }
  return samples;
}

/**
 * Convert a `Creature` to the index-based "legacy" raw shape this module
 * works with. The runtime `Creature` object exposes neurons and synapses
 * with numeric indices (inputs first, then hidden, then outputs) — exactly
 * what we need. We avoid `Creature.exportJSON()` which uses UUIDs and
 * omits inputs from the neuron list.
 */
export function creatureAsRaw(creature: Creature): RawCreature {
  const totalNeurons = creature.neurons.length;
  const inputCount = creature.input;
  const outputCount = creature.output;
  const outStart = totalNeurons - outputCount;

  const neurons: RawNeuron[] = creature.neurons.map((n, idx) => {
    const type: RawNeuron["type"] = idx < inputCount
      ? "input"
      : idx >= outStart
      ? "output"
      : "hidden";
    return {
      type,
      squash: n.squash ?? "IDENTITY",
      bias: type === "input" ? 0 : (n.bias ?? 0),
      index: idx,
      uuid: `n-${idx}`,
    };
  });

  const synapses: RawSynapse[] = creature.synapses.map((s) => ({
    from: s.from,
    to: s.to,
    weight: s.weight,
  }));

  return {
    neurons,
    synapses,
    input: inputCount,
    output: outputCount,
  };
}

/** Materialise a `Creature` from the index-based raw JSON shape. */
export function rawAsCreature(raw: RawCreature): Creature {
  return Creature.fromJSON(raw as unknown as CreatureExport);
}

/* ------------------------------------------------------------------ */
/*  End-to-end demo                                                    */
/* ------------------------------------------------------------------ */

/**
 * Run the demo end-to-end. Discovery is wrapped so a missing FFI library
 * does not abort the rest of the pipeline — the SVG and scores are
 * produced regardless.
 */
export async function runDiscoveryAtScaleDemo(
  config: DiscoveryAtScaleConfig = DEFAULT_DISCOVERY_AT_SCALE_CONFIG,
): Promise<DiscoveryAtScaleResult> {
  const dirs = setupWorkingDirs(WORKING_ROOT);

  // 1. Pristine creature drives both the dataset and the baseline score.
  const baseline = buildLargeCreature({
    inputs: config.inputs,
    hidden: config.hidden,
    outputs: config.outputs,
    density: config.density,
    seed: config.seed,
  });

  // 2. Synthetic dataset.
  const syntheticConfig: SyntheticConfig = {
    totalRecords: config.totalRecords,
    recordsPerFile: config.recordsPerFile,
    seed: config.seed ^ 0x1357,
  };
  generateSyntheticData(baseline, dirs.dataDir, syntheticConfig);

  // 3. Crippled creature: clone, inject defects, rebuild.
  const crippledRaw = creatureAsRaw(baseline);
  injectDefects(crippledRaw, config);
  const crippled = rawAsCreature(crippledRaw);
  crippled.validate();

  // 4. Score baseline + crippled on the same data directory.
  const baselineScore = (await baseline.scoreDir(dirs.dataDir, {})).score;
  const crippledScore = (await crippled.scoreDir(dirs.dataDir, {})).score;

  // 5. Discovery — wrapped so missing FFI does not fail the demo.
  const discoveryOptions: NeatOptions = {
    verbose: false,
    costOfGrowth: 0,
    discoverySampleRate: 1,
    discoveryBatchSize: 4,
    discoveryRecordTimeOutMinutes: 1,
    discoveryAnalysisTimeoutMinutes: 1,
    discoveryMaxNeurons: 4,
  };
  const startedAt = performance.now();
  let discoveredScore: number | null = null;
  let discoveryFound = false;
  let discoveryNote: string | null = null;
  let discoveredCreature: Creature | null = null;
  try {
    const result = await crippled.discoveryDir(dirs.dataDir, discoveryOptions);
    if (result.improvement) {
      discoveredCreature = Creature.fromJSON(result.improvement.creature);
      discoveredScore = (await discoveredCreature.scoreDir(dirs.dataDir, {})).score;
      discoveryFound = true;
    } else {
      discoveryNote = "discovery returned no improvement";
    }
  } catch (err) {
    discoveryNote = `discovery unavailable: ${(err as Error).message}`;
  }
  const discoveryDurationMs = performance.now() - startedAt;

  // 6. Topology snapshots — load samples from the data dir and run forward.
  const samples = loadDatasetSamples(dirs.dataDir, config.inputs, config.outputs);
  const beforeTopology = snapshotTopology(crippledRaw, samples);
  const afterRaw = discoveredCreature ? creatureAsRaw(discoveredCreature) : crippledRaw;
  const afterTopology = snapshotTopology(afterRaw, samples);

  // 7. Render SVG to working dir so the demo function alone produces all
  //    required artefacts. The CLI block additionally mirrors the file
  //    under docs/screenshots/.
  const svg = renderDiscoveryAtScaleSVG({
    before: beforeTopology,
    after: afterTopology,
    baselineScore,
    crippledScore,
    discoveredScore,
    discoveryFound,
    discoveryNote,
  });
  ensureDirSync(join(WORKING_ROOT, "output"));
  await Deno.writeTextFile(WORKING_OUTPUT_PATH, svg);

  return {
    baselineScore,
    crippledScore,
    discoveredScore,
    discoveryDurationMs,
    discoveryFound,
    discoveryNote,
    beforeTopology,
    afterTopology,
    preNeuronCount: crippled.neurons.length,
    postNeuronCount: discoveredCreature?.neurons.length ?? crippled.neurons.length,
  };
}

/* ------------------------------------------------------------------ */
/*  CLI entry point                                                    */
/* ------------------------------------------------------------------ */

if (import.meta.main) {
  const start = Date.now();
  console.log("🔬 Discovery-at-Scale Demo (issue #84)");
  console.log("");

  const result = await runDiscoveryAtScaleDemo();

  console.log("");
  console.log(`   baseline score   = ${result.baselineScore.toPrecision(6)}`);
  console.log(`   crippled score   = ${result.crippledScore.toPrecision(6)}`);
  if (result.discoveredScore !== null) {
    console.log(`   discovered score = ${result.discoveredScore.toPrecision(6)}`);
  } else {
    console.log(`   discovered score = (n/a)`);
  }
  console.log(`   discovery wall-clock = ${result.discoveryDurationMs.toFixed(0)}ms`);
  if (result.discoveryNote) {
    console.log(`   discovery note   = ${result.discoveryNote}`);
  }

  // Tally defect categories for the console summary.
  const tally = (snap: TopologySnapshot): Record<DefectCategory, number> => {
    const t: Record<DefectCategory, number> = {
      healthy: 0,
      saturated: 0,
      dead: 0,
      dormant: 0,
      bimodal: 0,
      bottleneck: 0,
    };
    for (const cat of Object.values(snap.defects)) t[cat]++;
    return t;
  };
  const before = tally(result.beforeTopology);
  const after = tally(result.afterTopology);
  console.log("");
  console.log("   defect tally     | before | after");
  for (const cat of ["saturated", "dead", "dormant", "bimodal", "bottleneck"] as const) {
    console.log(
      `     ${cat.padEnd(15)}| ${String(before[cat]).padStart(6)} | ${
        String(after[cat]).padStart(5)
      }`,
    );
  }

  // Mirror the SVG under docs/screenshots/ so it shows up inline on GitHub.
  const svg = await Deno.readTextFile(WORKING_OUTPUT_PATH);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`\n🖼️  Wrote ${WORKING_OUTPUT_PATH}`);
  console.log(`🖼️  Mirror at ${SCREENSHOT_PATH}`);

  console.log(
    `\n🏁 Demo completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
