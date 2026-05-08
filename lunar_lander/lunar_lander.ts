/**
 * Lunar Lander Descent Example
 *
 * Evolves a NEAT-AI creature to land a simplified 2D lunar lander on a
 * flat pad. The simulator (see `physics.ts`) and the evolutionary loop
 * run entirely in pure TypeScript; the only external dependency is
 * NEAT-AI's `Creature.activate` to compute each step's thruster
 * commands.
 *
 * Inputs (per timestep): `[x, y, vx, vy, angle, angularV, fuel]`.
 * Outputs (3, thresholded at 0.5): `[main, left, right]`.
 * Score: a hand-tuned function rewarding gentle pad-centred landings
 * and remaining fuel, penalising crashes and out-of-bounds drift.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { asCreatureExport, type LegacyCreatureJSON } from "../common/legacy_types.ts";
import {
  captureSnapshot,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import {
  classifyOutcome,
  DEFAULT_PARAMS,
  DEFAULT_TERRAIN,
  encodeState,
  initialState,
  isTerminal,
  type LanderAction,
  type LanderOutcome,
  type LanderState,
  step,
} from "./physics.ts";
import { renderRunSVG, type TraceFrame } from "./svg.ts";

/** Number of inputs the controller observes. */
export const INPUT_COUNT = 7;

/** Number of action outputs the controller produces. */
export const OUTPUT_COUNT = 3;

/** Index of the output neuron (the first available index after inputs). */
const FIRST_OUTPUT_INDEX = INPUT_COUNT;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = 400;

/** Scoring constants — tuned so a fuel-rich, pad-centred landing scores >> 0
 *  while free fall crashes far below it. The "flying" timeout penalises
 *  altitude so an indefinite hover does not dominate the reward. */
const SCORE = {
  landed: 1000,
  landedFuelBonus: 5,
  landedAngleCost: 200,
  landedVerticalCost: 30,
  landedHorizontalCost: 30,
  crashedFlat: -200,
  crashedDistanceCost: 5,
  crashedSpeedCost: 3,
  crashedAngleCost: 100,
  outOfBounds: -1500,
  flyingFlat: -50,
  flyingDistanceCost: 2,
  flyingAltitudeCost: 1.0,
} as const;

/** Configuration options for {@link evolveLanderController}. */
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
  /**
   * Optional snapshot configuration. When supplied, the running champion
   * is captured at every generation matching `snapshotConfig.checkpoints`
   * and written to `snapshotConfig.outputDir`.
   */
  snapshotConfig?: SnapshotConfig;
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
  /** Number of generations actually run. */
  generations: number;
  /** Outcome the champion produced when scored. */
  championOutcome: LanderOutcome;
  /** Final-generation mean score (for sanity checks against baselines). */
  finalMeanScore: number;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 40,
  maxGenerations: 60,
  mutationStrength: 0.4,
  mutationRate: 0.4,
};

/**
 * Build a small linear network: seven inputs feeding directly into
 * three LOGISTIC outputs (one per thruster). Twenty-one weights and
 * three biases is a wide enough search space to capture a competent
 * landing policy without inflating evolution time.
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
 * Construct a random initial creature JSON. Weights drawn from `[-1, 1]`
 * and biases from `[-0.5, 0.5]` give the seeded population a wide
 * spread of behaviours from the first generation.
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

/** Decode a creature export into its weights and biases. */
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

/** Convert the creature's three outputs into a thruster action. */
export function decodeAction(outputs: ArrayLike<number>): LanderAction {
  return {
    main: outputs[0] >= 0.5,
    left: outputs[1] >= 0.5,
    right: outputs[2] >= 0.5,
  };
}

/** Score a final state plus its outcome. Larger is better. */
export function scoreFinalState(
  state: LanderState,
  outcome: LanderOutcome,
): number {
  switch (outcome) {
    case "landed":
      return SCORE.landed +
        SCORE.landedFuelBonus * state.fuel -
        SCORE.landedAngleCost * Math.abs(state.angle) -
        SCORE.landedVerticalCost * Math.abs(state.vy) -
        SCORE.landedHorizontalCost * Math.abs(state.vx);
    case "crashed":
      return SCORE.crashedFlat -
        SCORE.crashedDistanceCost * Math.abs(state.x - DEFAULT_TERRAIN.padX) -
        SCORE.crashedSpeedCost * (state.vx * state.vx + state.vy * state.vy) -
        SCORE.crashedAngleCost * Math.abs(state.angle);
    case "out_of_bounds":
      return SCORE.outOfBounds;
    case "flying":
      // Episode timed out without resolution. Reward staying close to
      // the pad and penalise lingering altitude so a perpetual hover
      // does not out-score a near-landing.
      return SCORE.flyingFlat -
        SCORE.flyingDistanceCost * Math.abs(state.x - DEFAULT_TERRAIN.padX) -
        SCORE.flyingAltitudeCost * Math.max(0, state.y);
  }
}

/** Run a full episode, recording each frame for replay/rendering. */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): TraceFrame[] {
  const trace: TraceFrame[] = [];
  let state: LanderState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    trace.push({ state, action });
    state = step(state, action);
    if (isTerminal(state)) {
      // Append the terminal frame with no thrusters so renderers can
      // show the resting pose.
      trace.push({ state, action: { main: false, left: false, right: false } });
      break;
    }
  }
  if (!trace.length || trace[trace.length - 1].state !== state) {
    // Reached MAX_STEPS without termination — record the final state.
    trace.push({ state, action: { main: false, left: false, right: false } });
  }
  return trace;
}

/** Score a creature by simulating one episode. */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
): { score: number; outcome: LanderOutcome; finalState: LanderState } {
  let state: LanderState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action);
    if (isTerminal(state)) break;
  }
  const outcome = classifyOutcome(state);
  return { score: scoreFinalState(state, outcome), outcome, finalState: state };
}

/** Score the trivial "no-thrust" baseline policy — pure free fall. */
export function freeFallBaselineScore(maxSteps: number = MAX_STEPS): number {
  let state: LanderState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    state = step(state, { main: false, left: false, right: false }, DEFAULT_PARAMS);
    if (isTerminal(state)) break;
  }
  return scoreFinalState(state, classifyOutcome(state));
}

/**
 * Run a generational evolutionary algorithm. Truncation selection
 * keeps the top half as parents; the elite carries over so the best
 * score is monotonically non-decreasing.
 */
export function evolveLanderController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);

  let population: { json: LegacyCreatureJSON; score: number; outcome: LanderOutcome }[] = [];
  for (let i = 0; i < options.populationSize; i++) {
    const json = randomCreatureJSON(random);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const { score, outcome } = scoreController(creature);
    population.push({ json, score, outcome });
  }

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
  let bestOutcome: LanderOutcome = "flying";
  let lastMeanScore = 0;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.score - a.score);
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestJSON = generationBest.json;
      bestOutcome = generationBest.outcome;
    }

    lastMeanScore = population.reduce((acc, p) => acc + p.score, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestScore: generationBest.score,
      meanScore: lastMeanScore,
    });

    // Capture an evolution snapshot of the running champion at the
    // configured checkpoints. The helper is a no-op for non-checkpoint
    // generations.
    if (options.snapshotConfig) {
      const checkpointGen = generation + 1;
      if (options.snapshotConfig.checkpoints.includes(checkpointGen)) {
        captureSnapshot(options.snapshotConfig, checkpointGen, bestJSON, bestScore);
      }
    }

    if (generation === options.maxGenerations - 1) break;

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
      const { score, outcome } = scoreController(childCreature);
      next.push({ json: childJSON, score, outcome });
    }
    population = next;
  }

  const champion = Creature.fromJSON(asCreatureExport(bestJSON));
  return {
    champion,
    bestScore,
    generations: options.maxGenerations,
    championOutcome: bestOutcome,
    finalMeanScore: lastMeanScore,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/lunar_lander.svg";

/** Generations at which the runner captures evolution snapshots. */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 100, 1000];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-lunar-lander/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/lunar_lander_evolution.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🚀 Lunar Lander Descent Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-lunar-lander");

  const baseline = freeFallBaselineScore();
  console.log(`🪂 Free-fall baseline score: ${baseline.toFixed(1)}`);

  console.log("\n🧬 Evolving controller...");
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionStart = Date.now();
  const result = evolveLanderController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestScore, meanScore }) => {
      if (generation % 5 === 0 || generation === DEFAULT_EVOLVE_OPTIONS.maxGenerations - 1) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  best=${
            bestScore.toFixed(1).padStart(8)
          }  mean=${meanScore.toFixed(1).padStart(8)}`,
        );
      }
    },
  });

  const verdictIcon = result.championOutcome === "landed" ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} Champion outcome: ${result.championOutcome} ` +
      `(score=${result.bestScore.toFixed(1)}, baseline=${baseline.toFixed(1)})`,
  );

  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  const trace = replayController(result.champion);
  const svg = renderRunSVG(trace);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Lunar Lander — Evolution Progress",
      caption: {
        finalScore: result.bestScore,
        totalGenerations: result.generations,
        wallClockMs: Date.now() - evolutionStart,
      },
    });
    await Deno.writeTextFile(EVOLUTION_PROGRESS_SVG_PATH, progressionSvg);
    console.log(
      `🧬 Wrote evolution-progression strip ${EVOLUTION_PROGRESS_SVG_PATH} ` +
        `(${snapshots.length} panels)`,
    );
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
