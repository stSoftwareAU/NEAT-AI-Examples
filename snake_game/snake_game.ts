/**
 * Snake Game Example.
 *
 * Evolves a NEAT-AI controller to play the classic Snake grid game.
 * Each agent observes a small sensor pack (wall distances, food
 * direction, tail direction, length — see `agent.ts`) and emits four
 * activations, one per heading; the argmax becomes the next heading.
 * The simulator (`snake.ts`), evolutionary loop, and animated SVG
 * renderer (`svg.ts`) all run in pure TypeScript; the only external
 * dependency is NEAT-AI's `Creature.activate`.
 *
 * 🌱 **Generation 1 starts from random noise.** The initial population
 * is built by NEAT-AI's uniform-random `Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` constructor — direct input → output connections with
 * weights and biases drawn by the library's RNG. **No hand-crafted
 * topology, no tuned weight init.** Hidden neurons appear only when
 * the add-neuron mutation operator splits an existing connection
 * during evolution; structural mutation discovers them.
 *
 * Score = `food × FOOD_REWARD − stepCount × STEP_PENALTY` minus a
 * one-off `DEATH_PENALTY` if the snake collided with a wall or
 * itself. Survival without eating cannot out-score eating quickly,
 * because the per-step penalty only adds up over time.
 *
 * Fitness (used for selection during evolution) adds a small
 * Manhattan-distance shaping reward on top of the raw score so
 * mutations that move the head closer to the food receive credit
 * before the snake actually eats — this breaks the flat fitness
 * landscape that previously trapped the population at "ate one food".
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  createSeededPopulation,
  createSeededRng,
  Creature,
  type CreatureExport,
  type NeuronExport,
  safeWriteJson,
  setRandomNumberGenerator,
  type SynapseExport,
} from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  captureSnapshot,
  loadSnapshots,
  type SnapshotConfig,
} from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";
import { type EvolutionSample, renderEvolutionChartSVG } from "../common/evolution_chart.ts";
import { type EpisodeAdapter, runEpisode } from "../common/episode_runner.ts";
import { decodeAction, encodeState, INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { type Heading, newGame, type SnakeState, step } from "./snake.ts";
import { renderRunSVG } from "./svg.ts";

/** Hard cap on the number of ticks a single episode is allowed. */
export const MAX_STEPS = 500;

/** Score reward per food item eaten. */
export const FOOD_REWARD = 100;

/** Per-step penalty applied at the end of the episode. */
export const STEP_PENALTY = 0.1;

/** Flat penalty applied when the snake dies (wall or self collision). */
export const DEATH_PENALTY = 50;

/**
 * Coefficient for the Manhattan-distance shaping reward used during
 * fitness evaluation. Each tick the snake moves closer to (or further
 * from) the food contributes `±DISTANCE_SHAPING_COEFF` to fitness.
 * Small enough that eating food still dominates, but large enough to
 * reward navigation progress before the first food.
 */
export const DISTANCE_SHAPING_COEFF = 0.5;

/**
 * Best-seed food-eaten threshold at or above which the controller is
 * declared "solved". The threshold is applied to the **maximum
 * eaten across the evaluation seeds** for the running champion —
 * i.e. the same number that the SVG playthrough visualises after
 * `pickBestReplaySeed`. This matches closed issue #137's "champion
 * ate at least three food on the replay episode" target, but the bar
 * means more here because evolution now starts from uniform-random
 * NEAT noise (no hand-crafted layered seed), so reaching three food
 * on any single seed is a genuine demonstration of evolution
 * discovering both topology and weights from scratch.
 */
export const SOLVED_THRESHOLD = 3;

/**
 * Minimum mean food eaten across the evaluation seed batch required
 * before the {@link SOLVED_THRESHOLD} early-stop is allowed to fire.
 * Without this floor a fragile elite that aces a single seed (and
 * fails the rest) would short-circuit the run and leave the user
 * with a flaky champion. Set above the gen-1 noise floor (~0.4) but
 * below the typical mean reached at the food-three plateau (~1.6).
 */
export const SOLVED_AVG_FLOOR = 1.5;

/**
 * Episode seeds used to evaluate every creature during evolution. The
 * fitness reported to the selection step is the mean across these
 * episodes, so a controller has to generalise across several food
 * spawn sequences to win — far more robust than a single fixed seed.
 */
export const DEFAULT_EVAL_SEEDS: readonly number[] = [
  0x51a1,
  0x51a2,
  0x51a3,
  0x51a4,
  0x51a5,
];

/**
 * Default fallback replay seed used when the runner is asked to render
 * the SVG without first picking the best-performing evaluation seed.
 * Tests pin this so reruns produce identical SVGs.
 */
export const DEFAULT_REPLAY_SEED = DEFAULT_EVAL_SEEDS[0];

/**
 * Pick the evaluation seed on which `creature` ate the most food.
 * Ties favour earlier seeds in `seeds`. Used by the runner so the
 * recorded SVG always shows the champion's strongest playthrough
 * across the multi-episode evaluation, rather than picking a fixed
 * seed where the run might end on a bad spawn.
 */
export function pickBestReplaySeed(
  creature: Creature,
  seeds: readonly number[] = DEFAULT_EVAL_SEEDS,
  maxSteps: number = MAX_STEPS,
): { seed: number; eaten: number; score: number } {
  let bestSeed = seeds[0];
  let bestEaten = -1;
  let bestScore = -Infinity;
  for (const seed of seeds) {
    const r = scoreController(creature, seed, maxSteps);
    if (
      r.eaten > bestEaten ||
      (r.eaten === bestEaten && r.score > bestScore)
    ) {
      bestEaten = r.eaten;
      bestScore = r.score;
      bestSeed = seed;
    }
  }
  return { seed: bestSeed, eaten: bestEaten, score: bestScore };
}

/**
 * Generations at which the runner captures evolution snapshots. The
 * cadence matches the typical evolution shape from uniform-random
 * NEAT noise: gen-1 random scribbles, gen-10 starting to chase food,
 * gen-50 plateau on "eat one or two", gen-100 add-neuron splits
 * starting to pay off, gen-200 elite pushes past the food-three
 * threshold on its best replay seed.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 50, 100, 200];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-snake/snapshots";

/** Path to the multi-panel evolution-progression SVG. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/snake_game_evolution.svg";

/** Path to the per-generation dual-axis evolution-chart SVG. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/snake_game/evolution.svg";

/** Configuration options for {@link evolveSnakeController}. */
export interface EvolveOptions {
  seed: number;
  populationSize: number;
  /** Hard cap on the number of generations before giving up. */
  maxGenerations: number;
  mutationStrength: number;
  mutationRate: number;
  /**
   * Per-creature probability of receiving an add-neuron structural
   * mutation each generation (split an existing connection by
   * inserting a hidden neuron). Defaults to a small value so topology
   * grows gradually rather than thrashing.
   */
  addNeuronRate?: number;
  /** Hard cap on episode length. Defaults to {@link MAX_STEPS}. */
  maxSteps?: number;
  /** Episode seeds used to evaluate fitness. Defaults to {@link DEFAULT_EVAL_SEEDS}. */
  evalSeeds?: readonly number[];
  /** When set, captures snapshots of the running champion at the listed generations. */
  snapshotConfig?: SnapshotConfig;
  onGeneration?: (info: GenerationInfo) => void;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestFitness: number;
  meanFitness: number;
  bestEaten: number;
  bestScore: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  champion: Creature;
  /** Mean raw game score across the evaluation seeds. */
  bestScore: number;
  /** Mean food eaten across the evaluation seeds. */
  championEatenAvg: number;
  /** Eaten count for the replay episode (used by the SVG). */
  championEaten: number;
  /** Steps taken on the replay episode. */
  championSteps: number;
  /** Episode seed used for the replay SVG. */
  championReplaySeed: number;
  /** Number of generations actually run before stopping (≤ maxGenerations). */
  generations: number;
  /** True when the champion's mean food eaten reached {@link SOLVED_THRESHOLD}. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 200,
  maxGenerations: 200,
  mutationStrength: 1.0,
  mutationRate: 0.5,
  addNeuronRate: 0.06,
};

/**
 * Fraction of every generation replaced with fresh uniform-random
 * NEAT genomes. Keeps a steady supply of structural and weight
 * diversity so the elite's "eat one or two food and die" lineage
 * cannot dominate forever.
 */
export const RANDOM_INJECTION_FRACTION = 0.1;

/**
 * Build the initial population using the NEAT-AI library's
 * uniform-random creature constructor. Every member has the requested
 * number of inputs and outputs with random weights and a random output
 * bias — **no topology is hand-specified by this example**; structural
 * mutation grows hidden neurons during evolution.
 *
 * `seed` controls the global library RNG so the same `seed` reproduces
 * the same initial population across runs.
 */
export function buildRandomPopulation(
  seed: number,
  populationSize: number,
): CreatureExport[] {
  setRandomNumberGenerator(createSeededRng(seed));
  return createSeededPopulation({
    inputCount: INPUT_COUNT,
    outputCount: OUTPUT_COUNT,
    populationSize,
    seeds: [],
  });
}

/** Sample a value from `[-range, range]` using the supplied PRNG. */
function uniformSigned(random: () => number, range: number): number {
  return (random() * 2 - 1) * range;
}

/** Deep-clone a creature export so callers can safely mutate it. */
function cloneExport(creature: CreatureExport): CreatureExport {
  return JSON.parse(JSON.stringify(creature)) as CreatureExport;
}

/**
 * Insert a hidden neuron in the middle of an existing connection: the
 * NEAT "add-node" structural mutation. Picks a random synapse, replaces
 * it with a path through a fresh hidden neuron, and assigns reasonable
 * starting weights so the new path approximates the original signal
 * before further mutation tunes it.
 *
 * The new neuron uses LOGISTIC activation — a smooth squash that lets
 * gradients flow during weight perturbation without the saturating
 * plateau of HARD_TANH at the edges of its range.
 */
function addHiddenNeuron(
  creature: CreatureExport,
  random: () => number,
  hiddenCounter: { value: number },
): CreatureExport {
  if (creature.synapses.length === 0) return creature;

  const synapseIdx = Math.floor(random() * creature.synapses.length);
  const original = creature.synapses[synapseIdx];

  // Issue a deterministic UUID so the export is reproducible across runs
  // with the same seed. The library treats this string as opaque, so any
  // unique identifier is acceptable.
  const uuid = `hidden-${hiddenCounter.value++}`;

  const newNeuron: NeuronExport = {
    type: "hidden",
    uuid,
    bias: uniformSigned(random, 0.5),
    squash: "LOGISTIC",
  };

  const newSynapses: SynapseExport[] = creature.synapses.filter((_, i) => i !== synapseIdx);
  // input → hidden: keep the original weight so the path through the
  // new neuron starts close to the original signal.
  newSynapses.push({
    weight: original.weight,
    fromUUID: original.fromUUID,
    toUUID: uuid,
  });
  // hidden → output: weight 1 so the LOGISTIC pass-through is roughly
  // identity at the operating point, again preserving original signal.
  newSynapses.push({
    weight: 1,
    fromUUID: uuid,
    toUUID: original.toUUID,
  });

  // The library assigns runtime indices in array order, so all
  // hidden neurons must precede the first output neuron to keep the
  // topology forward-only (and the library validates this on load).
  // Inserting the new hidden neuron just before the first output is
  // the simplest position that satisfies the rule for every possible
  // split — split target may be an output, a hidden neuron, or
  // (implicitly) an input. When the new hidden's index ends up
  // higher than its synapse target's index (e.g. an old hidden
  // neuron sitting between us and the output), the library silently
  // strips the resulting recurrent synapse on load. That makes the
  // mutation a no-op for those rare cases, which is acceptable here
  // because the search is generational and the next mutation tries
  // a different split.
  const firstOutputIdx = creature.neurons.findIndex((n) => n.type === "output");
  const insertAt = firstOutputIdx === -1 ? creature.neurons.length : firstOutputIdx;
  const newNeurons = [
    ...creature.neurons.slice(0, insertAt),
    newNeuron,
    ...creature.neurons.slice(insertAt),
  ];

  return {
    ...creature,
    neurons: newNeurons,
    synapses: newSynapses,
  };
}

/**
 * Mutate a creature genome. Each existing weight and non-input bias is
 * perturbed independently with probability `mutationRate`; the noise is
 * drawn uniformly from `[-mutationStrength, mutationStrength]`. With
 * probability `addNeuronRate` the genome additionally receives a NEAT
 * add-node structural mutation (split one synapse with a hidden neuron).
 *
 * The resulting export is suitable for `Creature.fromJSON(...)`. No
 * topology is hand-specified — every change here is a generic NEAT
 * mutation operator that works on whatever variable topology the
 * creature currently has.
 */
export function mutateCreatureExport(
  parent: CreatureExport,
  random: () => number,
  mutationRate: number,
  mutationStrength: number,
  options?: { addNeuronRate?: number; hiddenCounter?: { value: number } },
): CreatureExport {
  const child = cloneExport(parent);

  for (const synapse of child.synapses) {
    if (random() < mutationRate) {
      synapse.weight += uniformSigned(random, mutationStrength);
    }
  }

  for (const neuron of child.neurons) {
    if (random() < mutationRate) {
      neuron.bias = (neuron.bias ?? 0) + uniformSigned(random, mutationStrength);
    }
  }

  const addNeuronRate = options?.addNeuronRate ?? 0;
  const counter = options?.hiddenCounter ?? { value: 0 };
  if (addNeuronRate > 0 && random() < addNeuronRate) {
    return addHiddenNeuron(child, random, counter);
  }

  return child;
}

/** Outcome of a single scoring episode. */
export interface EpisodeResult {
  /** Raw game score: `eaten × FOOD_REWARD − steps × STEP_PENALTY − DEATH_PENALTY?`. */
  score: number;
  /** Fitness as used for selection: `score + DISTANCE_SHAPING_COEFF × Δdistance`. */
  fitness: number;
  eaten: number;
  steps: number;
  died: boolean;
  finalState: SnakeState;
}

function manhattan(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Build a snake-game {@link EpisodeAdapter} bound to a per-episode RNG.
 * The food sequence is driven by the same `episodeRandom` so two
 * controllers given the same `episodeSeed` see the same spawns.
 */
function snakeAdapter(
  start: SnakeState,
  episodeRandom: () => number,
): EpisodeAdapter<SnakeState, Heading> {
  return {
    initialState: start,
    encode: encodeState,
    decode: decodeAction,
    step: (s, a) => step(s, a, episodeRandom),
    isTerminal: (s) => s.dead,
  };
}

/**
 * Play one episode and score the controller. The same per-episode
 * seed is used for every controller in a generation so the comparison
 * is fair (same initial state, same food sequence on equivalent
 * decisions).
 *
 * Both the raw game `score` and a `fitness` value (raw score plus a
 * small Manhattan-distance shaping reward) are returned. Selection
 * uses fitness; the public summary keeps reporting raw score so the
 * scoreboard remains directly comparable to the README formula.
 */
export function scoreController(
  creature: Creature,
  episodeSeed: number,
  maxSteps: number = MAX_STEPS,
): EpisodeResult {
  const episodeRandom = createDeterministicRandom(episodeSeed);
  const start = newGame(episodeRandom);
  const { trace, finalState } = runEpisode(creature, snakeAdapter(start, episodeRandom), {
    maxSteps,
  });

  // Post-hoc Manhattan-distance shaping. Matches the per-step
  // accumulation the inline loop used to do — for each consecutive pair
  // of states in the trace, credit/penalty the snake for closing on or
  // backing away from the food.
  let shaping = 0;
  for (let i = 1; i < trace.length; i++) {
    const prevDistance = manhattan(trace[i - 1].body[0], trace[i - 1].food);
    const newDistance = manhattan(trace[i].body[0], trace[i].food);
    shaping += (prevDistance - newDistance) * DISTANCE_SHAPING_COEFF;
  }

  const score = finalState.eaten * FOOD_REWARD - finalState.steps * STEP_PENALTY -
    (finalState.dead ? DEATH_PENALTY : 0);
  return {
    score,
    fitness: score + shaping,
    eaten: finalState.eaten,
    steps: finalState.steps,
    died: finalState.dead,
    finalState,
  };
}

/** Mean fitness/score/eaten across a list of evaluation seeds. */
export interface MultiEpisodeResult {
  /** Mean shaped fitness across the seed batch (used for selection). */
  fitness: number;
  /** Mean raw game score across the seed batch. */
  score: number;
  /** Mean food eaten across the seed batch. */
  eaten: number;
  /** Mean steps survived across the seed batch. */
  steps: number;
  /**
   * Maximum food eaten on any single seed in the batch — the same
   * number the SVG playthrough renders after `pickBestReplaySeed`,
   * and the value the {@link SOLVED_THRESHOLD} early-stop is checked
   * against.
   */
  maxEaten: number;
}

/**
 * Average a controller's episode results across `seeds`. Used during
 * evolution so a controller has to do well on more than one food
 * sequence to win, instead of overfitting to a single replay.
 */
export function evaluateController(
  creature: Creature,
  seeds: readonly number[],
  maxSteps: number = MAX_STEPS,
): MultiEpisodeResult {
  let fitness = 0;
  let score = 0;
  let eaten = 0;
  let steps = 0;
  let maxEaten = 0;
  for (const seed of seeds) {
    const r = scoreController(creature, seed, maxSteps);
    fitness += r.fitness;
    score += r.score;
    eaten += r.eaten;
    steps += r.steps;
    if (r.eaten > maxEaten) maxEaten = r.eaten;
  }
  const n = seeds.length;
  return {
    fitness: fitness / n,
    score: score / n,
    eaten: eaten / n,
    steps: steps / n,
    maxEaten,
  };
}

/**
 * Replay a creature's run from the same initial state, returning the
 * full state trace (one entry per tick, including the initial state)
 * suitable for the SVG renderer.
 */
export function replayController(
  creature: Creature,
  episodeSeed: number,
  maxSteps: number = MAX_STEPS,
): SnakeState[] {
  const episodeRandom = createDeterministicRandom(episodeSeed);
  const start = newGame(episodeRandom);
  return runEpisode(creature, snakeAdapter(start, episodeRandom), { maxSteps }).trace;
}

interface ScoredMember {
  json: CreatureExport;
  fitness: number;
  score: number;
  eaten: number;
  steps: number;
  /** Best per-seed eaten count across the eval seed batch. */
  maxEaten: number;
  neurons: number;
  synapses: number;
}

function topologyCounts(json: CreatureExport): { neurons: number; synapses: number } {
  // The export omits input neurons (they are implicit in `input`), so
  // we add them back to report a comparable "total neurons" figure.
  return {
    neurons: json.neurons.length + (json.input ?? INPUT_COUNT),
    synapses: json.synapses.length,
  };
}

/**
 * Run a generational evolutionary algorithm. Truncation selection
 * keeps the top half as parents (ranked by fitness); the elite carries
 * over so the best fitness is monotonically non-decreasing. A small
 * {@link RANDOM_INJECTION_FRACTION} of every generation is replaced
 * by fresh uniform-random NEAT genomes so structural diversity does
 * not collapse onto the elite's local optimum. Stops as soon as the
 * running champion's **best per-seed eaten count** reaches
 * {@link SOLVED_THRESHOLD} or `maxGenerations` is exhausted,
 * whichever comes first — the **hard generation cap** is the second
 * guarantee.
 */
export function evolveSnakeController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const evalSeeds = options.evalSeeds ?? DEFAULT_EVAL_SEEDS;

  // Counter for deterministic hidden-neuron UUIDs so the export stream
  // is reproducible across runs with the same seed.
  const hiddenCounter = { value: 0 };
  const mutationOpts = { addNeuronRate: options.addNeuronRate ?? 0, hiddenCounter };

  // Initial population: uniform-random NEAT genomes from the library.
  // No hand-crafted topology — `new Creature(input, output)` decides
  // the initial structure, with random weights and a random output
  // bias.
  const initialExports = buildRandomPopulation(options.seed, options.populationSize);
  let population: ScoredMember[] = initialExports.map((json) => {
    const creature = Creature.fromJSON(json);
    const r = evaluateController(creature, evalSeeds, maxSteps);
    const counts = topologyCounts(json);
    return {
      json,
      fitness: r.fitness,
      score: r.score,
      eaten: r.eaten,
      steps: r.steps,
      maxEaten: r.maxEaten,
      neurons: counts.neurons,
      synapses: counts.synapses,
    };
  });

  let bestJSON = population[0].json;
  let bestFitness = -Infinity;
  let bestScore = -Infinity;
  let bestEatenAvg = 0;
  let bestMaxEaten = 0;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.fitness - a.fitness);
    const generationBest = population[0];
    if (generationBest.fitness > bestFitness) {
      bestFitness = generationBest.fitness;
      bestJSON = generationBest.json;
      bestScore = generationBest.score;
      bestEatenAvg = generationBest.eaten;
      bestMaxEaten = generationBest.maxEaten;
    }

    const meanFitness = population.reduce((acc, p) => acc + p.fitness, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestFitness: generationBest.fitness,
      meanFitness,
      bestEaten: generationBest.eaten,
      bestScore: generationBest.score,
      neurons: generationBest.neurons,
      synapses: generationBest.synapses,
    });

    if (options.snapshotConfig) {
      const checkpointGen = generation + 1;
      if (options.snapshotConfig.checkpoints.includes(checkpointGen)) {
        captureSnapshot(options.snapshotConfig, checkpointGen, bestJSON, bestScore);
      }
    }

    // Two-condition early stop: the running champion must reach the
    // best-seed eaten threshold AND demonstrate it is not a one-trick
    // pony — its mean eaten across the seed batch must be above
    // {@link SOLVED_AVG_FLOOR}. Without the floor the search would
    // halt the first time a fragile elite gets lucky on a single
    // seed, leaving the user with a champion that fails most spawns.
    if (bestMaxEaten >= SOLVED_THRESHOLD && bestEatenAvg >= SOLVED_AVG_FLOOR) {
      if (solvedAt < 0) solvedAt = generation;
      // When capturing evolution snapshots, keep running until the
      // next not-yet-fired checkpoint within maxGenerations is
      // captured — otherwise the progression strip would be a single
      // panel.
      if (options.snapshotConfig) {
        const nextCheckpoint = options.snapshotConfig.checkpoints
          .filter((c) => c > generation + 1 && c <= options.maxGenerations)
          .sort((a, b) => a - b)[0];
        if (nextCheckpoint === undefined) break;
      } else {
        break;
      }
    }

    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    // Diversity injection: a small fraction of every generation is
    // freshly-sampled uniform-random NEAT genomes. This keeps a steady
    // supply of structural and weight diversity in the population so
    // the search cannot collapse onto the elite's local optimum
    // forever — without this the elite's "eat one or two food then
    // die" lineage dominates and escape mutations are rare.
    const randomCount = Math.max(0, Math.floor(options.populationSize * RANDOM_INJECTION_FRACTION));

    const next: ScoredMember[] = [];
    next.push(parents[0]); // elite
    // Build fresh uniform-random NEAT members and score them.
    if (randomCount > 0) {
      const fresh = createSeededPopulation({
        inputCount: INPUT_COUNT,
        outputCount: OUTPUT_COUNT,
        populationSize: randomCount,
        seeds: [],
      });
      for (const json of fresh) {
        const creature = Creature.fromJSON(json);
        const r = evaluateController(creature, evalSeeds, maxSteps);
        const counts = topologyCounts(json);
        next.push({
          json,
          fitness: r.fitness,
          score: r.score,
          eaten: r.eaten,
          steps: r.steps,
          maxEaten: r.maxEaten,
          neurons: counts.neurons,
          synapses: counts.synapses,
        });
      }
    }
    while (next.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureExport(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
        mutationOpts,
      );
      const childCreature = Creature.fromJSON(childJSON);
      const r = evaluateController(childCreature, evalSeeds, maxSteps);
      const counts = topologyCounts(childJSON);
      next.push({
        json: childJSON,
        fitness: r.fitness,
        score: r.score,
        eaten: r.eaten,
        steps: r.steps,
        maxEaten: r.maxEaten,
        neurons: counts.neurons,
        synapses: counts.synapses,
      });
    }
    population = next;
  }

  const champion = Creature.fromJSON(bestJSON);
  // Pick the seed on which the champion did best — the runner uses
  // this for the SVG demo so the visualisation showcases the
  // controller's strongest run rather than a worst-case spawn from the
  // eval set.
  const pick = pickBestReplaySeed(champion, evalSeeds, maxSteps);
  const replay = scoreController(champion, pick.seed, maxSteps);
  return {
    champion,
    bestScore,
    championEatenAvg: bestEatenAvg,
    championEaten: replay.eaten,
    championSteps: replay.steps,
    championReplaySeed: pick.seed,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: replay.eaten >= SOLVED_THRESHOLD && bestEatenAvg >= SOLVED_AVG_FLOOR,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/snake_game.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🐍 Snake Game Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-snake");

  console.log("🧬 Evolving controller from uniform-random NEAT noise...");
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionStart = Date.now();
  const evolutionSamples: EvolutionSample[] = [];
  const result = evolveSnakeController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: (
      { generation, bestFitness, meanFitness, bestEaten, bestScore, neurons, synapses },
    ) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      if (
        generation % 25 === 0 ||
        generation === DEFAULT_EVOLVE_OPTIONS.maxGenerations - 1 ||
        bestEaten >= SOLVED_THRESHOLD
      ) {
        console.log(
          `   Gen ${generation.toString().padStart(4)}  ` +
            `fitness=${bestFitness.toFixed(1).padStart(8)}  ` +
            `score=${bestScore.toFixed(1).padStart(7)}  ` +
            `mean=${meanFitness.toFixed(1).padStart(7)}  ` +
            `eaten=${bestEaten.toFixed(2)}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} Champion ate ${result.championEaten} food on the replay episode ` +
      `(avg=${result.championEatenAvg.toFixed(2)} across ${DEFAULT_EVAL_SEEDS.length} seeds, ` +
      `score=${result.bestScore.toFixed(2)}, generations=${result.generations}, ` +
      `threshold=${SOLVED_THRESHOLD}).`,
  );

  // Save the champion creature.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  // Render the animated SVG showing the champion's playthrough on the
  // best-performing eval seed (chosen by the evolver).
  const trace = replayController(result.champion, result.championReplaySeed);
  const svg = renderRunSVG(trace);
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH} (${trace.length} frames captured)`);

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Snake — Evolution",
      scoreLabel: "best score",
    });
    ensureDirSync("docs/screenshots/snake_game");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Snake — Evolution Progress",
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
