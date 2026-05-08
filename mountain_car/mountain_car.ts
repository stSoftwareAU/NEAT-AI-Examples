/**
 * Mountain Car Control Example
 *
 * Evolves a NEAT-AI creature to drive an under-powered car up a
 * sinusoidal hill — the second canonical OpenAI Gym RL benchmark. The
 * car's engine cannot push it directly up the slope, so the controller
 * must learn to swing back-and-forth across the valley to build
 * momentum. The simulator (see `physics.ts`) and the evolutionary loop
 * run entirely in pure TypeScript; the only external dependency is
 * NEAT-AI's `Creature.activate` to compute each step's action.
 *
 * Inputs (per timestep): `[x, v]`.
 * Outputs (3 logistic neurons): `[push-left, no-push, push-right]`. The
 * argmax over the three outputs selects the action `{-1, 0, +1}`.
 * Score: a success bonus minus a normalised step count, so faster
 * solves outscore slower ones; failed episodes score below all wins.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import {
  encodeState,
  initialState,
  isSuccess,
  MAX_EPISODE_STEPS,
  type MountainCarState,
  step,
} from "./physics.ts";
import { renderRunSVG } from "./svg.ts";

/** Number of inputs the controller observes (x, v). */
export const INPUT_COUNT = 2;

/** Number of action outputs (push-left, no-push, push-right). */
export const OUTPUT_COUNT = 3;

/** Index of the first output neuron, immediately after the inputs. */
const FIRST_OUTPUT_INDEX = INPUT_COUNT;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = MAX_EPISODE_STEPS;

/** Bonus added to the score when the car reaches the goal flag. */
export const SUCCESS_BONUS = 1000;

/** Scale of the per-step penalty (normalised by `MAX_STEPS`). */
export const STEP_PENALTY_SCALE = SUCCESS_BONUS;

/**
 * Score for an unsuccessful run (timeout). We penalise distance from
 * the goal so a car that reaches a higher peak still ranks above one
 * that never leaves the valley — even when neither succeeds. The
 * baseline is well below any successful score so the evolutionary
 * pressure is to "actually solve it".
 */
export const FAILURE_FLAT_PENALTY = -100;

/** Configuration options for {@link evolveMountainCarController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Maximum number of generations before giving up. */
  maxGenerations: number;
  /** Magnitude of the weight/bias perturbation noise. */
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
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best score reached by the champion. */
  bestScore: number;
  /** Number of generations actually run. */
  generations: number;
  /** Number of steps the champion took to reach the goal (or MAX_STEPS). */
  championSteps: number;
  /** True when the champion drove the car past `x ≥ 0.5`. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 30,
  maxGenerations: 60,
  mutationStrength: 0.6,
  mutationRate: 0.5,
};

/**
 * Build a small linear network: two inputs feeding directly into three
 * LOGISTIC outputs (one per action). Six weights and three biases is a
 * compact search space that captures swing-up policies — including the
 * "push in the direction of motion" reflex — without inflating
 * evolution time.
 */
export function buildInitialCreatureJSON(
  weights: number[],
  biases: [number, number, number],
): LegacyCreatureJSON {
  if (weights.length !== INPUT_COUNT * OUTPUT_COUNT) {
    throw new Error(
      `weights must contain exactly ${INPUT_COUNT * OUTPUT_COUNT} entries, got ${weights.length}`,
    );
  }
  const neurons: LegacyCreatureJSON["neurons"] = [];
  for (let i = 0; i < INPUT_COUNT; i++) {
    neurons.push({ type: "input", squash: "LOGISTIC", index: i, uuid: `input-${i}` });
  }
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    neurons.push({
      type: "output",
      squash: "LOGISTIC",
      index: FIRST_OUTPUT_INDEX + o,
      bias: biases[o],
      uuid: `output-${o}`,
    });
  }
  const synapses: LegacyCreatureJSON["synapses"] = [];
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    for (let i = 0; i < INPUT_COUNT; i++) {
      synapses.push({
        from: i,
        to: FIRST_OUTPUT_INDEX + o,
        weight: weights[o * INPUT_COUNT + i],
      });
    }
  }
  return { neurons, synapses, input: INPUT_COUNT, output: OUTPUT_COUNT };
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/**
 * Construct a random initial creature JSON. Weights drawn from
 * `[-1, 1]` and biases from `[-0.5, 0.5]` give the seeded population a
 * wide mix of behaviours (push-left-leaning, push-right-leaning,
 * coasting) from the very first generation.
 */
export function randomCreatureJSON(random: () => number): LegacyCreatureJSON {
  const weights: number[] = [];
  for (let i = 0; i < INPUT_COUNT * OUTPUT_COUNT; i++) {
    weights.push(uniformSigned(random, 1));
  }
  const biases: [number, number, number] = [
    uniformSigned(random, 0.5),
    uniformSigned(random, 0.5),
    uniformSigned(random, 0.5),
  ];
  return buildInitialCreatureJSON(weights, biases);
}

/** Decode a creature export back into its weights and biases. */
export function genesFromCreatureJSON(
  json: LegacyCreatureJSON,
): { weights: number[]; biases: [number, number, number] } {
  const weights = new Array(INPUT_COUNT * OUTPUT_COUNT).fill(0);
  for (const synapse of json.synapses) {
    const o = synapse.to - FIRST_OUTPUT_INDEX;
    if (o >= 0 && o < OUTPUT_COUNT && synapse.from >= 0 && synapse.from < INPUT_COUNT) {
      weights[o * INPUT_COUNT + synapse.from] = synapse.weight;
    }
  }
  const biases: [number, number, number] = [0, 0, 0];
  for (let o = 0; o < OUTPUT_COUNT; o++) {
    const neuron = json.neurons.find((n) => n.uuid === `output-${o}`);
    biases[o] = neuron?.bias ?? 0;
  }
  return { weights, biases };
}

/**
 * Mutate a creature genome: each gene is perturbed independently with
 * probability `mutationRate`. Noise is drawn uniformly from
 * `[-mutationStrength, mutationStrength]`.
 */
export function mutateCreatureJSON(
  parent: LegacyCreatureJSON,
  random: () => number,
  mutationRate: number,
  mutationStrength: number,
): LegacyCreatureJSON {
  const { weights, biases } = genesFromCreatureJSON(parent);
  const newWeights = weights.map((w) =>
    random() < mutationRate ? w + uniformSigned(random, mutationStrength) : w
  );
  const newBiases = biases.map((b) =>
    random() < mutationRate ? b + uniformSigned(random, mutationStrength) : b
  ) as [number, number, number];
  return buildInitialCreatureJSON(newWeights, newBiases);
}

/**
 * Convert the creature's three logistic outputs into a discrete action
 * by argmax: index 0 → push left (-1), 1 → coast (0), 2 → push right
 * (+1). Ties favour lower indices (left / coast) which is irrelevant
 * for the evolutionary search but keeps the mapping deterministic.
 */
export function decodeAction(outputs: ArrayLike<number>): -1 | 0 | 1 {
  let bestIdx = 0;
  let best = outputs[0];
  for (let i = 1; i < OUTPUT_COUNT; i++) {
    if (outputs[i] > best) {
      best = outputs[i];
      bestIdx = i;
    }
  }
  return (bestIdx - 1) as -1 | 0 | 1;
}

/**
 * Score a creature by running the simulator. Successful episodes are
 * rewarded with `SUCCESS_BONUS - normalisedStepCount`, so faster solves
 * score higher. Timeouts receive a flat penalty plus a small bonus for
 * the highest position reached, which gives the evolutionary search a
 * useful gradient to follow long before any genome solves the task.
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): { score: number; steps: number; solved: boolean; finalState: MountainCarState } {
  let state: MountainCarState = initialState();
  let highestX = state.x;
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action);
    if (state.x > highestX) highestX = state.x;
    if (isSuccess(state)) {
      const steps = stepIdx + 1;
      const score = SUCCESS_BONUS - (STEP_PENALTY_SCALE * steps) / maxSteps;
      return { score, steps, solved: true, finalState: state };
    }
  }
  // Timeout: scale [-1.2, 0.5] → [0, 1] for the partial-credit term.
  const partial = (highestX + 1.2) / (0.5 + 1.2);
  const score = FAILURE_FLAT_PENALTY + 50 * partial;
  return { score, steps: maxSteps, solved: false, finalState: state };
}

/**
 * Replay a creature's run, recording the state at every timestep up to
 * and including the success step (or until `MAX_STEPS`). The first
 * entry is always the initial state so SVG renderers can position the
 * car correctly even on a one-frame trace.
 */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): MountainCarState[] {
  const trace: MountainCarState[] = [];
  let state: MountainCarState = initialState();
  trace.push(state);
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action);
    trace.push(state);
    if (isSuccess(state)) break;
  }
  return trace;
}

/**
 * Score the canonical hand-crafted swing-up policy: push in the
 * direction of current velocity (`+1` when `v >= 0`, otherwise `-1`).
 * Used as a sanity baseline that the simulator is solvable.
 */
export function scoreSwingUpPolicy(maxSteps: number = MAX_STEPS): {
  score: number;
  steps: number;
  solved: boolean;
} {
  let state: MountainCarState = initialState();
  let highestX = state.x;
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    const action = state.v >= 0 ? 1 : -1;
    state = step(state, action);
    if (state.x > highestX) highestX = state.x;
    if (isSuccess(state)) {
      const steps = stepIdx + 1;
      const score = SUCCESS_BONUS - (STEP_PENALTY_SCALE * steps) / maxSteps;
      return { score, steps, solved: true };
    }
  }
  const partial = (highestX + 1.2) / (0.5 + 1.2);
  const score = FAILURE_FLAT_PENALTY + 50 * partial;
  return { score, steps: maxSteps, solved: false };
}

/**
 * Run a generational evolutionary algorithm. Truncation selection
 * keeps the top half as parents; the elite carries over so the best
 * score is monotonically non-decreasing. Stops early once a champion
 * solves the task.
 */
export function evolveMountainCarController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);

  let population: { json: LegacyCreatureJSON; score: number; steps: number; solved: boolean }[] =
    [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const { score, steps, solved } = scoreController(creature);
    population.push({ json, score, steps, solved });
  }

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
  let bestSteps = MAX_STEPS;
  let bestSolved = false;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.score - a.score);
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestJSON = generationBest.json;
      bestSteps = generationBest.steps;
      bestSolved = generationBest.solved;
    }

    const meanScore = population.reduce((acc, p) => acc + p.score, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestScore: generationBest.score,
      meanScore,
      neurons: generationBest.json.neurons.length,
      synapses: generationBest.json.synapses.length,
    });

    if (bestSolved) {
      solvedAt = generation;
      break;
    }

    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    const next: typeof population = [];
    next.push(parents[0]); // elite
    while (next.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureJSON(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
      );
      const childCreature = Creature.fromJSON(asCreatureExport(childJSON));
      const { score, steps, solved } = scoreController(childCreature);
      next.push({ json: childJSON, score, steps, solved });
    }
    population = next;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestScore,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    championSteps: bestSteps,
    solved: bestSolved,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mountain_car.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/mountain_car/evolution.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🚗 Mountain Car Control Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-mountain-car");

  console.log("🧪 Sanity check: hand-crafted swing-up policy");
  const sanity = scoreSwingUpPolicy();
  console.log(
    `   Swing-up policy ${sanity.solved ? "SOLVED" : "did not solve"} in ${sanity.steps} steps ` +
      `(score=${sanity.score.toFixed(2)}).`,
  );

  console.log("\n🧬 Evolving controller...");
  const evolutionSamples: EvolutionSample[] = [];
  const result = evolveMountainCarController({
    ...DEFAULT_EVOLVE_OPTIONS,
    onGeneration: ({ generation, bestScore, meanScore, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      if (generation % 5 === 0) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  best=${
            bestScore.toFixed(1).padStart(8)
          }  mean=${meanScore.toFixed(1).padStart(8)}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} ${result.solved ? "Solved" : "Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(steps=${result.championSteps}, score=${result.bestScore.toFixed(2)}).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the animated SVG showing the champion's drive up the hill.
  const trace = replayController(result.champion);
  const svg = renderRunSVG(trace);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Mountain Car — Evolution",
      scoreLabel: "best score",
    });
    ensureDirSync("docs/screenshots/mountain_car");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
