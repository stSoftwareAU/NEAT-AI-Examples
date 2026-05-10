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
import { type FitnessSample, renderFitnessChartSVG } from "../common/fitness_chart.ts";
import { renderOutcomeBarChartSVG, type ScenarioOutcome } from "../common/outcome_bar_chart.ts";
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
  type LanderTerrain,
  perturbedInitialState,
  step,
} from "./physics.ts";
import { renderRunSVG, type TraceFrame } from "./svg.ts";
import {
  DEFAULT_VALIDATION_COUNT,
  generateScenarioPools,
  type SeededScenario,
} from "./scenarios.ts";

/** Number of inputs the controller observes. */
export const INPUT_COUNT = 7;

/** Number of action outputs the controller produces. */
export const OUTPUT_COUNT = 3;

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
  /**
   * NEAT-AI standard target-error stop condition. Evolution halts as
   * soon as the champion's landed rate on the training trial batch
   * reaches `1 - targetError` (default `0.01`, i.e. landed-rate ≥ 99%).
   */
  targetError: number;
  /**
   * NEAT-AI standard wall-clock stop condition. Evolution halts when
   * the elapsed time since the loop began exceeds `timeoutMinutes`
   * minutes (default `2`). Whichever of `targetError` and
   * `timeoutMinutes` fires first wins.
   */
  timeoutMinutes: number;
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
  /**
   * True when the champion reached the configured target landed rate
   * (`>= 1 - targetError`) at any point during the run.
   */
  solved: boolean;
  /** Champion's measured landed rate across the perturbed-start batch. */
  landedRate: number;
  /** Champion's outcome from the canonical starting state. */
  championOutcome: LanderOutcome;
  /** Final-generation mean score (for sanity checks against baselines). */
  finalMeanScore: number;
  /** Wall-clock duration of the evolution loop in milliseconds. */
  wallclockMs: number;
  /**
   * Why the evolution loop terminated:
   * - `"target"` — the champion reached `1 - targetError` landed rate.
   * - `"timeout"` — `timeoutMinutes` elapsed before the target fired.
   */
  stopReason: "target" | "timeout";
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 80,
  // NEAT-AI standard stop conditions: evolution halts as soon as the
  // champion's landed-rate on the training trial batch reaches
  // `1 - targetError` (default 99%) OR `timeoutMinutes` minutes have
  // elapsed since the loop began — whichever fires first.
  targetError: 0.01,
  timeoutMinutes: 2,
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

  // Hidden neurons must stay before every output. For hidden targets,
  // insert directly before the target; for output targets, insert before
  // the first output so NEAT-AI 4.x validation keeps the export ordered.
  const targetIdx = creature.neurons.findIndex((n) => n.uuid === original.toUUID);
  const target = targetIdx === -1 ? undefined : creature.neurons[targetIdx];
  const firstOutputIdx = creature.neurons.findIndex((n) => n.type === "output");
  const insertAt = target?.type === "hidden"
    ? targetIdx
    : firstOutputIdx === -1
    ? creature.neurons.length
    : firstOutputIdx;
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

/**
 * Score a final state plus its outcome. Larger is better. Pad-distance
 * costs are computed against `terrain.padX` so scenarios with a shifted
 * landing pad are scored consistently with their own geometry.
 */
export function scoreFinalState(
  state: LanderState,
  outcome: LanderOutcome,
  terrain: LanderTerrain = DEFAULT_TERRAIN,
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
        SCORE.crashedDistanceCost * Math.abs(state.x - terrain.padX) -
        SCORE.crashedSpeedCost * (state.vx * state.vx + state.vy * state.vy) -
        SCORE.crashedAngleCost * Math.abs(state.angle);
    case "out_of_bounds":
      return SCORE.outOfBounds;
    case "flying":
      // Episode timed out without resolution. Reward staying close to
      // the pad and penalise lingering altitude so a perpetual hover
      // does not out-score a near-landing.
      return SCORE.flyingFlat -
        SCORE.flyingDistanceCost * Math.abs(state.x - terrain.padX) -
        SCORE.flyingAltitudeCost * Math.max(0, state.y);
  }
}

/** Run a single trial from `start` and return the trial's score, outcome, and final state. */
function runEpisode(
  creature: Creature,
  start: LanderState,
  maxSteps: number,
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): TrialResult {
  let state: LanderState = start;
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    state = step(state, action);
    if (isTerminal(state, terrain)) break;
  }
  const outcome = classifyOutcome(state, terrain);
  return { score: scoreFinalState(state, outcome, terrain), outcome, finalState: state };
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

/**
 * Run a full episode, recording each frame for replay/rendering.
 * Pass `terrain` to align terminal classification with a non-default
 * scenario (e.g. a validation episode whose pad has shifted).
 */
export function replayController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  start: LanderState = initialState(),
  terrain: LanderTerrain = DEFAULT_TERRAIN,
): TraceFrame[] {
  const trace: TraceFrame[] = [];
  let state: LanderState = start;
  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    creature.clearState();
    const out = creature.activate(encodeState(state));
    const action = decodeAction(out);
    trace.push({ state, action });
    state = step(state, action);
    if (isTerminal(state, terrain)) {
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

/** Outcome of replaying the champion against a single validation scenario. */
export interface ValidationScenarioResult {
  /** Seed that produced this scenario (deterministic across runs). */
  seed: number;
  /** Index of the scenario within the validation pool (preserves pool order). */
  index: number;
  /** Final classification of the trial. */
  outcome: LanderOutcome;
  /** Trial fitness under {@link scoreFinalState}. */
  score: number;
  /** Lander state at the moment the trial terminated. */
  finalState: LanderState;
}

/** Aggregated counts of validation outcomes by classification. */
export interface ValidationOutcomeCounts {
  flying: number;
  landed: number;
  crashed: number;
  out_of_bounds: number;
}

/** Structured report produced by {@link validateChampion}. */
export interface ValidationReport {
  /** Per-scenario outcomes, in validation-pool order. */
  scenarios: ValidationScenarioResult[];
  /** Fraction of scenarios that ended in `landed`. */
  landedRate: number;
  /** Mean fitness across all scenarios. */
  meanFitness: number;
  /** Count of each outcome classification across the pool. */
  outcomeCounts: ValidationOutcomeCounts;
  /**
   * Index (in `scenarios`) of the scenario chosen as the SVG source.
   * See {@link pickValidationSvgIndex} for the rule.
   */
  selectedIndex: number;
}

/**
 * Pick a representative validation scenario for the descent SVG.
 *
 * Default rule: the scenario whose final score is the median across all
 * validation scenarios — sorted ascending and indexing the lower median
 * (`Math.floor((n - 1) / 2)`) so the choice is stable for ties. If every
 * scenario landed successfully, return index `0` instead — a deterministic
 * fallback that side-steps tie-break sensitivity when scores cluster
 * tightly around the landed-baseline.
 */
export function pickValidationSvgIndex(
  results: readonly ValidationScenarioResult[],
): number {
  if (results.length === 0) return -1;
  const allLanded = results.every((r) => r.outcome === "landed");
  if (allLanded) return 0;
  const order = results
    .map((r, i) => ({ score: r.score, i }))
    .sort((a, b) => a.score - b.score);
  return order[Math.floor((order.length - 1) / 2)].i;
}

/**
 * Replay the champion against every validation scenario and aggregate
 * the per-scenario outcomes plus summary metrics. Each scenario's
 * terrain is honoured during the trial so a shifted pad (`padX !== 0`)
 * is classified against its own geometry, not the canonical default.
 *
 * Output is deterministic for a fixed champion and scenario list.
 */
export function validateChampion(
  champion: Creature,
  validationScenarios: readonly SeededScenario[],
  maxSteps: number = MAX_STEPS,
): ValidationReport {
  const scenarios: ValidationScenarioResult[] = [];
  const counts: ValidationOutcomeCounts = {
    flying: 0,
    landed: 0,
    crashed: 0,
    out_of_bounds: 0,
  };
  let totalScore = 0;
  for (let i = 0; i < validationScenarios.length; i++) {
    const sc = validationScenarios[i];
    const trial = runEpisode(champion, sc.state, maxSteps, sc.terrain);
    scenarios.push({
      seed: sc.seed,
      index: i,
      outcome: trial.outcome,
      score: trial.score,
      finalState: trial.finalState,
    });
    counts[trial.outcome] += 1;
    totalScore += trial.score;
  }
  const n = scenarios.length;
  const landedRate = n === 0 ? 0 : counts.landed / n;
  const meanFitness = n === 0 ? 0 : totalScore / n;
  return {
    scenarios,
    landedRate,
    meanFitness,
    outcomeCounts: counts,
    selectedIndex: pickValidationSvgIndex(scenarios),
  };
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
 * monotonically non-decreasing. Stops as soon as the champion's landed
 * rate on the training trial batch reaches `1 - targetError` **or**
 * `timeoutMinutes` minutes of wall-clock have elapsed — whichever
 * fires first. The two stop conditions match the standard NEAT-AI
 * `NeatOptions.targetError` / `NeatOptions.timeoutMinutes` fields.
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

  const targetLandedRate = 1 - options.targetError;
  const timeoutMs = options.timeoutMinutes * 60_000;
  const loopStart = Date.now();
  let stopReason: "target" | "timeout" = "timeout";
  let generation = 0;

  while (true) {
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

    const targetMet = bestLandedRate >= targetLandedRate;
    if (targetMet && solvedAt < 0) solvedAt = generation;

    const elapsedMs = Date.now() - loopStart;
    const timedOut = elapsedMs >= timeoutMs;

    if (targetMet) {
      // When capturing snapshots, keep running until the next
      // not-yet-fired checkpoint is captured — otherwise the
      // progression strip would be a single panel.
      const nextCheckpoint = options.snapshotConfig?.checkpoints
        .filter((c) => c > generation + 1)
        .sort((a, b) => a - b)[0];
      if (nextCheckpoint === undefined) {
        stopReason = "target";
        break;
      }
    }

    if (timedOut) {
      stopReason = solvedAt >= 0 ? "target" : "timeout";
      break;
    }

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
    generation++;
  }

  const champion = Creature.fromJSON(bestJSON);
  return {
    champion,
    bestScore,
    generations: generation + 1,
    solved: solvedAt >= 0,
    landedRate: bestLandedRate,
    championOutcome: bestOutcome,
    finalMeanScore: lastMeanScore,
    wallclockMs: Date.now() - loopStart,
    stopReason,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/lunar_lander.svg";

/**
 * Path to the validation results JSON written by the runner. Downstream
 * tooling (validation bar chart, README refresh) reads this file.
 */
export const VALIDATION_RESULTS_PATH = ".synthetic-lunar-lander/validation/results.json";

/**
 * Master seed driving the held-out validation pool. Held constant so
 * every run validates against the same 200 scenarios — the controller
 * cannot have seen any of them during training (training and validation
 * pools are disjoint by construction; see `scenarios.ts`).
 */
export const VALIDATION_BASE_SEED = 13579;

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

/** Path to the per-generation fitness-chart SVG the runner emits. */
export const FITNESS_CHART_PATH = "docs/screenshots/lunar_lander/fitness.svg";

/**
 * Path to the per-validation-scenario outcome bar chart SVG the runner
 * emits. Pairs with the descent screenshot and fitness chart to give
 * readers a one-glance view of how robustly the controller generalises.
 */
export const VALIDATION_OUTCOME_SVG_PATH = "docs/screenshots/lunar_lander/validation.svg";

/** Path to the per-generation evolution telemetry CSV the runner emits. */
export const EVOLUTION_CSV_PATH = "docs/data/lunar_lander/evolution.csv";

/** Header row written at the top of {@link EVOLUTION_CSV_PATH}. */
export const EVOLUTION_CSV_HEADER = "generation,best_fitness,avg_fitness,landed_rate,wallclock_ms";

/**
 * One row of per-generation evolution telemetry. Captured during a run
 * and serialised to {@link EVOLUTION_CSV_PATH} so downstream tools can
 * inspect how the population's fitness improved over time.
 */
export interface EvolutionRow {
  /** Zero-based generation index. */
  generation: number;
  /** Best fitness in this generation (max across the population). */
  bestFitness: number;
  /** Population mean fitness in this generation. */
  avgFitness: number;
  /** Fraction of the champion's perturbed-trial batch that landed. */
  landedRate: number;
  /** Milliseconds elapsed since the evolution loop began. */
  wallclockMs: number;
}

/**
 * Format an evolution-telemetry table into a CSV string with the exact
 * {@link EVOLUTION_CSV_HEADER} header. Numeric fields use a fixed
 * representation so the file is byte-deterministic for identical inputs.
 */
export function formatEvolutionCsv(rows: readonly EvolutionRow[]): string {
  const lines: string[] = [EVOLUTION_CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.generation,
        formatCsvNumber(r.bestFitness),
        formatCsvNumber(r.avgFitness),
        formatCsvNumber(r.landedRate),
        Math.round(r.wallclockMs),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Format a finite number with up to six decimal places, trimming trailing
 * zeros so deterministic inputs produce a single canonical string.
 * Non-finite values become "0" — the CSV must not leak NaN/Infinity.
 */
function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number(v.toFixed(6)).toString();
}

/**
 * Trivial `--name=value` CLI flag parser. Returns `undefined` when the
 * flag is absent or its value is not a finite number.
 */
function parseNumericFlag(args: string[], name: string): number | undefined {
  const prefix = `${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      const v = parseFloat(arg.slice(prefix.length));
      if (Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

/**
 * CI/quality "quick mode" stop-condition overrides. When the runner is
 * invoked via `LUNAR_QUICK=1` (env var) or `--quick` (CLI flag), the
 * standard 99% / 2-minute defaults are replaced with a deliberately
 * unreachable target and a ~6-second wall-clock budget so the example
 * always exits via `timeout` and the entire pipeline finishes within
 * `quality.sh`'s tight section budget.
 *
 * - `targetError = -1` is unreachable — the threshold becomes
 *   `landed-rate >= 1 - (-1) = 2`, but `landed-rate` is bounded by 1,
 *   so the loop never trips the `target` stop condition and the
 *   wall-clock timeout always drives exit.
 * - `timeoutMinutes = 0.1` ≈ 6 seconds — comfortably under the
 *   ~10-second per-section budget the user asked for in #201.
 *
 * Quick mode also suppresses canonical artefact writes (champion JSON,
 * validation results JSON, descent SVG, evolution chart/strip, fitness
 * chart, telemetry CSV) so a CI run never overwrites the docs artefacts
 * checked into the repo. Snapshot files are written to a temp dir
 * scoped to the run so the snapshot loader still has something to read,
 * without disturbing `.synthetic-lunar-lander/snapshots/`.
 */
export const QUICK_TARGET_ERROR = -1;
export const QUICK_TIMEOUT_MINUTES = 0.1;

/**
 * Resolve whether the CI/quality "quick mode" should fire. Either
 * `LUNAR_QUICK=1` (env var) or `--quick` (CLI flag) is enough; both are
 * accepted so callers can pick whichever idiom is simpler in their
 * environment.
 */
export function isQuickMode(args: readonly string[], envValue: string | undefined): boolean {
  if (envValue === "1") return true;
  for (const arg of args) {
    if (arg === "--quick") return true;
  }
  return false;
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🚀 Lunar Lander Descent Example");
  console.log("");

  // Quick mode (CI/quality budget): forces a tiny ~6-second wall-clock
  // budget and skips canonical artefact writes so a CI invocation never
  // overwrites the docs artefacts checked into the repo. See
  // {@link isQuickMode} and {@link QUICK_TIMEOUT_MINUTES}.
  const quick = isQuickMode(Deno.args, Deno.env.get("LUNAR_QUICK"));
  if (quick) {
    console.log("⚡ Quick mode (LUNAR_QUICK=1 or --quick): tiny budget, no canonical artefacts");
    console.log("");
  }

  const { creaturesDir } = setupWorkingDirs(".synthetic-lunar-lander");

  const baseline = freeFallBaselineScore();
  console.log(`🪂 Free-fall baseline score: ${baseline.toFixed(1)}`);

  // CLI overrides for the NEAT-AI standard stop conditions. Quick mode
  // forces an impossible target plus a ~6-second timeout so the loop
  // always exits via `timeout` well inside the CI section budget.
  const targetError = quick ? QUICK_TARGET_ERROR : (parseNumericFlag(Deno.args, "--target-error") ??
    DEFAULT_EVOLVE_OPTIONS.targetError);
  const timeoutMinutes = quick
    ? QUICK_TIMEOUT_MINUTES
    : (parseNumericFlag(Deno.args, "--timeout-minutes") ??
      DEFAULT_EVOLVE_OPTIONS.timeoutMinutes);

  console.log("\n🧬 Evolving controller from uniform-random NEAT noise...");
  console.log(
    `   Stop conditions: targetError=${targetError} ` +
      `(landed-rate ≥ ${((1 - targetError) * 100).toFixed(0)}%), ` +
      `timeoutMinutes=${timeoutMinutes}`,
  );
  // In quick mode, route snapshot files into a per-run temp dir so the
  // checked-in `.synthetic-lunar-lander/snapshots/` is left untouched.
  const snapshotsDir = quick
    ? Deno.makeTempDirSync({ prefix: "lunar_lander_quick_snapshots_" })
    : SNAPSHOTS_DIR;
  ensureDirSync(snapshotsDir);
  for (const entry of Deno.readDirSync(snapshotsDir)) {
    if (entry.isFile) Deno.removeSync(join(snapshotsDir, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionRows: EvolutionRow[] = [];
  const evolutionStart = Date.now();
  const result = evolveLanderController({
    ...DEFAULT_EVOLVE_OPTIONS,
    targetError,
    timeoutMinutes,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: snapshotsDir,
    },
    onGeneration: ({ generation, bestScore, meanScore, bestLandedRate, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      evolutionRows.push({
        generation,
        bestFitness: bestScore,
        avgFitness: meanScore,
        landedRate: bestLandedRate,
        wallclockMs: Date.now() - evolutionStart,
      });
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
      `threshold=${((1 - targetError) * 100).toFixed(0)}%, baseline=${baseline.toFixed(1)}, ` +
      `stop=${result.stopReason}, wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Always exercise the post-evolution pipeline (validation, replay,
  // SVG rendering, chart construction) so quick mode still proves the
  // full code path runs end-to-end. Only the disk writes that would
  // overwrite canonical docs artefacts are gated on `!quick`.
  const championExport: CreatureExport = result.champion.exportJSON();
  if (!quick) {
    const championPath = join(creaturesDir, "champion.json");
    await safeWriteJson(championPath, championExport);
    console.log(`💾 Saved champion to ${championPath}`);
  } else {
    console.log("⏭️  Quick mode: skipped writing champion JSON");
  }

  // Validate the champion against the held-out validation pool: the SVG
  // and the validation JSON are sourced from these unseen scenarios so
  // the README's screenshot demonstrates generalisation, not memorisation.
  const validationPools = generateScenarioPools(
    VALIDATION_BASE_SEED,
    0,
    DEFAULT_VALIDATION_COUNT,
  );
  const validationReport = validateChampion(result.champion, validationPools.validation);
  console.log(
    `🧪 Validation: landed=${(validationReport.landedRate * 100).toFixed(0)}% ` +
      `(${validationReport.outcomeCounts.landed}/${validationReport.scenarios.length}), ` +
      `mean fitness=${validationReport.meanFitness.toFixed(1)}`,
  );

  if (!quick) {
    ensureDirSync(".synthetic-lunar-lander/validation");
    await safeWriteJson(VALIDATION_RESULTS_PATH, validationReport);
    console.log(
      `📝 Wrote validation results ${VALIDATION_RESULTS_PATH} ` +
        `(${validationReport.scenarios.length} scenarios)`,
    );
  } else {
    console.log("⏭️  Quick mode: skipped writing validation JSON");
  }

  // Render the per-validation-scenario outcome bar chart from the same
  // report. Lives next to the fitness chart so the README can show the
  // controller's journey (fitness chart) alongside its end-state spread
  // across all 200 unseen scenarios (this chart).
  const outcomeSamples: ScenarioOutcome[] = validationReport.scenarios.map((s) => ({
    scenarioIndex: s.index,
    outcome: s.outcome,
    score: s.score,
  }));
  if (outcomeSamples.length > 0) {
    const outcomeSvg = renderOutcomeBarChartSVG(outcomeSamples, {
      title: "Lunar Lander — Validation Outcomes",
    });
    if (!quick) {
      ensureDirSync("docs/screenshots/lunar_lander");
      await Deno.writeTextFile(VALIDATION_OUTCOME_SVG_PATH, outcomeSvg);
      console.log(
        `📊 Wrote validation outcome chart ${VALIDATION_OUTCOME_SVG_PATH} ` +
          `(${outcomeSamples.length} scenarios)`,
      );
    }
  }

  // Render the descent SVG from a representative validation scenario —
  // not from the canonical training launch — so the screenshot shows
  // the controller handling an unseen state. See `pickValidationSvgIndex`
  // for the selection rule.
  const selected = validationPools.validation[validationReport.selectedIndex];
  const selectedResult = validationReport.scenarios[validationReport.selectedIndex];
  const trace = replayController(result.champion, MAX_STEPS, selected.state, selected.terrain);
  const svg = renderRunSVG(trace, selected.terrain, selectedResult.outcome);
  if (!quick) {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(
      `🖼️  Wrote screenshot ${SCREENSHOT_PATH} ` +
        `(validation seed=${selected.seed}, outcome=${selectedResult.outcome}, ` +
        `${trace.length} frames)`,
    );
  } else {
    console.log(
      `⏭️  Quick mode: skipped writing descent SVG (rendered ${svg.length} bytes in-memory)`,
    );
  }

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Lunar Lander — Evolution",
      scoreLabel: "best score",
    });
    if (!quick) {
      ensureDirSync("docs/screenshots/lunar_lander");
      await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
      console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
    }
  }

  // Per-generation evolution telemetry: CSV (source of truth) plus a
  // best/avg fitness line chart rendered from the same rows. Both are
  // emitted on every full run so downstream tools and the README can
  // reuse the same data.
  if (evolutionRows.length > 0) {
    const csvText = formatEvolutionCsv(evolutionRows);
    const fitnessSamples: FitnessSample[] = evolutionRows.map((r) => ({
      generation: r.generation,
      bestFitness: r.bestFitness,
      avgFitness: r.avgFitness,
    }));
    const fitnessSvg = renderFitnessChartSVG(fitnessSamples, {
      title: "Lunar Lander — Fitness vs Generation",
      bestLabel: "best fitness",
      avgLabel: "avg fitness",
    });
    if (!quick) {
      ensureDirSync("docs/data/lunar_lander");
      await Deno.writeTextFile(EVOLUTION_CSV_PATH, csvText);
      console.log(`🗒️  Wrote evolution CSV ${EVOLUTION_CSV_PATH} (${evolutionRows.length} rows)`);

      ensureDirSync("docs/screenshots/lunar_lander");
      await Deno.writeTextFile(FITNESS_CHART_PATH, fitnessSvg);
      console.log(`📈 Wrote fitness chart ${FITNESS_CHART_PATH}`);
    }
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(snapshotsDir);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Lunar Lander — Evolution Progress",
      caption: {
        finalScore: result.bestScore,
        totalGenerations: result.generations,
        wallClockMs: Date.now() - evolutionStart,
      },
    });
    if (!quick) {
      await Deno.writeTextFile(EVOLUTION_PROGRESS_SVG_PATH, progressionSvg);
      console.log(
        `🧬 Wrote evolution-progression strip ${EVOLUTION_PROGRESS_SVG_PATH} ` +
          `(${snapshots.length} panels)`,
      );
    }
  }

  // Tidy the per-run snapshot temp dir if quick mode created one.
  if (quick && snapshotsDir !== SNAPSHOTS_DIR) {
    try {
      Deno.removeSync(snapshotsDir, { recursive: true });
    } catch (_err) {
      // Non-fatal — quick mode runs are best-effort about cleanup.
    }
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
