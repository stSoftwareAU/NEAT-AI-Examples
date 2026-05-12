/**
 * MCMC Mutation-Acceptance Demo (issue #89) + minimal-seed audit (#215),
 * telemetry simplified under #303.
 *
 * Two stages run end-to-end:
 *
 *   1. **Analytical Metropolis-Hastings sampler.** Walks a synthetic
 *      high-dimensional fitness landscape `f(x) = -‖x‖²`, proposing
 *      perturbed states each iteration. Worse-fitness moves are
 *      accepted with probability `exp(Δfitness / T)`. The temperature
 *      `T` is updated after every step using a Robbins-Monro rule that
 *      drives the empirical acceptance rate toward the canonical 23.4%
 *      optimum from Roberts/Gelman/Gilks (1997). This is the historical
 *      MH-only demo from issue #89 — listed as exempt under the
 *      no-warm-start policy because it is a pure sampler, not an
 *      evolution example. **The acceptance-rate cooling chart is driven
 *      entirely by this analytical sampler — not by NEAT-AI per-generation
 *      telemetry — and is preserved unchanged.**
 *
 *   2. **Minimal-seed NEAT-AI evolution.** Per audit #215, the published
 *      example must also genuinely *learn* a network structure from a
 *      minimal NEAT-AI seed. A small hand-crafted oracle creature labels
 *      a binary `.bin` training set; NEAT-AI is then seeded with
 *      `new Creature(INPUT_COUNT, OUTPUT_COUNT)` (no hidden hint, no
 *      pre-built `network.json`, no warm start) and runs
 *      `Creature.evolveDir(dataDir, options)` over the `.bin` set in
 *      forward-only mode until either the per-example `targetError` is
 *      reached or the `timeoutMinutes: 5` backstop fires. Under #303 the
 *      per-generation `onTrainingEvent` hook was removed in favour of
 *      NEAT-AI's supported milestone-only telemetry surface — the run is
 *      summarised via a single milestone SVG sourced from `evolveDir`'s
 *      return value plus the seed / final creature topology.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, CreatureUtil, type NeatOptions, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type EvolveDirSummary, renderEvolveDirSummarySvg } from "../common/evolve_dir_summary.ts";
import { generateSyntheticData, type SyntheticConfig } from "../common/synthetic_data.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import { renderAcceptanceSVG } from "./svg.ts";

/**
 * Optimal MH acceptance rate for high-dimensional Gaussian random-walk
 * proposals. Roberts, Gelman & Gilks (1997) showed that as the
 * dimension `d → ∞`, the asymptotically optimal acceptance rate is
 * 0.234. We use this as the controller's target and overlay it on the
 * rendered chart.
 */
export const OPTIMAL_ACCEPTANCE_RATE = 0.234;

/** A single MH proposal record. */
export interface ProposalRecord {
  /** Zero-indexed iteration number. */
  iteration: number;
  /** Whether the proposal was accepted. */
  accepted: boolean;
  /** Temperature `T` used for this proposal's accept test. */
  temperature: number;
  /** `f(x') - f(x)` — positive means the proposal is fitter. */
  deltaFitness: number;
}

/** Configuration options for {@link runMCMCAcceptance}. */
export interface MCMCOptions {
  /** Random seed driving the proposals and accept tests. */
  seed: number;
  /** Total number of MH proposals to draw. */
  iterations: number;
  /** Initial temperature `T₀`. */
  initialTemperature: number;
  /** Standard deviation of each Gaussian proposal step. */
  proposalStrength: number;
  /** Window length for the moving-average acceptance rate. */
  movingAverageWindow: number;
  /** Target acceptance rate the cooling controller aims for. */
  targetAcceptance: number;
  /** Robbins-Monro adaptation rate. Smaller = slower, smoother cooling. */
  adaptationRate: number;
  /** Dimensionality of the synthetic state vector. */
  dimension: number;
}

/** Result of a single MCMC acceptance run. */
export interface MCMCResult {
  /** Per-iteration proposal records (length === iterations). */
  proposals: ProposalRecord[];
  /** Moving-average acceptance rate at each iteration. */
  movingAcceptance: number[];
  /** Final-window acceptance rate (last value of `movingAcceptance`). */
  finalAcceptance: number;
  /** Best fitness value reached during the run (least negative). */
  bestFitness: number;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_MCMC_OPTIONS: MCMCOptions = {
  seed: 12345,
  // Start with a deliberately-cold temperature so the chain begins
  // with an acceptance rate far below the 23.4% target. The adaptive
  // controller then has to warm the chain up, producing a clearly
  // visible "cooling toward target" trace in the rendered chart.
  initialTemperature: 0.01,
  iterations: 4000,
  proposalStrength: 0.5,
  movingAverageWindow: 200,
  targetAcceptance: OPTIMAL_ACCEPTANCE_RATE,
  adaptationRate: 0.05,
  dimension: 10,
};

/** Path to the analytical MH SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mcmc_acceptance.svg";

/** Milestone summary SVG path — sourced from the `evolveDir` return value. */
export const EVOLUTION_SUMMARY_SVG_PATH = "docs/screenshots/mcmc_acceptance/evolution_summary.svg";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".synthetic-mcmc";

/** Number of input neurons fed to the NEAT-AI seed (matches the oracle). */
export const INPUT_COUNT = 3;

/** Number of output neurons fed to the NEAT-AI seed (matches the oracle). */
export const OUTPUT_COUNT = 1;

/** Configuration for the synthetic training-data generation. */
export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 256,
  recordsPerFile: 256,
  seed: 21521521,
};

/** Configuration for the minimal-seed evolution run. */
export interface MCMCEvolutionConfig {
  /** Per-example reasonable target error driving early exit. */
  targetError: number;
  /** Wall-clock backstop in minutes (issue #215 mandates 5 as upper bound). */
  timeoutMinutes: number;
  /** NEAT population size — small enough for a fast self-contained demo. */
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
 * `targetError` is deliberately tighter than what a direct-input → output
 * seed can reach for the oracle's nonlinear function, so NEAT-AI is
 * forced to grow hidden structure to satisfy the stop condition.
 */
export const DEFAULT_MCMC_EVOLUTION_CONFIG: MCMCEvolutionConfig = {
  targetError: 0.02,
  timeoutMinutes: 5,
  populationSize: 24,
  maxIterations: 1000,
  seed: 215215,
};

/** Result of {@link runMinimalSeedEvolution}. */
export interface MCMCEvolutionResult {
  /** The best creature found by `evolveDir`. */
  champion: Creature;
  /** Milestone summary captured from the single `evolveDir` call. */
  summary: EvolveDirSummary;
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
  /** True when the run reached `targetError`. */
  solved: boolean;
}

/**
 * Sample a standard-normal value via Box-Muller from two uniform
 * draws on `[0, 1)`. Returns one of the two output components — it is
 * adequate for demonstration purposes.
 */
function gaussian(random: () => number): number {
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Quadratic synthetic fitness — maximised at the origin. */
function fitness(x: readonly number[]): number {
  let s = 0;
  for (const v of x) s += v * v;
  return -s;
}

/**
 * Run an adaptive Metropolis-Hastings sampler whose temperature is
 * updated after every step to drive the empirical acceptance rate
 * toward {@link MCMCOptions.targetAcceptance}. The update rule is
 * Robbins-Monro:
 *
 * - On accept: `T ← T · (1 − η · (1 − target))`
 * - On reject: `T ← T · (1 + η · target)`
 *
 * Higher `T` makes worsening proposals more likely to be accepted, so
 * the controller cools (shrinks `T`) on accepts and warms (grows `T`)
 * on rejects. The expected log-multiplier is zero exactly when the
 * realised acceptance rate equals the target, so `T` is a
 * stochastic-approximation solution to `E[A] = target`.
 */
export function runMCMCAcceptance(options: MCMCOptions = DEFAULT_MCMC_OPTIONS): MCMCResult {
  if (options.iterations <= 0) {
    throw new Error(`iterations must be positive, got ${options.iterations}`);
  }
  if (options.movingAverageWindow <= 0) {
    throw new Error(`movingAverageWindow must be positive, got ${options.movingAverageWindow}`);
  }
  if (options.dimension <= 0) {
    throw new Error(`dimension must be positive, got ${options.dimension}`);
  }
  if (options.adaptationRate <= 0 || options.adaptationRate >= 1) {
    throw new Error(`adaptationRate must lie in (0, 1), got ${options.adaptationRate}`);
  }

  const random = createDeterministicRandom(options.seed);

  // Start from a moderately-sized random state so the first proposals
  // really do explore worse-fitness territory.
  const state = new Array(options.dimension)
    .fill(0)
    .map(() => gaussian(random) * 1.5);
  let currentFitness = fitness(state);
  let bestFitness = currentFitness;

  let temperature = options.initialTemperature;
  const proposals: ProposalRecord[] = [];

  for (let i = 0; i < options.iterations; i++) {
    const proposal = state.map((v) => v + gaussian(random) * options.proposalStrength);
    const proposalFitness = fitness(proposal);
    const delta = proposalFitness - currentFitness;

    let accepted: boolean;
    if (delta >= 0) {
      // Always accept improving moves.
      accepted = true;
    } else {
      const acceptanceProbability = Math.exp(delta / temperature);
      accepted = random() < acceptanceProbability;
    }

    proposals.push({
      iteration: i,
      accepted,
      temperature,
      deltaFitness: delta,
    });

    if (accepted) {
      for (let k = 0; k < state.length; k++) state[k] = proposal[k];
      currentFitness = proposalFitness;
      if (currentFitness > bestFitness) bestFitness = currentFitness;
    }

    // Robbins-Monro temperature update — converges to E[accept] = target.
    // Higher T → more accepts, so cool on accept and warm on reject.
    const adjustment = accepted
      ? 1 - options.adaptationRate * (1 - options.targetAcceptance)
      : 1 + options.adaptationRate * options.targetAcceptance;
    temperature = Math.max(temperature * adjustment, 1e-9);
  }

  const acceptedFlags = proposals.map((p) => (p.accepted ? 1 : 0));
  const movingAcceptance = movingAverage(acceptedFlags, options.movingAverageWindow);

  return {
    proposals,
    movingAcceptance,
    finalAcceptance: movingAcceptance[movingAcceptance.length - 1],
    bestFitness,
  };
}

/**
 * Trailing moving average over `series` with the supplied window size.
 * For indices smaller than `window` the average is taken over all
 * available samples, so the returned array has the same length as the
 * input and never contains `NaN`.
 */
export function movingAverage(series: readonly number[], window: number): number[] {
  if (window <= 0) {
    throw new Error(`window must be positive, got ${window}`);
  }
  const result = new Array<number>(series.length);
  let runningSum = 0;
  for (let i = 0; i < series.length; i++) {
    runningSum += series[i];
    if (i >= window) runningSum -= series[i - window];
    const denom = Math.min(i + 1, window);
    result[i] = runningSum / denom;
  }
  return result;
}

/**
 * Split `proposals` into non-overlapping fixed-size blocks and emit
 * the acceptance rate for each block. The trailing partial block (if
 * any) is dropped so every reported rate has the same denominator.
 */
export function windowedAcceptanceRates(
  proposals: readonly ProposalRecord[],
  window: number,
): number[] {
  if (window <= 0) {
    throw new Error(`window must be positive, got ${window}`);
  }
  const blocks: number[] = [];
  for (let start = 0; start + window <= proposals.length; start += window) {
    let accepted = 0;
    for (let j = start; j < start + window; j++) {
      if (proposals[j].accepted) accepted++;
    }
    blocks.push(accepted / window);
  }
  return blocks;
}

/**
 * Hand-crafted oracle creature used to label the binary `.bin`
 * training set fed to the minimal-seed evolution stage. The oracle is
 * **not** the seed — NEAT-AI never sees its topology. It only synthesises
 * deterministic input → output pairs the evolved creature must learn
 * to reproduce.
 *
 * The function is non-trivially nonlinear (TANH and LOGISTIC hidden
 * neurons in saturation) so a direct-only seed cannot fit it tightly —
 * NEAT-AI is forced to grow hidden structure to reach `targetError`.
 */
export function createOracleCreature(): LegacyCreatureJSON {
  return {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },

      // Hidden weights are deliberately large so the TANH and LOGISTIC
      // activations sit deep in their saturation regions — this makes
      // the resulting function non-approximable by a single direct
      // input → output sigmoid, forcing NEAT-AI's minimal-seed
      // evolution to add hidden structure to fit the labels (audit
      // #215 acceptance criterion).
      { type: "hidden", squash: "TANH", index: 3, bias: 0.6, uuid: "hidden-0" },
      { type: "hidden", squash: "LOGISTIC", index: 4, bias: -0.4, uuid: "hidden-1" },
      { type: "hidden", squash: "TANH", index: 5, bias: 0.2, uuid: "hidden-2" },

      { type: "output", squash: "LOGISTIC", index: 6, bias: 0, uuid: "output-0" },
    ],
    synapses: [
      { from: 0, to: 3, weight: 3.0 },
      { from: 1, to: 3, weight: -2.4 },
      { from: 1, to: 4, weight: 3.5 },
      { from: 2, to: 4, weight: 1.8 },
      { from: 0, to: 5, weight: -2.5 },
      { from: 2, to: 5, weight: 2.2 },
      { from: 3, to: 6, weight: 3.2 },
      { from: 4, to: 6, weight: -2.7 },
      { from: 5, to: 6, weight: 2.8 },
    ],
    input: 3,
    output: 1,
  };
}

/**
 * Run minimal-seed `evolveDir` against the binary `.bin` training set in
 * `dataDir`, returning a milestone summary captured from `evolveDir`'s
 * return value plus the seed and final creature's topology.
 *
 * The seed passed in must be `new Creature(INPUT_COUNT, OUTPUT_COUNT)` —
 * this function deliberately does not construct the seed itself so the
 * caller (and the tests) can prove no hidden-layer hint leaks in.
 */
export async function runMinimalSeedEvolution(
  seed: Creature,
  dataDir: string,
  config: MCMCEvolutionConfig = DEFAULT_MCMC_EVOLUTION_CONFIG,
): Promise<MCMCEvolutionResult> {
  if (config.targetError <= 0) throw new Error("targetError must be positive");
  if (config.timeoutMinutes <= 0) throw new Error("timeoutMinutes must be positive");
  if (config.populationSize <= 0) throw new Error("populationSize must be positive");
  if (config.maxIterations <= 0) throw new Error("maxIterations must be positive");

  const seedNeuronCount = seed.neurons.length;
  const seedSynapseCount = seed.synapses.length;

  const start = Date.now();

  const neatOptions: NeatOptions = {
    seed: config.seed,
    populationSize: config.populationSize,
    iterations: config.maxIterations,
    targetError: config.targetError,
    timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
    // No feedbackLoop key → engine treats the run as forward-only.
    costOfGrowth: 0,
    // Push NEAT toward structural growth so the example genuinely
    // adds hidden neurons / inter-layer synapses from the minimal seed.
    mutationRate: 0.6,
    mutationAmount: 3,
    verbose: false,
    log: 0,
    threads: 1,
  };

  const result = await seed.evolveDir(dataDir, neatOptions);
  const wallClockMs = Date.now() - start;

  const finalError = Number.isFinite(result.error) ? result.error : 0;
  const finalScore = Number.isFinite(result.score) ? result.score : 0;
  const generations = Math.max(1, result.generation ?? 1);
  const solved = finalError <= config.targetError;

  const summary: EvolveDirSummary = {
    finalError,
    finalScore,
    wallClockMs,
    generations,
    seedNeurons: seedNeuronCount,
    seedSynapses: seedSynapseCount,
    finalNeurons: seed.neurons.length,
    finalSynapses: seed.synapses.length,
    targetError: config.targetError,
    timeoutMinutes: Math.max(1, Math.floor(config.timeoutMinutes)),
  };

  return {
    champion: seed,
    summary,
    wallClockMs,
    finalError,
    generations,
    seedNeuronCount,
    seedSynapseCount,
    solved,
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🌡️  MCMC Mutation Acceptance Demo");
  console.log("");

  const { dataDir, creaturesDir } = setupWorkingDirs(WORKING_ROOT);

  // ----- Stage 1: Analytical Metropolis-Hastings sampler --------------------
  console.log("🧪 Stage 1/2: Adaptive Metropolis-Hastings sampler (analytical)");
  const result = runMCMCAcceptance(DEFAULT_MCMC_OPTIONS);

  console.log(
    `   iterations          = ${DEFAULT_MCMC_OPTIONS.iterations}`,
  );
  console.log(
    `   target acceptance   = ${(DEFAULT_MCMC_OPTIONS.targetAcceptance * 100).toFixed(1)}%`,
  );
  console.log(
    `   final acceptance    = ${(result.finalAcceptance * 100).toFixed(1)}%`,
  );
  console.log(
    `   best fitness        = ${result.bestFitness.toFixed(4)}`,
  );
  console.log(
    `   final temperature   = ${
      result.proposals[result.proposals.length - 1].temperature.toFixed(4)
    }`,
  );

  // Render the dual-axis acceptance / temperature chart. This chart is
  // sourced from the analytical MH sampler — not NEAT-AI per-generation
  // telemetry — and is preserved unchanged.
  const svg = renderAcceptanceSVG({
    proposals: result.proposals,
    movingAcceptance: result.movingAcceptance,
    target: DEFAULT_MCMC_OPTIONS.targetAcceptance,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`   🖼️  Wrote ${SCREENSHOT_PATH}`);

  // ----- Stage 2: Minimal-seed NEAT-AI evolution (audit #215) ---------------
  console.log("\n🌱 Stage 2/2: Minimal-seed evolution (audit #215, telemetry rewire #303)");

  // Build the oracle creature and synthesise the .bin training set.
  const oracleJSON = createOracleCreature();
  const oracle = Creature.fromJSON(asCreatureExport(oracleJSON));
  oracle.validate();
  CreatureUtil.makeUUID(oracle);
  console.log(
    `   Oracle creature: ${oracle.input} inputs, ` +
      `${oracle.neurons.length} neurons, ${oracle.synapses.length} synapses ` +
      `(used only to label the .bin set — NEAT-AI never sees its topology)`,
  );
  generateSyntheticData(oracle, dataDir, SYNTHETIC_CONFIG);

  const oraclePath = join(creaturesDir, "oracle.json");
  await safeWriteJson(oraclePath, oracle.exportJSON());

  // Build the minimal seed and run evolveDir.
  console.log(
    `\n   Seed: new Creature(${INPUT_COUNT}, ${OUTPUT_COUNT}) — no hidden hint, no warm start.`,
  );
  const seed = new Creature(INPUT_COUNT, OUTPUT_COUNT);
  console.log(
    `   Seed topology: ${seed.neurons.length} neurons, ${seed.synapses.length} synapses`,
  );

  const evolutionConfig = DEFAULT_MCMC_EVOLUTION_CONFIG;
  console.log(
    `   Stop conditions: targetError=${evolutionConfig.targetError}, ` +
      `timeoutMinutes=${evolutionConfig.timeoutMinutes} (issue #215 backstop)`,
  );

  const evolutionResult = await runMinimalSeedEvolution(seed, dataDir, evolutionConfig);
  console.log(
    `   Completed ${evolutionResult.generations} generations in ` +
      `${(evolutionResult.wallClockMs / 1000).toFixed(1)}s (final error ${
        Number.isFinite(evolutionResult.finalError) ? evolutionResult.finalError.toFixed(4) : "n/a"
      })`,
  );
  console.log(
    `   Champion topology: ${evolutionResult.summary.finalNeurons} neurons, ` +
      `${evolutionResult.summary.finalSynapses} synapses ` +
      `(seed had ${evolutionResult.seedNeuronCount} / ${evolutionResult.seedSynapseCount})`,
  );

  const championPath = join(creaturesDir, "evolved.json");
  await safeWriteJson(championPath, evolutionResult.champion.exportJSON());
  console.log(`   Saved evolved champion to ${championPath}`);

  // Score the evolved champion against the same data so the README can
  // quote a "reasonable solution" number from the latest run.
  const championScore = await evolutionResult.champion.scoreDir(dataDir, {});
  console.log(`   Evolved champion score: ${championScore.score.toPrecision(6)}`);

  // Emit the milestone summary SVG.
  console.log("\n📈 Writing milestone summary SVG");
  ensureDirSync("docs/screenshots/mcmc_acceptance");
  const summarySvg = renderEvolveDirSummarySvg(evolutionResult.summary, {
    title: "MCMC Acceptance — evolveDir Run Summary",
  });
  await Deno.writeTextFile(EVOLUTION_SUMMARY_SVG_PATH, summarySvg);
  console.log(`   📈 Wrote ${EVOLUTION_SUMMARY_SVG_PATH}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
