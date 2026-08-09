/**
 * Synthetic Synapse Training Demo (issue #85, audited under #206,
 * telemetry simplified under #303).
 *
 * Demonstrates NEAT-AI's **synthetic-synapse training** technique:
 * temporarily **densifying** the inter-layer connectivity of an
 * **evolved** sparse creature so weight optimisation has more degrees of
 * freedom, then **pruning** the near-zero synthetic synapses afterwards
 * so the deployed creature stays lean.
 *
 * Under #303 the per-generation `onTrainingEvent` hook and the chunked
 * `evolveDir` loop were removed in favour of NEAT-AI's supported
 * milestone-only telemetry surface. Each `evolveDir` call now returns
 * a single milestone summary; both summaries are exposed on the result
 * so the bespoke three-panel topology + bar chart SVG can source its
 * held-out score callouts from the new milestone path.
 *
 * This audit (issue #206) brings the example in line with the
 * minimal-seed policy in `AGENTS.md`:
 *
 * 1. The creature passed to NEAT-AI is built **only** from
 *    `new Creature(INPUT_COUNT, OUTPUT_COUNT)` — no hidden-layer hint,
 *    no pre-built `network.json` seed, no hand-tuned shape. NEAT-AI
 *    random-initialises the rest.
 * 2. Evolution runs through `Creature.evolveDir(dataDir, neatOptions)`
 *    over a pre-generated binary `.bin` training set; the topology is
 *    learned by NEAT, not bolted on by the example.
 * 3. Stop conditions are a per-example `targetError` plus a
 *    `timeoutMinutes` safety backstop — lifted 5 → 20 under issue #389
 *    (Refresh-2026-05) so the runner can consume an additional 15
 *    wall-clock minutes of evolution per parent milestone #369.
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

import { buildLargeCreature } from "../common/large_creature.ts";
import {
  type FeedForwardNetwork,
  forward,
  heldOutScore,
  networkFromCreature as buildFeedForwardNetwork,
  type NetworkNeuron,
  type NetworkSynapse as FeedForwardSynapse,
} from "../common/feed_forward_network.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  generateNetworkDataset as generateDataset,
  writeBinaryDataset as writeTrainingBin,
} from "../common/synthetic_data.ts";
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { renderSyntheticSynapseSVG } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-synapse";

/** Path to the topology + bar-chart SVG (sparse → densified → pruned). */
export const SCREENSHOT_PATH = "docs/screenshots/synthetic_synapse.svg";

/** Mirror copy under `WORKING_ROOT/output/`. */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "synthetic_synapse.svg");

/** Milestone summary SVG path — sourced from the post-prune `evolveDir` return value. */
export const EVOLUTION_SUMMARY_SVG_PATH =
  "docs/screenshots/synthetic_synapse/evolution_summary.svg";

/**
 * Number of input neurons fed to the NEAT-AI seed.
 *
 * Five inputs combined with two outputs makes the truth function
 * non-linearly separable enough that direct input → output synapses
 * cannot fit it: NEAT has to invent hidden neurons (and therefore new
 * inter-layer edges) to drive `bestFitness` above the targetError.
 * This is what gives the densify-train-prune cycle something to act
 * on — if the sparse champion finished as a flat input/output graph,
 * synthetic-synapse training would have nothing to densify.
 */
export const INPUT_COUNT = 5;

/** Number of output neurons fed to the NEAT-AI seed. */
export const OUTPUT_COUNT = 2;

/** Names of the three phases captured by {@link runSyntheticSynapseDemo}. */
export type PhaseName = "sparse" | "densified" | "pruned";

/** Configuration for {@link runSyntheticSynapseDemo}. */
export interface SyntheticSynapseConfig {
  /** Random seed for target network, dataset, and NEAT mutation. */
  seed: number;
  /** Training records written to the binary `.bin` file. */
  trainingSize: number;
  /** Held-out records used to validate the final creature. */
  heldOutSize: number;
  /** Per-example `targetError` driving early exit from each phase. */
  targetError: number;
  /**
   * Wall-clock backstop in minutes for the whole demo. The value is
   * split across the sparse and refine phases. Issue #206 originally
   * mandated 5 minutes as the upper bound; issue #389 (Refresh-2026-05)
   * raised the backstop to 20 minutes (= the original 5 + an additional
   * 15 wall-clock minutes mandated by the parent milestone #369) so the
   * runner can actually consume the budget on newer NEAT-AI builds. The
   * per-phase split is half this.
   */
  timeoutMinutes: number;
  /** NEAT population size. Small for a fast self-contained demo. */
  populationSize: number;
  /** Hard iteration cap as a secondary safety net. */
  maxIterationsPerPhase: number;
  /**
   * Magnitude threshold below which a synthetic synapse is pruned at
   * the end of the densified phase. Original (non-synthetic) edges are
   * never pruned, even when their weight falls below this threshold.
   */
  pruneThreshold: number;
}

/**
 * Defaults chosen so the demo converges via `targetError` well inside
 * the wall-clock backstop on a developer machine while still showing
 * the densify-then-prune effect clearly. Issue #389 (Refresh-2026-05)
 * lifted `timeoutMinutes` 5 → 20 (= the original 5 + the additional
 * 15 wall-clock minutes mandated by parent milestone #369) and
 * `maxIterationsPerPhase` 250 → 10 000 so wall-clock remains the
 * genuine limiter on newer NEAT-AI builds.
 */
export const DEFAULT_SYNTHETIC_SYNAPSE_CONFIG: SyntheticSynapseConfig = {
  seed: 850850850,
  trainingSize: 128,
  heldOutSize: 64,
  // Tightened from the original 0.005 (issue #206) to 0.0005 under
  // issue #389 so the runner genuinely engages the extra 15-minute
  // wall-clock budget — at 0.005 the sparse phase converges via
  // targetError in seconds and leaves no work for densify/refine.
  targetError: 0.0005,
  timeoutMinutes: 20,
  populationSize: 24,
  maxIterationsPerPhase: 10_000,
  pruneThreshold: 0.05,
};

/** A single training/held-out record. */
export interface DataPoint {
  inputs: Float32Array;
  targets: Float32Array;
}

/** Per-phase summary captured during the run. */
export interface PhaseRecord {
  /** Phase label. */
  phase: PhaseName;
  /** Synapse count of the phase's champion. */
  synapseCount: number;
  /** Held-out score (negative MSE — higher is better) at end of phase. */
  heldOutScore: number;
}

/** Combined result of running the synthetic-synapse demo. */
export interface SyntheticSynapseResult {
  /** Three phase records: sparse → densified → pruned. */
  phases: PhaseRecord[];
  /** Best topology snapshot per phase, for the SVG renderer. */
  topologies: Record<PhaseName, TopologySnapshot>;
  /** Milestone summary from the sparse (phase 1) `evolveDir` call. */
  sparseSummary: EvolveDirSummary;
  /** Milestone summary from the refine (phase 3) `evolveDir` call. */
  refineSummary: EvolveDirSummary;
  /** Total wall-clock time of the run, in milliseconds. */
  wallClockMs: number;
  /** Champion creature after the prune phase. */
  champion: Creature;
}

// ---- Internal feed-forward representation ------------------------------
// The original demo manipulated a small TypeScript `Network` struct so
// it could run analytical SGD. The audit moves training to NEAT-AI's
// evolveDir, but several utilities (forward pass, dataset generation,
// held-out scoring) are still reused by tests and the SVG renderer, so
// the lightweight representation is kept. The evaluation core itself —
// creature → network conversion, the forward pass, and the scorers —
// lives in `common/feed_forward_network.ts` (issue #775); only the
// synthetic-synapse bookkeeping below is demo-specific.

/** Minimal feed-forward network used by helper utilities. */
export interface Network extends FeedForwardNetwork {
  /** All neurons sorted by index (inputs, then hidden, then outputs). */
  neurons: NetworkNeuron[];
  /** All synapses; `from < to` always (strictly feed-forward). */
  synapses: NetworkSynapse[];
  /** Subset of `synapses` originally present (i.e. not synthetic). */
  originalSynapseKeys: Set<string>;
}

interface NetworkSynapse extends FeedForwardSynapse {
  /** True if added during densification, false if part of the original creature. */
  synthetic: boolean;
}

/** Topology snapshot captured for the 3-panel SVG renderer. */
export interface TopologySnapshot {
  inputCount: number;
  outputCount: number;
  hiddenCount: number;
  edges: Array<{ from: number; to: number; synthetic: boolean }>;
}

function synapseKey(from: number, to: number): string {
  return `${from}->${to}`;
}

/**
 * Construct an internal {@link Network} from a `Creature`, tagging every
 * existing synapse as original (i.e. not synthetic). Only LOGISTIC,
 * TANH, and IDENTITY squashes are supported — anything else throws.
 */
export function networkFromCreature(creature: Creature): Network {
  const base = buildFeedForwardNetwork(creature, { label: "synthetic-synapse demo" });
  const originalSynapseKeys = new Set<string>();
  const synapses: NetworkSynapse[] = base.synapses.map((s) => {
    originalSynapseKeys.add(synapseKey(s.from, s.to));
    return { ...s, synthetic: false };
  });

  return {
    inputCount: base.inputCount,
    outputCount: base.outputCount,
    neurons: [...base.neurons],
    synapses,
    originalSynapseKeys,
  };
}

// The forward pass and the held-out scorer are re-exported unchanged
// from the shared module so the example's public surface is unaffected
// by the extraction.
export { forward, heldOutScore };

/**
 * Held-out score for a `Creature` using its own `activate(...)` method.
 * This avoids the limited-squash conversion in {@link networkFromCreature}
 * — NEAT-AI may evolve any of its supported squash functions and the
 * creature itself can always activate them, whereas the local
 * {@link forward} helper only knows about IDENTITY/TANH/LOGISTIC.
 */
export function creatureHeldOutScore(
  creature: Creature,
  dataset: readonly DataPoint[],
): number {
  if (dataset.length === 0) return 0;
  let sum = 0;
  for (const point of dataset) {
    creature.clearState();
    const out = creature.activate(point.inputs);
    for (let o = 0; o < creature.output; o++) {
      const err = out[o] - point.targets[o];
      sum += err * err;
    }
  }
  return -(sum / dataset.length);
}

/**
 * Build the "ground truth" target network the dataset is generated
 * from. The target is **not** the NEAT seed — it just produces labels
 * that the evolved creature must learn to reproduce. Hand-shaping the
 * target is fine; only the seed needs to be minimal.
 */
export function buildTargetNetwork(config: SyntheticSynapseConfig): Network {
  const target = buildLargeCreature({
    inputs: INPUT_COUNT,
    hidden: 8,
    outputs: OUTPUT_COUNT,
    density: 1.0,
    seed: config.seed ^ 0x7777_7777,
  });
  return networkFromCreature(target);
}

// The network-driven dataset generator is re-exported unchanged from the
// shared module (issue #777) — it was verbatim-identical to the
// `neuron_pruning` copy.
export { generateDataset };

/**
 * Write `dataset` as the Float32 `training.bin` the NEAT-AI library
 * consumes via `Creature.evolveDir(dir, ...)`. The binary layout itself
 * lives in `common/synthetic_data.ts` (issue #777); this example only
 * supplies its arity.
 */
export function writeBinaryDataset(dataset: readonly DataPoint[], dataDir: string): string {
  return writeTrainingBin(dataset, dataDir, INPUT_COUNT, OUTPUT_COUNT);
}

/**
 * Densify a `Creature` by adding a zero-weight synapse for every
 * missing inter-layer edge between adjacent layers in the current
 * topology. Returns the keys of the newly added (synthetic) synapses
 * so callers can prune by membership later.
 */
export function densifyCreature(creature: Creature): Set<string> {
  const N = creature.neurons.length;
  const inputCount = creature.input;
  const outputCount = creature.output;
  const outStart = N - outputCount;
  const existing = new Set(
    creature.synapses.map((s) => synapseKey(s.from, s.to)),
  );
  const addedKeys = new Set<string>();

  // Inputs → every non-input neuron.
  for (let i = 0; i < inputCount; i++) {
    for (let j = inputCount; j < N; j++) {
      const key = synapseKey(i, j);
      if (existing.has(key)) continue;
      creature.connect(i, j, 0);
      existing.add(key);
      addedKeys.add(key);
    }
  }
  // Hidden → outputs.
  for (let h = inputCount; h < outStart; h++) {
    for (let o = outStart; o < N; o++) {
      const key = synapseKey(h, o);
      if (existing.has(key)) continue;
      creature.connect(h, o, 0);
      existing.add(key);
      addedKeys.add(key);
    }
  }
  return addedKeys;
}

/**
 * Drop every synthetic synapse (one whose key is in `syntheticKeys`)
 * whose absolute weight is below `threshold`. Original (non-synthetic)
 * edges, plus any synapses NEAT-AI added during the refine phase, are
 * never pruned.
 *
 * @returns The keys of the synapses removed.
 */
export function pruneCreature(
  creature: Creature,
  syntheticKeys: ReadonlySet<string>,
  threshold: number,
): Set<string> {
  if (threshold < 0) {
    throw new Error(`prune threshold must be >= 0, got ${threshold}`);
  }
  const removed = new Set<string>();
  // Iterate over a snapshot — disconnect mutates `creature.synapses`.
  for (const s of [...creature.synapses]) {
    const key = synapseKey(s.from, s.to);
    if (!syntheticKeys.has(key)) continue;
    if (Math.abs(s.weight) >= threshold) continue;
    creature.disconnect(s.from, s.to);
    removed.add(key);
  }
  return removed;
}

/** Snapshot the creature's topology for the 3-panel SVG renderer. */
function snapshotTopology(
  creature: Creature,
  syntheticKeys: ReadonlySet<string>,
): TopologySnapshot {
  return {
    inputCount: creature.input,
    outputCount: creature.output,
    hiddenCount: creature.neurons.length - creature.input - creature.output,
    edges: creature.synapses.map((s) => ({
      from: s.from,
      to: s.to,
      synthetic: syntheticKeys.has(synapseKey(s.from, s.to)),
    })),
  };
}

/**
 * Run a single `evolveDir` phase against `dataDir` from `seed` and
 * return a milestone summary captured from the call's return value
 * plus the seed and final creature's topology. The seed is mutated in
 * place.
 */
async function runEvolveDirPhase(opts: {
  creature: Creature;
  dataDir: string;
  config: SyntheticSynapseConfig;
  phaseTimeoutMinutes: number;
  seedOffset: number;
}): Promise<EvolveDirSummary> {
  const { creature, dataDir, config, phaseTimeoutMinutes, seedOffset } = opts;

  const seedNeurons = creature.neurons.length;
  const seedSynapses = creature.synapses.length;
  const start = Date.now();

  const neatOptions: NeatOptions = {
    seed: config.seed + seedOffset,
    populationSize: config.populationSize,
    iterations: config.maxIterationsPerPhase,
    targetError: config.targetError,
    timeoutMinutes: phaseTimeoutMinutes,
    costOfGrowth: 0,
    // Push NEAT toward structural growth so the sparse phase actually
    // adds hidden neurons / inter-layer synapses from the minimal seed
    // — otherwise densify-train-prune has nothing to do.
    mutationRate: 0.6,
    mutationAmount: 3,
    verbose: false,
    log: 0,
    threads: 1,
  };

  const result = await creature.evolveDir(dataDir, neatOptions);
  const wallClockMs = Date.now() - start;

  const finalError = Number.isFinite(result.error) ? result.error : 0;
  const finalScore = Number.isFinite(result.score) ? result.score : 0;
  const generations = Math.max(1, result.generation ?? 1);

  return {
    finalError,
    finalScore,
    wallClockMs,
    generations,
    seedNeurons,
    seedSynapses,
    finalNeurons: creature.neurons.length,
    finalSynapses: creature.synapses.length,
    targetError: config.targetError,
    timeoutMinutes: phaseTimeoutMinutes,
  };
}

/**
 * Run the synthetic-synapse demo end-to-end:
 *
 *   1. Seed `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (minimal, no
 *      hidden hint).
 *   2. Run a single `evolveDir` over the binary `.bin` training set →
 *      sparse champion. Capture the sparse phase milestone summary.
 *   3. Densify the sparse champion.
 *   4. Run a single `evolveDir` again to refine the densified creature.
 *      Capture the refine phase milestone summary.
 *   5. Prune synthetic synapses whose magnitude stayed near zero.
 *
 * Returns per-phase scores plus the two milestone summaries.
 */
export async function runSyntheticSynapseDemo(
  config: SyntheticSynapseConfig = DEFAULT_SYNTHETIC_SYNAPSE_CONFIG,
  options: { dataDir?: string } = {},
): Promise<SyntheticSynapseResult> {
  if (config.heldOutSize <= 0 || config.trainingSize <= 0) {
    throw new Error("heldOutSize and trainingSize must be positive");
  }
  if (config.maxIterationsPerPhase <= 0) {
    throw new Error("maxIterationsPerPhase must be positive");
  }
  if (config.timeoutMinutes <= 0) {
    throw new Error("timeoutMinutes must be positive");
  }

  const start = Date.now();
  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ??
    Deno.makeTempDirSync({ prefix: "synthetic_synapse_data_" });

  try {
    // Build target network and synthesise training/held-out datasets.
    const target = buildTargetNetwork(config);
    const trainingSet = generateDataset(
      target,
      config.trainingSize,
      config.seed ^ 0x1234_5678,
    );
    const heldOutSet = generateDataset(
      target,
      config.heldOutSize,
      config.seed ^ 0x9abc_def0,
    );

    if (ownDataDir) writeBinaryDataset(trainingSet, dataDir);

    // NEAT-AI requires `timeoutMinutes` to be a positive integer, so we
    // floor the per-phase split (and clamp at 1 minute) rather than
    // pass the literal half-budget. Each phase still respects the
    // overall backstop because the total wall-clock spent across both
    // phases cannot exceed `timeoutMinutes` (20 min under issue #389;
    // 5 min before the Refresh-2026-05 bump).
    const phaseTimeoutMinutes = Math.max(
      1,
      Math.floor(config.timeoutMinutes / 2),
    );
    const phases: PhaseRecord[] = [];
    const topologies: Record<PhaseName, TopologySnapshot> = {} as Record<
      PhaseName,
      TopologySnapshot
    >;

    // ---- Phase 1: minimal seed → evolved sparse champion ---------------
    const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
    const sparseSummary = await runEvolveDirPhase({
      creature: seed,
      dataDir,
      config,
      phaseTimeoutMinutes,
      seedOffset: 0,
    });
    const noKeys: ReadonlySet<string> = new Set();
    topologies.sparse = snapshotTopology(seed, noKeys);
    phases.push({
      phase: "sparse",
      synapseCount: seed.synapses.length,
      heldOutScore: creatureHeldOutScore(seed, heldOutSet),
    });

    // ---- Phase 2: densify the sparse champion -------------------------
    const syntheticKeys = densifyCreature(seed);
    topologies.densified = snapshotTopology(seed, syntheticKeys);
    phases.push({
      phase: "densified",
      synapseCount: seed.synapses.length,
      heldOutScore: creatureHeldOutScore(seed, heldOutSet),
    });

    // ---- Phase 3: refine the densified creature via evolveDir --------
    const refineSummary = await runEvolveDirPhase({
      creature: seed,
      dataDir,
      config,
      phaseTimeoutMinutes,
      seedOffset: 1,
    });

    // ---- Phase 4: prune synthetic synapses below threshold -----------
    pruneCreature(seed, syntheticKeys, config.pruneThreshold);
    topologies.pruned = snapshotTopology(seed, syntheticKeys);
    phases.push({
      phase: "pruned",
      synapseCount: seed.synapses.length,
      heldOutScore: creatureHeldOutScore(seed, heldOutSet),
    });

    return {
      phases,
      topologies,
      sparseSummary,
      refineSummary,
      wallClockMs: Date.now() - start,
      champion: seed,
    };
  } finally {
    if (ownDataDir) {
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch {
        // Ignore cleanup errors — temp dir may already be gone.
      }
    }
  }
}

if (import.meta.main) {
  console.log(
    "🧬 Synthetic Synapse Training Demo (issue #85, audited #206, telemetry rewire #303)",
  );
  console.log("");

  // CI/quality quick mode (mirrors the SUGGEST_QUICK=1 idiom from #388
  // and CRISPR_QUICK=1 from #373). When invoked with `SYNAPSE_QUICK=1`
  // the runner forces a tiny config, writes its artefacts under a temp
  // working directory, and never overwrites the canonical
  // docs/screenshots SVGs or .synthetic-synapse/creatures/champion.json.
  // Direct invocations still use the realistic 20-minute budget set in
  // DEFAULT_SYNTHETIC_SYNAPSE_CONFIG (issue #389 Refresh-2026-05 bump).
  const quick = Deno.env.get("SYNAPSE_QUICK") === "1";
  let quickWorkingRoot: string | undefined;
  if (quick) {
    quickWorkingRoot = Deno.makeTempDirSync({ prefix: "synthetic_synapse_quick_" });
    console.log(
      `⚡ Quick mode (SYNAPSE_QUICK=1): tiny iterations cap, ephemeral artefacts under ${quickWorkingRoot}`,
    );
  }

  const workingRoot = quick && quickWorkingRoot !== undefined ? quickWorkingRoot : WORKING_ROOT;
  const { dataDir, creaturesDir } = setupWorkingDirs(workingRoot);

  console.log(
    "🌱 Building minimal NEAT-AI seed: " +
      `new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  console.log("📊 Generating synthetic dataset and writing binary .bin training set...");

  const config: SyntheticSynapseConfig = quick
    ? {
      ...DEFAULT_SYNTHETIC_SYNAPSE_CONFIG,
      trainingSize: 16,
      heldOutSize: 16,
      targetError: 0.0001,
      timeoutMinutes: 1,
      populationSize: 6,
      maxIterationsPerPhase: 3,
    }
    : DEFAULT_SYNTHETIC_SYNAPSE_CONFIG;
  const target = buildTargetNetwork(config);
  const trainingSet = generateDataset(target, config.trainingSize, config.seed ^ 0x1234_5678);
  writeBinaryDataset(trainingSet, dataDir);

  console.log(
    `🧪 Running sparse → densified → pruned phases ` +
      `(targetError=${config.targetError}, timeoutMinutes=${config.timeoutMinutes})...`,
  );
  const result = await runSyntheticSynapseDemo(config, { dataDir });

  console.log("");
  console.log(
    `   ${"phase".padEnd(11)} ${"synapses".padStart(10)} ${"held-out score".padStart(16)}`,
  );
  for (const p of result.phases) {
    console.log(
      `   ${p.phase.padEnd(11)} ${String(p.synapseCount).padStart(10)} ${
        p.heldOutScore.toPrecision(6).padStart(16)
      }`,
    );
  }
  console.log(
    `\n   sparse  evolveDir  generations=${result.sparseSummary.generations}  ` +
      `wallClock=${(result.sparseSummary.wallClockMs / 1000).toFixed(1)}s  ` +
      `finalScore=${result.sparseSummary.finalScore.toFixed(4)}`,
  );
  console.log(
    `   refine  evolveDir  generations=${result.refineSummary.generations}  ` +
      `wallClock=${(result.refineSummary.wallClockMs / 1000).toFixed(1)}s  ` +
      `finalScore=${result.refineSummary.finalScore.toFixed(4)}`,
  );

  // Render the 3-panel topology + bar-chart SVG.
  const svg = renderSyntheticSynapseSVG({
    phases: result.phases,
    topologies: result.topologies,
    controlScore: result.phases[0].heldOutScore,
    controlSynapseCount: result.phases[0].synapseCount,
  });
  // Milestone summary SVG — sourced from the refine phase's evolveDir
  // return value (the final, post-prune topology counts come from the
  // refine summary itself).
  const summarySvg = renderEvolveDirSummarySvg(result.refineSummary, {
    title: "Synthetic Synapse — refine evolveDir Run Summary",
  });

  if (quick) {
    // Quick mode: write only into the ephemeral working root and
    // leave the canonical docs/ and .synthetic-synapse/ artefacts
    // untouched.
    const quickOutputDir = join(workingRoot, "output");
    ensureDirSync(quickOutputDir);
    const quickSvgPath = join(quickOutputDir, "synthetic_synapse.svg");
    const quickSummaryPath = join(quickOutputDir, "evolution_summary.svg");
    await Deno.writeTextFile(quickSvgPath, svg);
    await Deno.writeTextFile(quickSummaryPath, summarySvg);
    console.log(
      `⏭️  Quick mode: skipped overwriting canonical SVGs under docs/screenshots/`,
    );
  } else {
    ensureDirSync("docs/screenshots");
    ensureDirSync(join(WORKING_ROOT, "output"));
    ensureDirSync("docs/screenshots/synthetic_synapse");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    await Deno.writeTextFile(WORKING_OUTPUT_PATH, svg);
    console.log(`\n🖼️  Wrote ${SCREENSHOT_PATH}`);
    await Deno.writeTextFile(EVOLUTION_SUMMARY_SVG_PATH, summarySvg);
    console.log(`📈 Wrote ${EVOLUTION_SUMMARY_SVG_PATH}`);
  }

  // Save the champion creature for downstream inspection. In quick
  // mode this lands under the ephemeral working root, not the
  // canonical .synthetic-synapse/creatures/ path.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  console.log(
    `🕒 Completed in ${format(result.wallClockMs, { ignoreZero: true })}`,
  );
}
