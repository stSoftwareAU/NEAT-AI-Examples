/**
 * Cart-Pole Balancing Example
 *
 * Evolves a NEAT-AI creature to balance an inverted pole on a moving
 * cart. The classic neuroevolution control benchmark in pure
 * TypeScript: the simulator and the evolutionary loop run entirely
 * in-process, with the only external dependency being NEAT-AI's
 * `Creature.activate` to compute each step's action.
 *
 * Inputs (per timestep): `[x, v, theta, omega]`.
 * Output: a single scalar — when `>= 0.5` push right, otherwise push left.
 * Score: the number of timesteps the pole stays upright, capped at
 * `MAX_STEPS`. The task is "solved" when the champion reaches the cap.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import { type CartPoleState, encodeState, initialState, isFailed, step } from "./physics.ts";
import { renderRunSVG } from "./svg.ts";

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = 500;

/** Configuration options for {@link evolveCartPoleController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Maximum number of generations before giving up. */
  maxGenerations: number;
  /** Standard deviation of the weight/bias perturbation noise. */
  mutationStrength: number;
  /** Probability that any given gene is perturbed each generation. */
  mutationRate: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best score reached by the champion. */
  bestScore: number;
  /** Number of generations run before stopping. */
  generations: number;
  /** True when the champion balanced for the full {@link MAX_STEPS}. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 30,
  maxGenerations: 60,
  mutationStrength: 0.4,
  mutationRate: 0.5,
};

/**
 * Build a small linear network: four inputs feeding directly into a
 * single LOGISTIC output. With four weights and one bias this is enough
 * capacity to solve cart-pole as a linear policy and keeps training
 * tractable for an in-process example.
 */
export function buildInitialCreatureJSON(
  weights: [number, number, number, number],
  bias: number,
): LegacyCreatureJSON {
  return {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },
      { type: "input", squash: "LOGISTIC", index: 3, uuid: "input-3" },
      {
        type: "output",
        squash: "LOGISTIC",
        index: 4,
        bias,
        uuid: "output-0",
      },
    ],
    synapses: [
      { from: 0, to: 4, weight: weights[0] },
      { from: 1, to: 4, weight: weights[1] },
      { from: 2, to: 4, weight: weights[2] },
      { from: 3, to: 4, weight: weights[3] },
    ],
    input: 4,
    output: 1,
  };
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/**
 * Construct a random initial creature JSON. Weights are drawn from
 * `[-1, 1]` and the bias from `[-0.5, 0.5]` — a starting region wide
 * enough that the seeded population covers both push-left and push-right
 * tendencies.
 */
export function randomCreatureJSON(random: () => number): LegacyCreatureJSON {
  return buildInitialCreatureJSON(
    [
      uniformSigned(random, 1),
      uniformSigned(random, 1),
      uniformSigned(random, 1),
      uniformSigned(random, 1),
    ],
    uniformSigned(random, 0.5),
  );
}

/**
 * Decode a creature export into the four input weights and the output
 * bias. The genome layout is fixed by {@link buildInitialCreatureJSON}.
 */
export function genesFromCreatureJSON(
  json: LegacyCreatureJSON,
): { weights: [number, number, number, number]; bias: number } {
  const weights: [number, number, number, number] = [0, 0, 0, 0];
  for (const synapse of json.synapses) {
    if (synapse.to === 4 && synapse.from >= 0 && synapse.from <= 3) {
      weights[synapse.from] = synapse.weight;
    }
  }
  const output = json.neurons.find((n) => n.uuid === "output-0");
  return { weights, bias: output?.bias ?? 0 };
}

/**
 * Mutate a creature genome by perturbing each weight and the bias with
 * Gaussian-like noise. Each gene is mutated independently with
 * probability `mutationRate`; noise is drawn uniformly from
 * `[-mutationStrength, mutationStrength]` (a fast, reproducible
 * approximation suitable for this small genome).
 */
export function mutateCreatureJSON(
  parent: LegacyCreatureJSON,
  random: () => number,
  mutationRate: number,
  mutationStrength: number,
): LegacyCreatureJSON {
  const { weights, bias } = genesFromCreatureJSON(parent);
  const newWeights = weights.map((w) =>
    random() < mutationRate ? w + uniformSigned(random, mutationStrength) : w
  ) as [number, number, number, number];
  const newBias = random() < mutationRate ? bias + uniformSigned(random, mutationStrength) : bias;
  return buildInitialCreatureJSON(newWeights, newBias);
}

/**
 * Score a creature by running the cart-pole simulator. The episode ends
 * when the pole or cart leaves the failure thresholds, or after
 * {@link MAX_STEPS} timesteps. Score equals the number of steps survived.
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): number {
  let state: CartPoleState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = out[0] >= 0.5 ? 1 : -1;
    state = step(state, action);
    if (isFailed(state)) {
      return stepIdx + 1;
    }
  }
  return maxSteps;
}

/**
 * Score a hand-crafted "always push toward the pole's tilt" policy.
 * Used as a sanity check that the simulator is solvable.
 */
export function scoreTiltDirectionPolicy(maxSteps: number = MAX_STEPS): number {
  let state: CartPoleState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    const action = state.theta >= 0 ? 1 : -1;
    state = step(state, action);
    if (isFailed(state)) {
      return stepIdx + 1;
    }
  }
  return maxSteps;
}

/**
 * Replay a creature's run, recording the cart-pole state at every
 * timestep up to and including the failing step (if any). Useful for
 * generating animation frames.
 */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): CartPoleState[] {
  const trace: CartPoleState[] = [];
  let state: CartPoleState = initialState();
  trace.push(state);
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = out[0] >= 0.5 ? 1 : -1;
    state = step(state, action);
    trace.push(state);
    if (isFailed(state)) break;
  }
  return trace;
}

/**
 * Run a generational evolutionary algorithm over creature genomes. The
 * top half of each generation seeds the next via mutation; elites are
 * carried over unchanged so the best score is monotonically
 * non-decreasing.
 */
export function evolveCartPoleController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);

  // Initial population: random linear policies.
  let population: { json: LegacyCreatureJSON; score: number }[] = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const score = scoreController(creature);
    population.push({ json, score });
  }

  let bestJSON = population[0].json;
  let bestScore = -1;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.score - a.score);
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestJSON = generationBest.json;
    }

    const meanScore = population.reduce((acc, p) => acc + p.score, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestScore: generationBest.score,
      meanScore,
    });

    if (bestScore >= MAX_STEPS) {
      solvedAt = generation;
      break;
    }

    // Truncation selection: keep top 50% as parents (always at least 1).
    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    // Build the next generation: keep elites, fill rest with mutated
    // offspring from random parents.
    const nextPopulation: { json: LegacyCreatureJSON; score: number }[] = [];
    nextPopulation.push(parents[0]);
    while (nextPopulation.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureJSON(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
      );
      const childCreature = Creature.fromJSON(asCreatureExport(childJSON));
      const childScore = scoreController(childCreature);
      nextPopulation.push({ json: childJSON, score: childScore });
    }

    population = nextPopulation;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestScore,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestScore >= MAX_STEPS,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/cart_pole.svg";

/** Number of evenly-spaced keyframes sampled for the SMIL-animated SVG. */
export const SVG_FRAME_COUNT = 60;

if (import.meta.main) {
  const start = Date.now();

  console.log("🎢 Cart-Pole Balancing Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-cart-pole");

  console.log("🧪 Sanity check: hand-crafted tilt-direction policy");
  const sanityScore = scoreTiltDirectionPolicy();
  console.log(`   Hand-crafted policy survived ${sanityScore} steps.`);

  console.log("\n🧬 Evolving controller...");
  const result = evolveCartPoleController({
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestScore, meanScore }) => {
      if (generation % 5 === 0 || bestScore >= MAX_STEPS) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  best=${
            bestScore.toString().padStart(3)
          }  mean=${meanScore.toFixed(1).padStart(6)}`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations (best=${result.bestScore}).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the SVG strip showing the champion balancing.
  const trace = replayController(result.champion);
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
