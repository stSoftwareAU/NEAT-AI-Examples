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
 * Outputs (3 channels): `[push-left, no-push, push-right]`. The argmax
 * over the three outputs selects the action `{-1, 0, +1}`.
 * Score: the **mean** per-trial score across a fixed batch of perturbed
 * starts. Successful trials score a `SUCCESS_BONUS` minus a step
 * penalty so faster solves outscore slower ones; failed trials score a
 * flat penalty plus partial credit for the highest position reached.
 *
 * 🌱 **Generation 1 starts from random noise.** The initial population
 * is built by the NEAT-AI library from uniform-random weights and biases
 * — no hand-crafted topology, no tuned weight init. Structural mutation
 * (weight perturbation, bias perturbation, and add-neuron splits)
 * discovers the swing-up controller from there.
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
import {
  encodeState,
  initialState,
  isSuccess,
  MAX_EPISODE_STEPS,
  type MountainCarState,
  perturbedInitialState,
  step,
} from "./physics.ts";
import { renderRunSVG } from "./svg.ts";

/** Number of inputs the controller observes (x, v). */
export const INPUT_COUNT = 2;

/** Number of action outputs (push-left, no-push, push-right). */
export const OUTPUT_COUNT = 3;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = MAX_EPISODE_STEPS;

/** Bonus added to the score when the car reaches the goal flag. */
export const SUCCESS_BONUS = 1000;

/** Scale of the per-step penalty (normalised by `MAX_STEPS`). */
export const STEP_PENALTY_SCALE = SUCCESS_BONUS;

/**
 * Score for an unsuccessful trial (timeout). We penalise distance from
 * the goal so a car that reaches a higher peak still ranks above one
 * that never leaves the valley — even when neither succeeds.
 */
export const FAILURE_FLAT_PENALTY = -100;

/**
 * Summit-reached fraction at or above which the controller is declared
 * "solved" — the champion must crest the flag on at least 80% of the
 * perturbed-start trial batch within the step cap. This is a strict bar
 * for an under-powered car: a controller cannot luck into it on a single
 * favourable launch, it has to generalise.
 */
export const SOLVED_THRESHOLD = 0.8;

/** Configuration options for {@link evolveMountainCarController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** Hard cap on the number of generations before giving up. */
  maxGenerations: number;
  /** Magnitude of the weight/bias perturbation noise. */
  mutationStrength: number;
  /** Probability that any given gene is perturbed each generation. */
  mutationRate: number;
  /**
   * Per-creature probability of receiving an add-neuron structural
   * mutation each generation (split an existing connection by inserting
   * a hidden neuron). Defaults to a small value so topology grows
   * gradually rather than thrashing.
   */
  addNeuronRate?: number;
  /**
   * Number of independent perturbed-start trials each candidate is
   * scored on (mean across trials). Defaults to `1` (single canonical
   * start at the valley centre). See {@link ScoreOptions}.
   */
  trials?: number;
  /**
   * Half-width of the uniform position perturbation applied to each
   * trial's starting `x`. Defaults to `0`, i.e. every trial starts from
   * the canonical `(-0.5, 0)` state.
   */
  initialPerturbation?: number;
  /**
   * Seed for sampling the per-evaluation initial-state perturbations.
   * Held constant for the whole run so candidates within a generation
   * — and across generations — are scored on the same set of starts.
   */
  trialSeed?: number;
  /** Optional callback invoked once per generation with progress info. */
  onGeneration?: (info: GenerationInfo) => void;
  /**
   * Optional snapshot configuration. When supplied, the running champion
   * is captured at every generation matching `snapshotConfig.checkpoints`
   * and written to `snapshotConfig.outputDir`.
   */
  snapshotConfig?: SnapshotConfig;
}

/** Options controlling multi-trial perturbed scoring of a single creature. */
export interface ScoreOptions {
  /** Number of trials to run; the returned score is the mean. Default 1. */
  trials?: number;
  /**
   * Seed for sampling per-trial initial-state perturbations. Identical
   * inputs always produce identical scores.
   */
  trialSeed?: number;
  /**
   * Half-width of the position perturbation applied to every trial's
   * initial state. Default 0 (no perturbation — every trial starts from
   * the canonical valley centre).
   */
  initialPerturbation?: number;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
  /** Summit-reached fraction of the generation's best creature. */
  bestSummitRate: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best mean per-trial score reached by the champion. */
  bestScore: number;
  /** Champion's summit-reached fraction across the trial batch. */
  summitRate: number;
  /** Number of generations actually run. */
  generations: number;
  /** True when the champion's summit rate met {@link SOLVED_THRESHOLD}. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 40,
  maxGenerations: 300,
  mutationStrength: 0.6,
  mutationRate: 0.5,
  addNeuronRate: 0.03,
  // Score every candidate against five different perturbed starts (the
  // same five for every member, every generation) so the search cannot
  // "win" by getting lucky on the canonical symmetric launch. The 0.05
  // half-width keeps every start inside the valley bowl.
  trials: 5,
  initialPerturbation: 0.05,
  trialSeed: 24680,
};

/**
 * Build the initial population using the NEAT-AI library's uniform-random
 * creature constructor — `new Creature(INPUT_COUNT, OUTPUT_COUNT)` produces
 * a minimal seed (direct input → output connections) with random weights
 * and a random output bias. **No topology is hand-specified by this
 * example**; structural mutation grows hidden neurons during evolution.
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
 */
function addHiddenNeuron(
  creature: CreatureExport,
  random: () => number,
  hiddenCounter: { value: number },
): CreatureExport {
  if (creature.synapses.length === 0) return creature;

  const synapseIdx = Math.floor(random() * creature.synapses.length);
  const original = creature.synapses[synapseIdx];

  const uuid = `hidden-${hiddenCounter.value++}`;

  const newNeuron: NeuronExport = {
    type: "hidden",
    uuid,
    bias: uniformSigned(random, 0.5),
    squash: "LOGISTIC",
  };

  const newSynapses: SynapseExport[] = creature.synapses.filter((_, i) => i !== synapseIdx);
  newSynapses.push({
    weight: original.weight,
    fromUUID: original.fromUUID,
    toUUID: uuid,
  });
  newSynapses.push({
    weight: 1,
    fromUUID: uuid,
    toUUID: original.toUUID,
  });

  // Hidden neurons must precede output neurons to keep the topology
  // forward-only and the `from < to` invariant satisfied.
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

/**
 * Convert the creature's three outputs into a discrete action by argmax:
 * index 0 → push left (-1), 1 → coast (0), 2 → push right (+1). Ties
 * favour lower indices (left / coast) which is irrelevant for the
 * evolutionary search but keeps the mapping deterministic.
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

/** Result of running a single episode. */
interface EpisodeResult {
  score: number;
  steps: number;
  solved: boolean;
  finalState: MountainCarState;
}

/** Run a single mountain-car episode from `start` and return the result. */
function runEpisode(
  creature: Creature,
  start: MountainCarState,
  maxSteps: number,
): EpisodeResult {
  let state: MountainCarState = start;
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

/** Aggregated multi-trial score for a single creature. */
export interface ControllerScore {
  /** Mean per-trial score (used for evolution selection). */
  score: number;
  /** Fraction of trials that crested the goal flag, in `[0, 1]`. */
  summitRate: number;
  /** Number of trials that contributed to the score. */
  trials: number;
}

/**
 * Score a creature by running the simulator across a fixed batch of
 * perturbed starts. The returned `score` is the mean per-trial score —
 * the signal evolution selects on — and `summitRate` is the fraction of
 * trials that actually reached the goal flag, used for the
 * {@link SOLVED_THRESHOLD} check. Identical inputs always produce
 * identical scores (the trial PRNG is seeded by `options.trialSeed`).
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  options?: ScoreOptions,
): ControllerScore {
  const trials = options?.trials ?? 1;
  const perturbation = options?.initialPerturbation ?? 0;

  if (trials <= 1 && perturbation === 0) {
    const result = runEpisode(creature, initialState(), maxSteps);
    return {
      score: result.score,
      summitRate: result.solved ? 1 : 0,
      trials: 1,
    };
  }

  const random = createDeterministicRandom(options?.trialSeed ?? 0);
  let total = 0;
  let solved = 0;
  for (let t = 0; t < trials; t++) {
    const start = perturbation > 0 ? perturbedInitialState(random, perturbation) : initialState();
    const result = runEpisode(creature, start, maxSteps);
    total += result.score;
    if (result.solved) solved++;
  }
  return { score: total / trials, summitRate: solved / trials, trials };
}

/**
 * Replay a creature's run from the canonical valley-centre start,
 * recording the state at every timestep up to and including the success
 * step (or until `MAX_STEPS`).
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

interface ScoredMember {
  json: CreatureExport;
  score: number;
  summitRate: number;
  neurons: number;
  synapses: number;
}

function topologyCounts(json: CreatureExport): { neurons: number; synapses: number } {
  return {
    neurons: json.neurons.length + (json.input ?? INPUT_COUNT),
    synapses: json.synapses.length,
  };
}

/**
 * Run a generational evolutionary algorithm. Truncation selection keeps
 * the top half as parents; the elite carries over so the best score is
 * monotonically non-decreasing. Stops as soon as the champion's summit
 * rate reaches {@link SOLVED_THRESHOLD} or `maxGenerations` is
 * exhausted (whichever comes first) — the **hard generation cap** is
 * the second guarantee.
 */
export function evolveMountainCarController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);
  const scoreOptions: ScoreOptions = {
    trials: options.trials,
    trialSeed: options.trialSeed,
    initialPerturbation: options.initialPerturbation,
  };
  const score = (creature: Creature) => scoreController(creature, MAX_STEPS, scoreOptions);

  const hiddenCounter = { value: 0 };
  const mutationOpts = { addNeuronRate: options.addNeuronRate ?? 0, hiddenCounter };

  // Initial population: uniform-random NEAT genomes from the library.
  const initialExports = buildRandomPopulation(options.seed, options.populationSize);
  let population: ScoredMember[] = initialExports.map((json) => {
    const creature = Creature.fromJSON(json);
    const result = score(creature);
    const counts = topologyCounts(json);
    return {
      json,
      score: result.score,
      summitRate: result.summitRate,
      neurons: counts.neurons,
      synapses: counts.synapses,
    };
  });

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
  let bestSummitRate = 0;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.score - a.score);
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestSummitRate = generationBest.summitRate;
      bestJSON = generationBest.json;
    }

    const meanScore = population.reduce((acc, p) => acc + p.score, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestScore: generationBest.score,
      meanScore,
      bestSummitRate: generationBest.summitRate,
      neurons: generationBest.neurons,
      synapses: generationBest.synapses,
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

    if (bestSummitRate >= SOLVED_THRESHOLD) {
      if (solvedAt < 0) solvedAt = generation;
      // When capturing evolution snapshots, keep running until the next
      // not-yet-fired checkpoint within maxGenerations is captured —
      // otherwise the progression strip would be a single panel.
      if (options.snapshotConfig) {
        const nextCheckpoint = options.snapshotConfig.checkpoints
          .filter((c) => c > generation + 1 && c <= options.maxGenerations)
          .sort((a, b) => a - b)[0];
        if (nextCheckpoint === undefined) break;
      } else {
        break;
      }
    }

    // Truncation selection: keep top 50% as parents (always at least 1).
    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    // Build the next generation: keep elite, fill rest with mutated
    // offspring from random parents.
    const nextPopulation: ScoredMember[] = [];
    nextPopulation.push(parents[0]);
    while (nextPopulation.length < options.populationSize) {
      const parent = parents[Math.floor(random() * parents.length)];
      const childJSON = mutateCreatureExport(
        parent.json,
        random,
        options.mutationRate,
        options.mutationStrength,
        mutationOpts,
      );
      const childCreature = Creature.fromJSON(childJSON);
      const result = score(childCreature);
      const counts = topologyCounts(childJSON);
      nextPopulation.push({
        json: childJSON,
        score: result.score,
        summitRate: result.summitRate,
        neurons: counts.neurons,
        synapses: counts.synapses,
      });
    }

    population = nextPopulation;
  }

  const champion = Creature.fromJSON(bestJSON);
  return {
    champion,
    bestScore,
    summitRate: bestSummitRate,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestSummitRate >= SOLVED_THRESHOLD,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/mountain_car.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/mountain_car/evolution.svg";

/**
 * Generations at which the runner captures evolution snapshots. The
 * cadence is appropriate to variable-topology evolution from
 * uniform-random noise — the early gens show pure noise, the middle
 * milestones show structure emerging, and the final captured panel
 * shows the swing-up controller cresting the flag.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 50, 150, 300];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-mountain-car/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/mountain_car_evolution.svg";

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

  console.log("\n🧬 Evolving controller from uniform-random NEAT noise...");
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionStart = Date.now();
  const result = evolveMountainCarController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestScore, meanScore, bestSummitRate, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      if (generation % 10 === 0 || bestSummitRate >= SOLVED_THRESHOLD) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  best=${
            bestScore.toFixed(1).padStart(8)
          }  mean=${meanScore.toFixed(1).padStart(8)}  ` +
            `summit=${(bestSummitRate * 100).toFixed(0).padStart(3)}%  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} ${result.solved ? "Solved" : "Did not solve"} ` +
      `after ${result.generations} generations ` +
      `(summit=${(result.summitRate * 100).toFixed(0)}%, ` +
      `score=${result.bestScore.toFixed(2)}, threshold=${SOLVED_THRESHOLD * 100}%).`,
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

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Mountain Car — Evolution Progress",
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
