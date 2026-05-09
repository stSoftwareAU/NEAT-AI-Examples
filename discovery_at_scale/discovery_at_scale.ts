#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi

/**
 * Discovery-at-Scale Demo — minimal-seed evolution + measured telemetry
 * (audit issue #208).
 *
 * The pre-audit demo crippled a hand-crafted ~200-neuron creature and
 * asked NEAT-AI's `discoveryDir` to recover injected defects. The audit
 * (#208) repurposes the example so the published evolution genuinely
 * *learns* the network structure from a minimal NEAT-AI seed:
 *
 *   1. The hand-crafted large reference creature is still built via
 *      `buildLargeCreature(...)`, but it is used **only** as the
 *      ground-truth that synthesises labels for the binary `.bin`
 *      training set. NEAT-AI never sees it as a seed.
 *   2. The seed passed to NEAT-AI is `new Creature(INPUT_COUNT,
 *      OUTPUT_COUNT)` — no hidden-layer hint, no pre-built
 *      `network.json`, no hand-tuned shape.
 *   3. `Creature.evolveDir(dataDir, options)` runs forward-only over the
 *      pre-generated `.bin` training set (per #190) until either the
 *      `targetError` threshold is reached or the `timeoutMinutes: 5`
 *      backstop fires.
 *   4. Per-generation telemetry (best/mean fitness + neuron / synapse
 *      counts) is captured via `onTrainingEvent` and emitted as a CSV
 *      plus two SVG charts so the README can quote the *measured*
 *      numbers from the latest run only.
 *
 * The pre-audit defect-injection helpers (`injectDefects`,
 * `snapshotTopology`, `creatureAsRaw`, `rawAsCreature`,
 * `loadDatasetSamples`, `runDiscoveryAtScaleDemo`) are retained as
 * exported utilities — they document the historical framing and are
 * still exercised by the test suite — but the runner path is the
 * minimal-seed `evolveDir` flow.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  type NeatOptions,
  safeWriteJson,
} from "@stsoftware/neat-ai";

import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import { buildLargeCreature } from "../common/large_creature.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";

import { renderDiscoveryAtScaleSVG } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".discovery-at-scale";

/** Path to the legacy showcase SVG kept for `readme_structure_test.ts`. */
export const SCREENSHOT_PATH = "docs/screenshots/discovery_at_scale.svg";

/** Mirror copy of the legacy SVG written under WORKING_ROOT/output/. */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "discovery_at_scale.svg");

/** Number of input neurons fed to the NEAT-AI seed and the reference creature. */
export const INPUT_COUNT = 6;

/** Number of output neurons fed to the NEAT-AI seed and the reference creature. */
export const OUTPUT_COUNT = 3;

/** Per-generation evolution-telemetry CSV path. */
export const EVOLUTION_CSV_PATH = "docs/data/discovery_at_scale/evolution.csv";

/** CSV header — schema mandated by issue #208. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path. */
export const FITNESS_SVG_PATH = "docs/screenshots/discovery_at_scale/fitness.svg";

/** Neuron / synapse count chart path. */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/discovery_at_scale/topology.svg";

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
 * Defaults for the legacy {@link runDiscoveryAtScaleDemo} helper. Sized
 * so the helper still runs end-to-end in well under two minutes on a
 * developer machine. The audit's runner path uses
 * {@link DEFAULT_AT_SCALE_EVOLUTION_CONFIG} below — these defaults are
 * retained only so the legacy defect-injection demo continues to work.
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
/*  Audit (#208) — minimal-seed evolution                              */
/* ------------------------------------------------------------------ */

/** Configuration for the minimal-seed evolution run. */
export interface AtScaleEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /** Wall-clock backstop in minutes (issue #208 mandates 5 as upper bound). */
  timeoutMinutes: number;
  /** NEAT population size. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterations: number;
  /** RNG seed forwarded to NEAT-AI for deterministic-ish runs. */
  seed: number;
}

/**
 * Defaults tuned so the demo converges via `targetError` well inside the
 * 5-minute backstop on a developer machine while still showing visible
 * neuron / synapse growth from the minimal seed.
 *
 * The reference creature this minimal seed has to imitate is built via
 * `buildLargeCreature(...)` with {@link REFERENCE_HIDDEN} hidden neurons,
 * so the function we are fitting is more complex than the basic
 * `discovery` example — that is the "at scale" framing of #208.
 */
export const DEFAULT_AT_SCALE_EVOLUTION_CONFIG: AtScaleEvolutionConfig = {
  // The reference creature is produced by `buildLargeCreature`, which
  // builds a moderately dense feed-forward network. A targetError of
  // 0.005 is tight enough that the minimal seed must grow real hidden
  // structure to satisfy it (the audit's "topology genuinely changes"
  // acceptance criterion) while still being reachable inside the
  // 5-minute backstop on a developer machine.
  targetError: 0.005,
  timeoutMinutes: 5,
  populationSize: 32,
  maxIterations: 600,
  seed: 208208,
};

/** Hidden-neuron count of the hand-crafted reference (label oracle). */
export const REFERENCE_HIDDEN = 24;

/** Connection density used when building the reference creature. */
export const REFERENCE_DENSITY = 0.3;

/** Random seed used when building the reference creature + dataset. */
export const REFERENCE_SEED = 208;

/** One row of per-generation evolution telemetry. */
export interface EvolutionRow {
  /** 1-based generation index across the run. */
  generation: number;
  /** Best fitness observed in this generation. */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /** Neuron count of this generation's champion. */
  neuronCount: number;
  /** Synapse count of this generation's champion. */
  synapseCount: number;
}

/** Result of {@link runMinimalSeedAtScaleEvolution}. */
export interface AtScaleEvolutionResult {
  /** The best creature found by `evolveDir`. */
  champion: Creature;
  /** Per-generation telemetry rows captured during the run. */
  rows: EvolutionRow[];
  /** Total wall-clock time of the evolution call, in milliseconds. */
  wallClockMs: number;
  /** Final per-record error returned by `evolveDir`. */
  finalError: number;
  /** Total generations completed. */
  generations: number;
  /** Initial neuron count of the minimal seed (before evolution). */
  seedNeuronCount: number;
  /** Initial synapse count of the minimal seed (before evolution). */
  seedSynapseCount: number;
}

/** Format a finite number for CSV emission with trimmed trailing zeros. */
function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/** Format the per-generation telemetry rows as a CSV string. */
export function formatEvolutionCsv(rows: readonly EvolutionRow[]): string {
  const lines: string[] = [EVOLUTION_CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.generation,
        formatCsvNumber(r.bestFitness),
        formatCsvNumber(r.meanFitness),
        r.neuronCount,
        r.synapseCount,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Iterations per `evolveDir` chunk. Chunking the run keeps the
 * per-generation telemetry chart in step with topology mutations: the
 * passed-in `creature` reference is only updated at the end of each
 * `evolveDir` call, so smaller chunks make the neuron / synapse line
 * climb in visible step changes rather than as a single jump at the end.
 */
const PHASE_CHUNK_ITERATIONS = 25;

/**
 * Run minimal-seed `evolveDir` against the binary `.bin` training set in
 * `dataDir`, capturing per-generation telemetry for the README.
 *
 * The seed passed in must be `new Creature(INPUT_COUNT, OUTPUT_COUNT)` —
 * this function deliberately does not construct the seed itself so the
 * caller (and the tests) can prove no hidden-layer hint leaks in.
 */
export async function runMinimalSeedAtScaleEvolution(
  seed: Creature,
  dataDir: string,
  config: AtScaleEvolutionConfig = DEFAULT_AT_SCALE_EVOLUTION_CONFIG,
): Promise<AtScaleEvolutionResult> {
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");
  if (config.maxIterations <= 0) throw new Error("maxIterations must be positive");

  const seedNeuronCount = seed.neurons.length;
  const seedSynapseCount = seed.synapses.length;

  const rows: EvolutionRow[] = [];
  const start = Date.now();
  const budgetMs = config.timeoutMinutes * 60_000;

  let evolved = 0;
  let finalError = Number.POSITIVE_INFINITY;

  while (evolved < config.maxIterations) {
    // The creature reference is updated by `evolveDir` at the end of
    // each call. Re-read its topology *before* the next chunk so the
    // event handler reports the latest neuron / synapse counts for
    // every generation inside the chunk.
    const segmentStartNeurons = seed.neurons.length;
    const segmentStartSynapses = seed.synapses.length;

    const elapsedMs = Date.now() - start;
    if (elapsedMs >= budgetMs) break;

    const remaining = config.maxIterations - evolved;
    const chunkIterations = Math.min(PHASE_CHUNK_ITERATIONS, remaining);

    const neatOptions: NeatOptions = {
      seed: config.seed + evolved,
      populationSize: config.populationSize,
      iterations: chunkIterations,
      targetError: config.targetError,
      timeoutMinutes: config.timeoutMinutes,
      // No feedbackLoop key → engine treats the run as forward-only.
      costOfGrowth: 0,
      // Push NEAT toward structural growth so the example genuinely
      // adds hidden neurons / inter-layer synapses from the minimal seed
      // — required by the audit's "neuron and synapse counts genuinely
      // change" acceptance criterion.
      mutationRate: 0.6,
      mutationAmount: 3,
      verbose: false,
      log: 0,
      threads: 1,
      onTrainingEvent: (event) => {
        if (event.kind !== "generation_complete") return;
        rows.push({
          generation: evolved + event.generation,
          bestFitness: event.bestFitness,
          meanFitness: event.averageFitness,
          neuronCount: segmentStartNeurons,
          synapseCount: segmentStartSynapses,
        });
      },
    };

    const result = await seed.evolveDir(dataDir, neatOptions);
    const completed = result.generation ?? chunkIterations;
    evolved += completed;
    finalError = result.error ?? finalError;

    if (finalError <= config.targetError) break;
    if (completed < chunkIterations) break;
  }

  // Patch the final row so the chart shows the post-evolution topology
  // — `evolveDir` updates the creature reference *after* the last event
  // fires inside the chunk, so without this fix-up the last row still
  // reports the pre-chunk counts.
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    last.neuronCount = seed.neurons.length;
    last.synapseCount = seed.synapses.length;
  }

  return {
    champion: seed,
    rows,
    wallClockMs: Date.now() - start,
    finalError,
    generations: evolved,
    seedNeuronCount,
    seedSynapseCount,
  };
}

/** Convert telemetry rows into the shape expected by the shared chart helpers. */
export function rowsToFitnessSamples(rows: readonly EvolutionRow[]): FitnessSample[] {
  return rows.map((r) => ({
    generation: r.generation,
    bestFitness: r.bestFitness,
    avgFitness: r.meanFitness,
  }));
}

/** Convert telemetry rows into the shape expected by the evolution chart helper. */
export function rowsToEvolutionSamples(rows: readonly EvolutionRow[]): EvolutionSample[] {
  return rows.map((r) => ({
    generation: r.generation,
    score: r.bestFitness,
    neurons: r.neuronCount,
    synapses: r.synapseCount,
  }));
}

/* ------------------------------------------------------------------ */
/*  End-to-end demos                                                   */
/* ------------------------------------------------------------------ */

/**
 * Legacy defect-injection helper retained for backwards compatibility.
 * Discovery is wrapped so a missing FFI library does not abort the rest
 * of the pipeline — the SVG and scores are produced regardless.
 *
 * The audit (#208) replaced the runner path with
 * {@link runMinimalSeedAtScaleEvolution}. This helper is no longer
 * called from the CLI, but the test suite still uses it to verify
 * `injectDefects`, `snapshotTopology`, and the score relationship
 * between the pristine and crippled creatures.
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
  //    required artefacts.
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
  console.log("🔬 Discovery-at-Scale Demo — minimal-seed evolution (issue #208)");
  console.log("");

  const dirs = setupWorkingDirs(WORKING_ROOT);

  // Stage 1 — Build the hand-crafted reference creature and synthesise
  // the binary `.bin` training set. The reference is the *label oracle*
  // only; NEAT-AI never sees it.
  console.log("== Stage 1/3: Generating binary training set from a hand-crafted reference ==");
  const reference = buildLargeCreature({
    inputs: INPUT_COUNT,
    hidden: REFERENCE_HIDDEN,
    outputs: OUTPUT_COUNT,
    density: REFERENCE_DENSITY,
    seed: REFERENCE_SEED,
  });
  console.log(
    `   Reference creature: ${reference.input} inputs, ${reference.neurons.length} neurons, ` +
      `${reference.synapses.length} synapses (label oracle only — NEAT-AI does not see it)`,
  );
  generateSyntheticData(reference, dirs.dataDir, {
    totalRecords: 256,
    recordsPerFile: 128,
    seed: REFERENCE_SEED ^ 0x1357,
  });
  // Persist the reference creature so reviewers can inspect it.
  const referencePath = join(dirs.creaturesDir, "reference.json");
  await safeWriteJson(referencePath, reference.exportJSON());
  console.log(`   Saved reference creature to ${referencePath}`);

  // Stage 2 — Evolve from the minimal seed.
  console.log("");
  console.log("== Stage 2/3: Evolving from a minimal NEAT-AI seed ==");
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  console.log(
    `   Seed: new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  console.log(
    `   Seed topology: ${seed.neurons.length} neurons, ${seed.synapses.length} synapses`,
  );
  const evolutionConfig = DEFAULT_AT_SCALE_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${evolutionConfig.targetError}, ` +
      `timeoutMinutes=${evolutionConfig.timeoutMinutes} (issue #208 backstop)`,
  );
  const result = await runMinimalSeedAtScaleEvolution(seed, dirs.dataDir, evolutionConfig);
  const finalRow = result.rows[result.rows.length - 1];
  console.log(
    `   Completed ${result.generations} generations in ` +
      `${(result.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(result.finalError) ? result.finalError.toFixed(4) : "n/a"
      })`,
  );
  if (finalRow) {
    console.log(
      `   Champion topology: ${finalRow.neuronCount} neurons, ` +
        `${finalRow.synapseCount} synapses ` +
        `(seed had ${result.seedNeuronCount} / ${result.seedSynapseCount})`,
    );
  }
  const championPath = join(dirs.creaturesDir, "champion.json");
  await safeWriteJson(championPath, result.champion.exportJSON());
  console.log(`   Saved evolved champion to ${championPath}`);

  // Stage 3 — Emit the per-generation telemetry artefacts.
  console.log("");
  console.log("== Stage 3/3: Writing per-generation telemetry (CSV + 2 SVGs) ==");
  if (result.rows.length === 0) {
    console.log("   ⚠️  No per-generation events captured — telemetry skipped.");
  } else {
    ensureDirSync("docs/data/discovery_at_scale");
    ensureDirSync("docs/screenshots/discovery_at_scale");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(result.rows));
    console.log(`   🗒️  Wrote ${EVOLUTION_CSV_PATH} (${result.rows.length} rows)`);

    const fitnessSvg = renderFitnessChartSVG(rowsToFitnessSamples(result.rows), {
      title: "Discovery at Scale — Best vs Mean Fitness",
    });
    await Deno.writeTextFile(FITNESS_SVG_PATH, fitnessSvg);
    console.log(`   📈 Wrote ${FITNESS_SVG_PATH}`);

    const topologySvg = renderEvolutionChartSVG(rowsToEvolutionSamples(result.rows), {
      title: "Discovery at Scale — Score, Neurons, Synapses per Generation",
    });
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, topologySvg);
    console.log(`   📈 Wrote ${TOPOLOGY_SVG_PATH}`);

    // Mirror the topology chart at the legacy showcase path so the main
    // README's "Unique Features Showcase" entry continues to render
    // (`readme_structure_test.ts` enforces the legacy path).
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, topologySvg);
    console.log(`   🖼️  Mirror at ${SCREENSHOT_PATH}`);
    ensureDirSync(join(WORKING_ROOT, "output"));
    await Deno.writeTextFile(WORKING_OUTPUT_PATH, topologySvg);
  }

  // Summary line — quoted in the README so reviewers can see the
  // measured numbers from the latest run.
  console.log("");
  console.log("== Summary ==");
  console.log(`   Reference creature: ${referencePath}`);
  console.log(`   Evolved champion:   ${championPath}`);
  if (finalRow) {
    console.log(
      `   Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${finalRow.meanFitness.toFixed(4)}  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(`   Wall-clock: ${(result.wallClockMs / 1000).toFixed(1)}s`);
  console.log(
    `\n🏁 Demo completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
