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
 *
 * 🌱 **Generation 1 starts from random noise.** The initial population
 * is built by the NEAT-AI library from uniform-random weights and
 * biases — no hand-crafted topology, no tuned weight init. Structural
 * mutation (weight perturbation, bias perturbation, and add-neuron
 * splits) discovers the controller from there.
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
  classifyOutcome,
  DEFAULT_PARAMS,
  DEFAULT_TERRAIN,
  encodeState,
  initialState,
  isTerminal,
  type LanderAction,
  type LanderOutcome,
  type LanderState,
  perturbedInitialState,
  step,
} from "./physics.ts";
import { renderRunSVG, type TraceFrame } from "./svg.ts";

/** Number of inputs the controller observes. */
export const INPUT_COUNT = 7;

/** Number of action outputs the controller produces. */
export const OUTPUT_COUNT = 3;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = 400;

/**
 * Landed-on-pad rate at or above which the controller is declared
 * "solved": at least 60% of the perturbed-start trial batch must end
 * with a `landed` outcome (touching down inside the pad, near-upright,
 * with vertical and horizontal speeds inside the safe-landing bounds).
 * The threshold is checked across a fixed deterministic batch of
 * perturbed initial states so a lucky single launch cannot pass it.
 *
 * Lunar-lander is a substantially harder control problem than
 * cart-pole — the controller has to coordinate three discrete
 * thrusters against gravity, drift, fuel limits, and a pad-relative
 * landing test — so a 60% bar within 1000 generations of evolution
 * from uniform-random noise is a practical demonstration of the
 * "noise → competent" story this example tells. (The `e.g. ≥ 80%`
 * suggestion in issue #153 was an example, not a hard requirement.)
 */
export const SOLVED_LANDED_RATE = 0.6;

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
  /** Hard cap on the number of generations before giving up. */
  maxGenerations: number;
  /** Standard deviation of the weight/bias perturbation noise. */
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
   * scored on (mean across trials). Defaults to `1` (legacy single
   * canonical launch). See {@link ScoreOptions}.
   */
  trials?: number;
  /**
   * Scaling factor for the per-component perturbation applied to each
   * trial's initial state. Defaults to `0`, i.e. every trial starts
   * from the canonical {@link initialState} entry.
   */
  initialPerturbation?: number;
  /**
   * Seed for sampling per-evaluation initial-state perturbations. Held
   * constant for the whole run so candidates within a generation —
   * and across generations — are scored on the same set of starts.
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
   * Scaling factor for the per-component perturbation applied to each
   * trial's initial state. Default 0 (no perturbation — every trial
   * starts from the canonical entry).
   */
  initialPerturbation?: number;
}

/** Statistics emitted after each generation. */
export interface GenerationInfo {
  generation: number;
  bestScore: number;
  meanScore: number;
  /** Fraction of the champion's trials that ended in `landed`. */
  bestLandedRate: number;
  /** Neuron count of the champion creature for this generation. */
  neurons: number;
  /** Synapse count of the champion creature for this generation. */
  synapses: number;
}

/** Outcome and final-state record for a single trial within a batch. */
export interface TrialResult {
  /** Score for the trial (see {@link scoreFinalState}). */
  score: number;
  /** Final classification of the trial. */
  outcome: LanderOutcome;
  /** Lander state at the moment the trial terminated. */
  finalState: LanderState;
}

/** Result of scoring a creature across a (possibly single-trial) batch. */
export interface ScoreResult {
  /** Mean score across trials (used for selection). */
  score: number;
  /** Worst-trial outcome by score — tells the "what could go wrong" story. */
  outcome: LanderOutcome;
  /** Final state of the first trial — used by replay/SVG rendering. */
  finalState: LanderState;
  /** Fraction of trials that landed safely on the pad. */
  landedRate: number;
  /** Per-trial details. */
  trials: TrialResult[];
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  /** The fittest creature found during the run. */
  champion: Creature;
  /** Best (mean) score reached by the champion. */
  bestScore: number;
  /** Number of generations actually run before stopping. */
  generations: number;
  /** True when the champion reached {@link SOLVED_LANDED_RATE}. */
  solved: boolean;
  /** Champion's measured landed rate across the perturbed-start batch. */
  landedRate: number;
  /** Champion's outcome from the canonical starting state. */
  championOutcome: LanderOutcome;
  /** Final-generation mean score (for sanity checks against baselines). */
  finalMeanScore: number;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 80,
  // Hard generation cap. Variable-topology evolution from uniform-
  // random noise needs more generations to converge than the previous
  // fixed-topology search did, so the budget is bigger than the old 60.
  maxGenerations: 1000,
  mutationStrength: 0.7,
  mutationRate: 0.5,
  addNeuronRate: 0.05,
  // Score every candidate against ten different perturbed starts (the
  // same ten for every member, every generation) so the search cannot
  // win by getting lucky on a single canonical launch.
  trials: 10,
  initialPerturbation: 1.0,
  trialSeed: 24680,
};

/**
 * Build the initial population using the NEAT-AI library's uniform-random
 * creature constructor. Every member has the requested number of inputs
 * and outputs with random weights and a random output bias — **no
 * topology is hand-specified by this example**; structural mutation
 * grows hidden neurons during evolution.
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
  // with the same seed. The library treats this string as opaque.
  const uuid = `hidden-${hiddenCounter.value++}`;

  const newNeuron: NeuronExport = {
    type: "hidden",
    uuid,
    bias: uniformSigned(random, 0.5),
    squash: "LOGISTIC",
  };

  const newSynapses: SynapseExport[] = creature.synapses.filter((_, i) => i !== synapseIdx);
  // input → hidden: keep the original weight so the path through the new
  // neuron starts close to the original signal.
  newSynapses.push({
    weight: original.weight,
    fromUUID: original.fromUUID,
    toUUID: uuid,
  });
  // hidden → output: weight 1 so the LOGISTIC pass-through is roughly
  // identity at the operating point, again preserving the original
  // signal until further mutation refines it.
  newSynapses.push({
    weight: 1,
    fromUUID: uuid,
    toUUID: original.toUUID,
  });

  // The library assigns runtime indices in array order, so all hidden
  // neurons must precede the first output neuron to keep the topology
  // forward-only. Inserting the new hidden neuron just before the
  // first output is the simplest position that satisfies the rule.
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

/** Run a single trial from `start` and return the trial's score, outcome, and final state. */
function runEpisode(
  creature: Creature,
  start: LanderState,
  maxSteps: number,
): TrialResult {
  let state: LanderState = start;
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

/**
 * Score a creature by simulating one or more episodes. The default
 * (`trials = 1`, `initialPerturbation = 0`) runs a single trial from
 * the canonical {@link initialState}. Pass `options.trials > 1` together
 * with `options.initialPerturbation > 0` to evaluate the controller
 * across several perturbed initial states; the returned `score` is the
 * mean across trials and `landedRate` is the fraction that landed.
 *
 * Identical inputs always produce identical scores (driven by
 * `trialSeed`).
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  options?: ScoreOptions,
): ScoreResult {
  const trials = options?.trials ?? 1;
  const perturbation = options?.initialPerturbation ?? 0;

  if (trials <= 1 && perturbation === 0) {
    const r = runEpisode(creature, initialState(), maxSteps);
    return {
      score: r.score,
      outcome: r.outcome,
      finalState: r.finalState,
      landedRate: r.outcome === "landed" ? 1 : 0,
      trials: [r],
    };
  }

  const random = createDeterministicRandom(options?.trialSeed ?? 0);
  const records: TrialResult[] = [];
  let total = 0;
  let landed = 0;
  for (let t = 0; t < trials; t++) {
    const start = perturbation > 0 ? perturbedInitialState(random, perturbation) : initialState();
    const r = runEpisode(creature, start, maxSteps);
    records.push(r);
    total += r.score;
    if (r.outcome === "landed") landed += 1;
  }
  // The "outcome" reported is the worst trial — surfacing the failure
  // mode that drags the mean down.
  const worst = records.reduce((a, b) => (a.score <= b.score ? a : b));
  return {
    score: total / records.length,
    outcome: worst.outcome,
    finalState: records[0].finalState,
    landedRate: landed / records.length,
    trials: records,
  };
}

/** Run a full episode, recording each frame for replay/rendering. */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  start: LanderState = initialState(),
): TraceFrame[] {
  const trace: TraceFrame[] = [];
  let state: LanderState = start;
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

/** Score the trivial "no-thrust" baseline policy — pure free fall. */
export function freeFallBaselineScore(maxSteps: number = MAX_STEPS): number {
  let state: LanderState = initialState();
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    state = step(state, { main: false, left: false, right: false }, DEFAULT_PARAMS);
    if (isTerminal(state)) break;
  }
  return scoreFinalState(state, classifyOutcome(state));
}

interface ScoredMember {
  json: CreatureExport;
  score: number;
  outcome: LanderOutcome;
  landedRate: number;
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
 * Run a generational evolutionary algorithm. Truncation selection keeps
 * the top half as parents; the elite carries over so the best score is
 * monotonically non-decreasing. Stops as soon as the champion's
 * landed rate reaches {@link SOLVED_LANDED_RATE} **or**
 * `maxGenerations` is exhausted (whichever comes first) — the **hard
 * generation cap** is the second guarantee.
 */
export function evolveLanderController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): EvolveResult {
  const random = createDeterministicRandom(options.seed);
  const scoreOptions: ScoreOptions = {
    trials: options.trials,
    trialSeed: options.trialSeed,
    initialPerturbation: options.initialPerturbation,
  };
  const score = (creature: Creature) => scoreController(creature, MAX_STEPS, scoreOptions);

  // Counter for deterministic hidden-neuron UUIDs so the export stream
  // is reproducible across runs with the same seed.
  const hiddenCounter = { value: 0 };
  const mutationOpts = { addNeuronRate: options.addNeuronRate ?? 0, hiddenCounter };

  // Initial population: uniform-random NEAT genomes from the library.
  // No hand-crafted topology — `createSeededPopulation` decides the
  // initial structure, with random weights and a random output bias.
  const initialExports = buildRandomPopulation(options.seed, options.populationSize);
  let population: ScoredMember[] = initialExports.map((json) => {
    const creature = Creature.fromJSON(json);
    const r = score(creature);
    const counts = topologyCounts(json);
    return {
      json,
      score: r.score,
      outcome: r.outcome,
      landedRate: r.landedRate,
      neurons: counts.neurons,
      synapses: counts.synapses,
    };
  });

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
  let bestOutcome: LanderOutcome = "flying";
  let bestLandedRate = 0;
  let lastMeanScore = 0;
  let solvedAt = -1;

  for (let generation = 0; generation < options.maxGenerations; generation++) {
    population.sort((a, b) => b.score - a.score);
    const generationBest = population[0];
    if (generationBest.score > bestScore) {
      bestScore = generationBest.score;
      bestJSON = generationBest.json;
      bestOutcome = generationBest.outcome;
      bestLandedRate = generationBest.landedRate;
    }

    lastMeanScore = population.reduce((acc, p) => acc + p.score, 0) /
      population.length;
    options.onGeneration?.({
      generation,
      bestScore: generationBest.score,
      meanScore: lastMeanScore,
      bestLandedRate: generationBest.landedRate,
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

    if (bestLandedRate >= SOLVED_LANDED_RATE) {
      if (solvedAt < 0) solvedAt = generation;
      // When capturing snapshots, keep running until the next
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

    if (generation === options.maxGenerations - 1) break;

    const parentCount = Math.max(1, Math.floor(options.populationSize / 2));
    const parents = population.slice(0, parentCount);

    const next: ScoredMember[] = [];
    next.push(parents[0]); // elite
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
      const r = score(childCreature);
      const counts = topologyCounts(childJSON);
      next.push({
        json: childJSON,
        score: r.score,
        outcome: r.outcome,
        landedRate: r.landedRate,
        neurons: counts.neurons,
        synapses: counts.synapses,
      });
    }
    population = next;
  }

  const champion = Creature.fromJSON(bestJSON);
  return {
    champion,
    bestScore,
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestLandedRate >= SOLVED_LANDED_RATE,
    landedRate: bestLandedRate,
    championOutcome: bestOutcome,
    finalMeanScore: lastMeanScore,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/lunar_lander.svg";

/**
 * Generations at which the runner captures evolution snapshots. The
 * cadence is extended past the previous `[1, 10, 100, 1000]` because
 * variable-topology evolution from uniform-random noise typically
 * needs more generations to converge than the old fixed-topology
 * search did.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 100, 500, 1000];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-lunar-lander/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/lunar_lander_evolution.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/lunar_lander/evolution.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🚀 Lunar Lander Descent Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-lunar-lander");

  const baseline = freeFallBaselineScore();
  console.log(`🪂 Free-fall baseline score: ${baseline.toFixed(1)}`);

  console.log("\n🧬 Evolving controller from uniform-random NEAT noise...");
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionStart = Date.now();
  const result = evolveLanderController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestScore, meanScore, bestLandedRate, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      if (generation % 10 === 0) {
        console.log(
          `   Gen ${generation.toString().padStart(4)}  best=${
            bestScore.toFixed(1).padStart(8)
          }  mean=${meanScore.toFixed(1).padStart(8)}  ` +
            `landed=${(bestLandedRate * 100).toFixed(0).padStart(3)}%  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} ${result.solved ? "Solved" : "Did not solve"} after ${result.generations} ` +
      `generations (best=${result.bestScore.toFixed(1)}, landed=${
        (result.landedRate * 100).toFixed(0)
      }%, ` +
      `threshold=${(SOLVED_LANDED_RATE * 100).toFixed(0)}%, baseline=${baseline.toFixed(1)}).`,
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

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Lunar Lander — Evolution",
      scoreLabel: "best score",
    });
    ensureDirSync("docs/screenshots/lunar_lander");
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

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
