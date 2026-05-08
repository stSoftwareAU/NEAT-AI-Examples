/**
 * MCMC Mutation-Acceptance Demo (issue #89).
 *
 * Demonstrates the Metropolis-Hastings (MH) acceptance pattern that
 * underpins NEAT-AI's mutation acceptance strategy. The runner walks a
 * synthetic high-dimensional fitness landscape, proposing perturbed
 * states each iteration. Worse-fitness moves are accepted with
 * probability `exp(Δfitness / T)`. The temperature `T` is updated
 * after every step using a Robbins-Monro rule that drives the empirical
 * acceptance rate toward the canonical 23.4% optimum from
 * Roberts/Gelman/Gilks (1997).
 *
 * No NEAT-AI evolution is invoked here — the focus is the MH
 * acceptance pattern itself, which is independent of the proposal
 * generator. The fitness landscape is `f(x) = -‖x‖²`, a quadratic with
 * a single optimum at the origin, which is sufficient to expose the
 * acceptance dynamics.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
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

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mcmc_acceptance.svg";

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

if (import.meta.main) {
  const start = Date.now();

  console.log("🌡️  MCMC Mutation Acceptance Demo");
  console.log("");

  setupWorkingDirs(".synthetic-mcmc");

  console.log("🧪 Running adaptive Metropolis-Hastings sampler...");
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

  // Render the dual-axis chart.
  const svg = renderAcceptanceSVG({
    proposals: result.proposals,
    movingAcceptance: result.movingAcceptance,
    target: DEFAULT_MCMC_OPTIONS.targetAcceptance,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
