/**
 * XOR Classification Example
 *
 * Evolves a NEAT-AI creature to learn the XOR truth table — the
 * canonical "Hello World" of neuroevolution.
 *
 * 🌱 **Generation 1 starts from random noise.** The initial creature is
 * built by the NEAT-AI library's uniform-random `new Creature(2, 1)`
 * constructor — direct input → output synapses with random weights and
 * a random output bias drawn from the seeded global PRNG. **No
 * topology, weights, or biases are hand-specified by this example.**
 * Structural mutation (add-neuron, add-synapse, weight tuning) is
 * delegated to the NEAT-AI library via `creature.evolveDir(...)`. XOR
 * is not linearly separable, so the random direct-only seed cannot
 * solve the task — NEAT must invent at least one hidden neuron to
 * succeed.
 *
 * Inputs (per sample): `[a, b]` ∈ {0, 1}^2.
 * Output: a scalar in `(0, 1)`. Sample is classified as `1` when the
 * output is `>= 0.5`, else `0`.
 * Fitness: 1 - mean squared error across the four samples (higher is
 * better). The task is "solved" when every truth-table row is
 * classified correctly AND the mean squared error drops below
 * `errorThreshold`. A hard `maxGenerations` cap stops the run even if
 * the threshold is not reached.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  createSeededRng,
  Creature,
  type CreatureExport,
  type NeatOptions,
  safeWriteJson,
  setRandomNumberGenerator,
} from "@stsoftware/neat-ai";

import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import {
  captureSnapshot,
  DEFAULT_CHECKPOINTS,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { renderDecisionBoundarySVG } from "./svg.ts";

/**
 * Iterations per inner `evolveDir` chunk. Each chunk refreshes the
 * passed-in creature in place, so chunking the run gives the CSV /
 * SVG charts visible step changes in neuron/synapse counts as NEAT
 * mutates the topology. The value matches the convention used by
 * `synthetic_synapse_example.ts` (issue #206) so both audited examples
 * keep telemetry resolution aligned without over-fragmenting the
 * `evolveDir` calls (each call loads native libraries; too many in a
 * single test triggers Deno's test-resource sanitizer).
 */
const TELEMETRY_CHUNK_ITERATIONS = 50;

/** Number of input features. */
export const INPUT_COUNT = 2;

/** Number of outputs. */
export const OUTPUT_COUNT = 1;

/** A single XOR sample: two binary inputs and the expected output. */
export interface XorSample {
  inputs: readonly [number, number];
  target: number;
}

/**
 * The full XOR truth table. The four samples are emitted in a fixed
 * order so any test (and the rendered SVG) can rely on the indexing.
 */
export function xorSamples(): XorSample[] {
  return [
    { inputs: [0, 0], target: 0 },
    { inputs: [0, 1], target: 1 },
    { inputs: [1, 0], target: 1 },
    { inputs: [1, 1], target: 0 },
  ];
}

/** Configuration options for {@link evolveXorController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Maximum number of generations before giving up. */
  maxGenerations: number;
  /** Mean-squared-error threshold below which the task counts as solved. */
  errorThreshold: number;
  /**
   * Wall-clock backstop in minutes for the whole run, passed verbatim
   * to NEAT-AI's `evolveDir(...)` per the audit policy in issue #205
   * (5-minute upper bound). NEAT-AI requires a positive integer, so a
   * minimum of 1 is enforced internally.
   */
  timeoutMinutes: number;
  /**
   * Probability that any given creature is mutated each generation. The
   * NEAT-AI default is 0.3 — too conservative for the tiny XOR problem
   * where the seed must grow at least one hidden neuron from scratch.
   */
  mutationRate: number;
  /**
   * Number of mutation operators applied per mutated creature each
   * generation. Higher values bias the search toward structural growth
   * (ADD_NODE, ADD_CONN). The NEAT-AI default is 1.
   */
  mutationAmount: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, the running champion
   * is captured at every generation matching `snapshotConfig.checkpoints`
   * and written to `snapshotConfig.outputDir`.
   */
  snapshotConfig?: SnapshotConfig;
  /**
   * Existing data directory containing the four XOR samples as a binary
   * file. When omitted, a temporary directory is created and cleaned up
   * automatically. Tests that want to inspect the data files can pass
   * their own directory here.
   */
  dataDir?: string;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestFitness: number;
  bestError: number;
  meanFitness: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** One row of per-generation evolution telemetry (audit issue #205). */
export interface EvolutionRow {
  /** 1-based generation index. */
  generation: number;
  /** Best fitness in this generation (max across the population). */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  meanFitness: number;
  /** Neuron count of this generation's champion. */
  neuronCount: number;
  /** Synapse count of this generation's champion. */
  synapseCount: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best fitness reached by the champion (1 - MSE - tiny version penalty). */
  bestFitness: number;
  /** Mean squared error of the champion across the four samples. */
  bestError: number;
  /** Number of generations actually run. */
  generations: number;
  /** True when the champion classifies all four samples correctly. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 50,
  maxGenerations: 2000,
  errorThreshold: 0.05,
  // Audit policy from issue #205: 5-minute wall-clock backstop. The
  // tiny XOR problem typically converges in a few seconds; this is a
  // safety net so the runner never wedges.
  timeoutMinutes: 5,
  mutationRate: 0.6,
  mutationAmount: 3,
};

/**
 * Build a uniform-random NEAT seed creature. Seeds the library's global
 * PRNG with {@link createSeededRng} and then defers to
 * `new Creature(INPUT_COUNT, OUTPUT_COUNT)`, the library's uniform-random
 * constructor — every weight, bias, and synapse is drawn from the
 * seeded PRNG. No topology, weight, or bias is hand-specified by this
 * example.
 *
 * The constructor produces direct input → output synapses with no
 * hidden neurons, so the gen-1 creature cannot represent XOR (the
 * problem is not linearly separable). NEAT must invent at least one
 * hidden neuron during evolution to break the 0.25 MSE plateau.
 *
 * The single output neuron's activation is pinned to LOGISTIC. This is
 * the example's classification interface — predictions are interpreted
 * via a `>= 0.5` threshold and MSE is taken against `{0, 1}` targets,
 * both of which assume an output bounded to `[0, 1]`. Hidden neurons
 * (added later by structural mutation) are not constrained.
 */
export function buildRandomSeedCreature(seed: number): CreatureExport {
  setRandomNumberGenerator(createSeededRng(seed));
  const json = new Creature(INPUT_COUNT, OUTPUT_COUNT).exportJSON();
  for (const neuron of json.neurons) {
    if (neuron.type === "output") neuron.squash = "LOGISTIC";
  }
  return json;
}

/**
 * Write the four XOR samples as a Float32 binary file the NEAT-AI
 * library can consume via `creature.evolveDir(dir, ...)`. Each record
 * is `INPUT_COUNT + OUTPUT_COUNT` floats (input, input, target).
 */
export function writeXorDataset(dataDir: string): string {
  ensureDirSync(dataDir);
  const samples = xorSamples();
  const stride = INPUT_COUNT + OUTPUT_COUNT;
  const buffer = new Float32Array(samples.length * stride);
  for (let i = 0; i < samples.length; i++) {
    buffer[i * stride + 0] = samples[i].inputs[0];
    buffer[i * stride + 1] = samples[i].inputs[1];
    buffer[i * stride + INPUT_COUNT] = samples[i].target;
  }
  const path = join(dataDir, "xor.bin");
  Deno.writeFileSync(path, new Uint8Array(buffer.buffer));
  return path;
}

/** Activate the creature on a single sample, returning the scalar output. */
export function predict(creature: Creature, inputs: readonly [number, number]): number {
  creature.clearState();
  const out = creature.activate(Float32Array.from([inputs[0], inputs[1]]));
  return out[0];
}

/**
 * Mean squared error of a creature across the four XOR samples. Lower
 * is better; perfect fit is 0, worst is 1.
 */
export function meanSquaredError(creature: Creature): number {
  const samples = xorSamples();
  let sum = 0;
  for (const { inputs, target } of samples) {
    const prediction = predict(creature, inputs);
    const diff = prediction - target;
    sum += diff * diff;
  }
  return sum / samples.length;
}

/**
 * Number of samples (out of four) the creature classifies correctly,
 * using a 0.5 threshold on the output.
 */
export function correctCount(creature: Creature): number {
  const samples = xorSamples();
  let correct = 0;
  for (const { inputs, target } of samples) {
    const predicted = predict(creature, inputs) >= 0.5 ? 1 : 0;
    if (predicted === target) correct++;
  }
  return correct;
}

/**
 * Compute the schedule of segment endpoints. The list always starts
 * past gen 0 and ends at `maxGenerations`. Checkpoint values that fall
 * within `[1, maxGenerations]` become extra segment boundaries so a
 * snapshot can be captured at exactly that generation.
 */
export function planSegments(
  checkpoints: readonly number[],
  maxGenerations: number,
): number[] {
  const set = new Set<number>();
  for (const c of checkpoints) {
    if (c >= 1 && c <= maxGenerations) set.add(c);
  }
  set.add(maxGenerations);
  return [...set].sort((a, b) => a - b);
}

/**
 * Run NEAT structural evolution to learn XOR.
 *
 * The runner builds the **uniform-random seed creature** via
 * {@link buildRandomSeedCreature} (no hidden neurons, random weights and
 * output bias from the seeded PRNG) and delegates structural mutation
 * to the library via `creature.evolveDir` — add-neuron, add-synapse and
 * weight perturbation are all driven by the NEAT primitives, not by
 * the example. Snapshots are captured at
 * `options.snapshotConfig.checkpoints` by splitting the run into
 * segments that end at each checkpoint, allowing the running champion
 * (and its discovered topology) to be recorded as it grows.
 *
 * Determinism: the seed flows through `NeatOptions.seed` and is also
 * used to construct the initial creature, so two runs with the same
 * `seed` produce the same gen-1 seed creature and the same champion.
 */
export async function evolveXorController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ??
    Deno.makeTempDirSync({ prefix: "xor_evolve_data_" });

  try {
    if (ownDataDir) writeXorDataset(dataDir);

    const creature = Creature.fromJSON(buildRandomSeedCreature(options.seed));

    const checkpoints = options.snapshotConfig ? [...options.snapshotConfig.checkpoints] : [];
    const segmentEnds = planSegments(checkpoints, options.maxGenerations);

    let priorGenerations = 0;
    let lastError = meanSquaredError(creature);
    let lastScore = 1 - lastError;
    let solved = false;

    // Topology captured between chunks so per-generation events report
    // the chunk's *starting* neuron/synapse counts. The library only
    // updates `creature` in-place at the end of each `evolveDir` call,
    // so chunking each segment lets the CSV/SVG charts pick up topology
    // growth at finer resolution than the segment endpoints alone would
    // allow (issue #205).
    // Read the live `creature.neurons` / `creature.synapses` arrays
    // rather than `exportJSON()` — the latter produces a compacted /
    // canonicalised view that does not always reflect mid-run
    // structural growth, while the live arrays do (matching the
    // pattern used by `synthetic_synapse_example.ts`, issue #206).
    const countTopology = () => ({
      neurons: creature.neurons.length,
      synapses: creature.synapses.length,
    });
    let topology = countTopology();

    for (const endGen of segmentEnds) {
      const segmentIterations = endGen - priorGenerations;
      if (segmentIterations <= 0) continue;

      let segmentEvolved = 0;
      // Sub-chunking yields finer telemetry: the post-chunk topology is
      // refreshed in `creature` and reflected in the next chunk's events.
      while (segmentEvolved < segmentIterations) {
        const remaining = segmentIterations - segmentEvolved;
        const chunkIterations = Math.min(TELEMETRY_CHUNK_ITERATIONS, remaining);
        topology = countTopology();

        const chunkOffset = priorGenerations;
        const neatOptions: NeatOptions = {
          seed: options.seed + chunkOffset,
          populationSize: options.populationSize,
          iterations: chunkIterations,
          targetError: Math.max(0, Math.min(1, options.errorThreshold)),
          // The audit policy in #205 mandates a 5-minute safety
          // backstop for the production runner. NEAT-AI activates its
          // GPU/discovery cleanup machinery when the option is set, and
          // that machinery loads a dynamic library that Deno's test
          // sanitizer flags as a leak when --allow-ffi is enabled. We
          // include the option only when the caller asked for it
          // (`timeoutMinutes > 0`); tests override to 0 so the leak
          // detector stays clean while still exercising every other
          // code path.
          ...(options.timeoutMinutes > 0
            ? { timeoutMinutes: Math.max(1, Math.floor(options.timeoutMinutes)) }
            : {}),
          costOfGrowth: 0,
          mutationRate: options.mutationRate,
          mutationAmount: options.mutationAmount,
          verbose: false,
          log: 0,
          threads: 1,
          onTrainingEvent: (event) => {
            if (event.kind !== "generation_complete") return;
            const fitness = event.bestFitness;
            // score = 1 - error - growthPenalty - versionPenalty (1e-6).
            // With costOfGrowth=0 the growth penalty is 0, so error ≈ 1 - fitness
            // (within 1e-6).
            const error = Math.max(0, 1 - fitness);
            options.onGeneration?.({
              generation: chunkOffset + event.generation,
              bestFitness: fitness,
              bestError: error,
              meanFitness: event.averageFitness,
              // Topology of this chunk's starting champion. Updated
              // every TELEMETRY_CHUNK_ITERATIONS generations so the CSV
              // shows real structural growth across the run.
              neurons: topology.neurons,
              synapses: topology.synapses,
            });
          },
        };

        const result = await creature.evolveDir(dataDir, neatOptions);
        const completed = result.generation ?? chunkIterations;
        priorGenerations += completed;
        segmentEvolved += completed;
        lastError = result.error;
        lastScore = result.score;

        // Per-generation events fired during evolveDir capture the
        // chunk's starting topology — NEAT-AI's structural mutations
        // happen inside the call and the live `creature` arrays only
        // reflect them once it returns. Emit one "post-chunk" event
        // here so the CSV /  SVG charts pick up topology growth that
        // landed during the chunk (issue #205 mandates the change be
        // visible across generations).
        const postTopology = countTopology();
        if (
          postTopology.neurons !== topology.neurons ||
          postTopology.synapses !== topology.synapses
        ) {
          options.onGeneration?.({
            generation: priorGenerations,
            bestFitness: lastScore,
            bestError: Math.max(0, lastError),
            // No mean fitness available outside an event payload — flag
            // it as NaN so downstream renderers can skip cleanly.
            meanFitness: Number.NaN,
            neurons: postTopology.neurons,
            synapses: postTopology.synapses,
          });
        }

        if (lastError <= options.errorThreshold) {
          solved = true;
          break;
        }
        // evolveDir may stop early (e.g. timeoutMinutes). Stop chunking
        // when it returns fewer iterations than requested.
        if (completed < chunkIterations) break;
      }
      // Refresh the captured topology so any post-segment work (snapshot
      // capture, next segment's events) reflects the new neuron / synapse
      // counts.
      topology = countTopology();

      // Capture a snapshot whenever this segment ends on a configured
      // checkpoint. The creature has just been mutated in-place to the
      // current best, so its topology and predictions are accurate.
      if (options.snapshotConfig && checkpoints.includes(endGen)) {
        const sampleOutputs = xorSamples().map((s) => predict(creature, s.inputs));
        captureSnapshot(
          options.snapshotConfig,
          endGen,
          creature.exportJSON() as unknown,
          lastScore,
          sampleOutputs,
        );
      }

      if (solved) break;
    }

    return {
      champion: creature,
      bestFitness: lastScore,
      bestError: lastError,
      generations: priorGenerations,
      solved: solved && correctCount(creature) === 4,
    };
  } finally {
    if (ownDataDir) {
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch {
        // Ignore cleanup errors — the temp dir may already be gone.
      }
    }
  }
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/xor_decision_boundary.svg";

/** Path to the evolution-chart SVG the runner emits for the README. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/xor_classification/evolution.svg";

/** Per-generation evolution-telemetry CSV path (audit issue #205). */
export const EVOLUTION_CSV_PATH = "docs/data/xor_classification/evolution.csv";

/** CSV header — matches the schema mandated by issue #205. */
export const EVOLUTION_CSV_HEADER =
  "generation,best_fitness,mean_fitness,neuron_count,synapse_count";

/** Best/mean fitness chart path (audit issue #205). */
export const FITNESS_SVG_PATH = "docs/screenshots/xor_classification/fitness.svg";

/** Neuron / synapse count chart path (audit issue #205). */
export const TOPOLOGY_SVG_PATH = "docs/screenshots/xor_classification/topology.svg";

/** Resolution (cells per side) of the decision-boundary grid. */
export const DECISION_BOUNDARY_GRID = 40;

/**
 * Generations at which the runner captures evolution snapshots. The
 * canonical NEAT-AI strip uses `[1, 10, 100, 1000, 10000]` (matching
 * `DEFAULT_CHECKPOINTS` from `evolution_snapshot.ts`); any checkpoint
 * past `DEFAULT_EVOLVE_OPTIONS.maxGenerations` simply does not fire,
 * so the same list works for reduced-budget test runs.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [...DEFAULT_CHECKPOINTS];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-xor/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/xor_classification_evolution.svg";

/**
 * Format a finite number for CSV emission. Trailing zeros are trimmed
 * so byte-deterministic identical inputs produce one canonical string.
 */
function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/** Format the per-generation telemetry as a CSV string. */
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

// ---- Telemetry SVG renderers -------------------------------------------
// Two purpose-built charts requested by issue #205: best/mean fitness on
// one chart, neuron/synapse count on another. Pure string emission to
// match the convention used by the per-example svg.ts modules.
const TELEMETRY_SVG_WIDTH = 720;
const TELEMETRY_SVG_HEIGHT = 320;
const TELEMETRY_MARGIN = { top: 36, right: 70, bottom: 44, left: 60 };

interface PolylinePoint {
  x: number;
  y: number;
}

function buildPolyline(points: readonly PolylinePoint[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

/**
 * Render a two-line chart: best fitness (blue) and mean fitness
 * (orange) versus generation. Throws if `rows` is empty — callers are
 * expected to skip rendering when no generations have been captured.
 */
export function renderFitnessChartSvg(rows: readonly EvolutionRow[]): string {
  if (rows.length === 0) {
    throw new Error("renderFitnessChartSvg requires at least one row");
  }
  const innerW = TELEMETRY_SVG_WIDTH - TELEMETRY_MARGIN.left - TELEMETRY_MARGIN.right;
  const innerH = TELEMETRY_SVG_HEIGHT - TELEMETRY_MARGIN.top - TELEMETRY_MARGIN.bottom;
  const innerX = TELEMETRY_MARGIN.left;
  const innerY = TELEMETRY_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const allFitness = rows.flatMap((r) => [r.bestFitness, r.meanFitness]).filter(
    Number.isFinite,
  );
  const minF = allFitness.length > 0 ? Math.min(...allFitness) : 0;
  const maxF = allFitness.length > 0 ? Math.max(...allFitness) : 1;
  const fSpan = (maxF - minF) || 1;

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const yScale = (f: number) => innerY + innerH - ((f - minF) / fSpan) * innerH;

  // NaN means we have no usable mean fitness for that row (NEAT-AI may
  // emit NaN early on); plot those at the bottom of the chart so the
  // best line is still readable.
  const safeY = (f: number): number => Number.isFinite(f) ? yScale(f) : (innerY + innerH);

  const bestPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: safeY(r.bestFitness),
  }));
  const meanPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: safeY(r.meanFitness),
  }));

  const yTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const v = minF + t * fSpan;
    const ty = innerY + innerH - t * innerH;
    yTicks.push(
      `    <line x1="${innerX.toFixed(2)}" y1="${ty.toFixed(2)}" ` +
        `x2="${(innerX + innerW).toFixed(2)}" y2="${ty.toFixed(2)}" ` +
        `stroke="#eeeeee" stroke-width="0.6"/>`,
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ty + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#444">` +
        `${v.toFixed(3)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TELEMETRY_SVG_WIDTH} ${TELEMETRY_SVG_HEIGHT}" ` +
    `width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" role="img" ` +
    `aria-label="XOR classification — best vs mean fitness per generation">`,
    `  <title>XOR Classification — Best vs Mean Fitness</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `XOR Classification — Best vs Mean Fitness</text>`,
    yTicks.join("\n"),
    `  <polyline class="best-fitness" fill="none" stroke="#1f77b4" stroke-width="2" ` +
    `points="${buildPolyline(bestPts)}"/>`,
    `  <polyline class="mean-fitness" fill="none" stroke="#ff7f0e" stroke-width="1.4" ` +
    `stroke-dasharray="4 3" points="${buildPolyline(meanPts)}"/>`,
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`,
    `    <rect x="${(innerX + innerW - 178).toFixed(2)}" y="${(innerY + 6).toFixed(2)}" ` +
    `width="172" height="44" fill="#ffffff" fill-opacity="0.9" stroke="#cccccc"/>`,
    `    <line x1="${(innerX + innerW - 168).toFixed(2)}" y1="${(innerY + 18).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 144).toFixed(2)}" y2="${(innerY + 18).toFixed(2)}" ` +
    `stroke="#1f77b4" stroke-width="2"/>`,
    `    <text x="${(innerX + innerW - 138).toFixed(2)}" y="${(innerY + 21).toFixed(2)}">` +
    `best fitness</text>`,
    `    <line x1="${(innerX + innerW - 168).toFixed(2)}" y1="${(innerY + 36).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 144).toFixed(2)}" y2="${(innerY + 36).toFixed(2)}" ` +
    `stroke="#ff7f0e" stroke-width="1.4" stroke-dasharray="4 3"/>`,
    `    <text x="${(innerX + innerW - 138).toFixed(2)}" y="${(innerY + 39).toFixed(2)}">` +
    `mean fitness</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/**
 * Render the neuron / synapse count chart for the README. Two lines
 * share an X axis; the right Y axis shows synapse counts on a separate
 * scale so the synapse line does not compress the neuron line into
 * invisibility.
 */
export function renderTopologyChartSvg(rows: readonly EvolutionRow[]): string {
  if (rows.length === 0) {
    throw new Error("renderTopologyChartSvg requires at least one row");
  }
  const innerW = TELEMETRY_SVG_WIDTH - TELEMETRY_MARGIN.left - TELEMETRY_MARGIN.right;
  const innerH = TELEMETRY_SVG_HEIGHT - TELEMETRY_MARGIN.top - TELEMETRY_MARGIN.bottom;
  const innerX = TELEMETRY_MARGIN.left;
  const innerY = TELEMETRY_MARGIN.top;

  const minGen = rows[0].generation;
  const maxGen = rows[rows.length - 1].generation;
  const genSpan = Math.max(1, maxGen - minGen);

  const neurons = rows.map((r) => r.neuronCount);
  const synapses = rows.map((r) => r.synapseCount);
  const maxNeurons = Math.max(...neurons, 1);
  const maxSynapses = Math.max(...synapses, 1);

  const xScale = (g: number) => innerX + ((g - minGen) / genSpan) * innerW;
  const neuronY = (n: number) => innerY + innerH - (n / maxNeurons) * innerH;
  const synapseY = (s: number) => innerY + innerH - (s / maxSynapses) * innerH;

  const neuronPts = rows.map((r) => ({
    x: xScale(r.generation),
    y: neuronY(r.neuronCount),
  }));
  const synapsePts = rows.map((r) => ({
    x: xScale(r.generation),
    y: synapseY(r.synapseCount),
  }));

  const leftTicks: string[] = [];
  const rightTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const ly = innerY + innerH - t * innerH;
    leftTicks.push(
      `    <text x="${(innerX - 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="end" font-family="sans-serif" font-size="10" fill="#2ca02c">` +
        `${(t * maxNeurons).toFixed(0)}</text>`,
    );
    rightTicks.push(
      `    <text x="${(innerX + innerW + 6).toFixed(2)}" y="${(ly + 3.5).toFixed(2)}" ` +
        `text-anchor="start" font-family="sans-serif" font-size="10" fill="#d62728">` +
        `${(t * maxSynapses).toFixed(0)}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TELEMETRY_SVG_WIDTH} ${TELEMETRY_SVG_HEIGHT}" ` +
    `width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" role="img" ` +
    `aria-label="XOR classification — neuron and synapse counts per generation">`,
    `  <title>XOR Classification — Topology Growth</title>`,
    `  <rect width="${TELEMETRY_SVG_WIDTH}" height="${TELEMETRY_SVG_HEIGHT}" fill="#fafafa"/>`,
    `  <text x="${TELEMETRY_SVG_WIDTH / 2}" y="22" text-anchor="middle" ` +
    `font-family="sans-serif" font-size="14" font-weight="bold" fill="#222">` +
    `XOR Classification — Topology Growth</text>`,
    leftTicks.join("\n"),
    rightTicks.join("\n"),
    `  <polyline class="neuron-count" fill="none" stroke="#2ca02c" stroke-width="2" ` +
    `points="${buildPolyline(neuronPts)}"/>`,
    `  <polyline class="synapse-count" fill="none" stroke="#d62728" stroke-width="2" ` +
    `stroke-dasharray="6 3" points="${buildPolyline(synapsePts)}"/>`,
    `  <text x="${innerX.toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `font-family="sans-serif" font-size="11" fill="#333">gen ${minGen}</text>`,
    `  <text x="${(innerX + innerW).toFixed(2)}" y="${(innerY + innerH + 28).toFixed(2)}" ` +
    `text-anchor="end" font-family="sans-serif" font-size="11" fill="#333">gen ${maxGen}</text>`,
    `  <g class="legend" font-family="sans-serif" font-size="11" fill="#222">`,
    `    <rect x="${(innerX + innerW - 198).toFixed(2)}" y="${(innerY + 6).toFixed(2)}" ` +
    `width="190" height="44" fill="#ffffff" fill-opacity="0.9" stroke="#cccccc"/>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 18).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 18).toFixed(2)}" ` +
    `stroke="#2ca02c" stroke-width="2"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 21).toFixed(2)}">` +
    `neurons (left axis)</text>`,
    `    <line x1="${(innerX + innerW - 188).toFixed(2)}" y1="${(innerY + 36).toFixed(2)}" ` +
    `x2="${(innerX + innerW - 164).toFixed(2)}" y2="${(innerY + 36).toFixed(2)}" ` +
    `stroke="#d62728" stroke-width="2" stroke-dasharray="6 3"/>`,
    `    <text x="${(innerX + innerW - 158).toFixed(2)}" y="${(innerY + 39).toFixed(2)}">` +
    `synapses (right axis)</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧠 XOR Classification Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-xor");

  console.log("📊 Training samples:");
  for (const { inputs, target } of xorSamples()) {
    console.log(`   (${inputs[0]}, ${inputs[1]}) → ${target}`);
  }

  console.log("\n🧬 Evolving classifier (NEAT structural mutation from random noise)...");
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionRows: EvolutionRow[] = [];
  ensureDirSync(SNAPSHOTS_DIR);
  // Empty any stale snapshot files so reruns do not blend old + new gens.
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionStart = Date.now();
  const result = await evolveXorController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestFitness, bestError, meanFitness, neurons, synapses }) => {
      evolutionSamples.push({
        generation,
        score: bestFitness,
        neurons,
        synapses,
      });
      evolutionRows.push({
        generation,
        bestFitness,
        meanFitness,
        neuronCount: neurons,
        synapseCount: synapses,
      });
      if (generation % 10 === 0 || bestError <= DEFAULT_EVOLVE_OPTIONS.errorThreshold) {
        console.log(
          `   Gen ${generation.toString().padStart(4)}  ` +
            `bestFitness=${bestFitness.toFixed(4)}  ` +
            `bestError=${bestError.toFixed(4)}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(error=${result.bestError.toFixed(4)}, fitness=${result.bestFitness.toFixed(4)}).`,
  );

  console.log("\n🎯 Champion predictions:");
  for (const { inputs, target } of xorSamples()) {
    const out = predict(result.champion, inputs);
    const predicted = out >= 0.5 ? 1 : 0;
    const tick = predicted === target ? "✓" : "✗";
    console.log(`   (${inputs[0]}, ${inputs[1]}) → ${out.toFixed(4)} (target=${target}) ${tick}`);
  }

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`\n💾 Saved champion to ${championPath}`);

  // Render the decision-boundary SVG.
  const svg = renderDecisionBoundarySVG(result.champion, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "XOR Classification — Evolution",
      scoreLabel: "best fitness (1 - MSE)",
    });
    ensureDirSync("docs/screenshots/xor_classification");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Per-generation telemetry artefacts mandated by issue #205: CSV +
  // best/mean fitness chart + neuron/synapse count chart, all rendered
  // from the same captured rows so the README quotes real measured
  // numbers from the latest run.
  if (evolutionRows.length > 0) {
    ensureDirSync("docs/data/xor_classification");
    ensureDirSync("docs/screenshots/xor_classification");
    await Deno.writeTextFile(EVOLUTION_CSV_PATH, formatEvolutionCsv(evolutionRows));
    console.log(
      `🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${evolutionRows.length} rows)`,
    );
    await Deno.writeTextFile(FITNESS_SVG_PATH, renderFitnessChartSvg(evolutionRows));
    console.log(`📈 Wrote best/mean fitness chart ${FITNESS_SVG_PATH}`);
    await Deno.writeTextFile(TOPOLOGY_SVG_PATH, renderTopologyChartSvg(evolutionRows));
    console.log(`📈 Wrote neuron/synapse chart ${TOPOLOGY_SVG_PATH}`);
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "XOR Classification — Evolution Progress",
      caption: {
        finalScore: result.bestFitness,
        totalGenerations: result.generations,
        wallClockMs: Date.now() - evolutionStart,
      },
    });
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(EVOLUTION_PROGRESS_SVG_PATH, progressionSvg);
    console.log(
      `🧬 Wrote evolution-progression strip ${EVOLUTION_PROGRESS_SVG_PATH} ` +
        `(${snapshots.length} panels)`,
    );
  }

  // Final summary line so the README can quote real measured numbers.
  const finalRow = evolutionRows[evolutionRows.length - 1];
  if (finalRow) {
    console.log(
      `\n🏁 Final generation ${finalRow.generation}: ` +
        `bestFitness=${finalRow.bestFitness.toFixed(4)}  ` +
        `meanFitness=${
          Number.isFinite(finalRow.meanFitness) ? finalRow.meanFitness.toFixed(4) : "n/a"
        }  ` +
        `neurons=${finalRow.neuronCount}  synapses=${finalRow.synapseCount}`,
    );
  }
  console.log(
    `🕒 Completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
