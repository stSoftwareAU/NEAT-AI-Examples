/**
 * Cart-Pole Balancing Example
 *
 * Evolves a NEAT-AI creature to balance an inverted pole on a moving
 * cart — the classic neuroevolution control benchmark. The simulator
 * (see `physics.ts`) and the evolutionary loop run entirely in pure
 * TypeScript; the only external dependency is NEAT-AI's
 * `Creature.activate` to compute each step's action.
 *
 * Inputs (per timestep): `[x, v, theta, omega]`.
 * Output: a single scalar in `[-1, 1]` (HARD_TANH default). When
 * `>= 0` the controller pushes right, otherwise left.
 * Score: the **mean** number of timesteps the pole stays upright across
 * a fixed batch of perturbed-start trials, capped at `MAX_STEPS` per
 * trial. The task is "solved" when the mean reaches `SOLVED_THRESHOLD`.
 *
 * 🌱 **Generation 1 starts from random noise.** The initial population
 * is built by the NEAT-AI library from uniform-random weights and biases
 * — no hand-crafted topology, no tuned weight init. Structural mutation
 * (weight perturbation, bias perturbation, and add-neuron splits)
 * discovers the controller from there.
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
import {
  type CartPoleState,
  encodeState,
  initialState,
  isFailed,
  perturbedInitialState,
  step,
} from "./physics.ts";
import { renderRunSVG } from "./svg.ts";

/** Number of input observables (`x`, `v`, `theta`, `omega`). */
export const INPUT_COUNT = 4;

/** Number of output channels (the action scalar). */
export const OUTPUT_COUNT = 1;

/** Maximum number of timesteps a single episode is allowed to run. */
export const MAX_STEPS = 500;

/**
 * Score threshold (mean steps across the perturbed-start trial suite)
 * at or above which the controller is declared "solved". 480 of 500
 * means the controller balances for at least 96% of the time on average
 * — a high bar that still tolerates the occasional unlucky start.
 */
export const SOLVED_THRESHOLD = 480;

/** Configuration options for {@link evolveCartPoleController}. */
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
   * symmetric launch). See {@link ScoreOptions}.
   */
  trials?: number;
  /**
   * Half-width of the uniform `[-m, +m]` perturbation applied to each
   * component of the initial state. Defaults to `0`, i.e. every trial
   * starts from the perfectly symmetric `(0, 0, 0, 0)` state.
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
   * Half-width of the uniform `[-m, +m]` perturbation applied to each
   * component of every trial's initial state. Default 0 (no
   * perturbation — every trial starts from the symmetric zero state).
   */
  initialPerturbation?: number;
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
  /** Best score reached by the champion (mean across trials). */
  bestScore: number;
  /** Number of generations run before stopping. */
  generations: number;
  /** True when the champion's mean reached {@link SOLVED_THRESHOLD}. */
  solved: boolean;
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 12345,
  populationSize: 60,
  maxGenerations: 400,
  mutationStrength: 0.6,
  mutationRate: 0.5,
  addNeuronRate: 0.03,
  // Issue #143 — score every candidate against ten different perturbed
  // starts (the same ten for every member, every generation) so the
  // search cannot "win" by getting lucky on a single symmetric launch.
  // The 0.1 half-width gives initial pole tilts up to ~5.7°, well below
  // the 12° failure threshold yet enough that random initial creatures
  // rarely balance every trial in the very first generation.
  trials: 10,
  initialPerturbation: 0.1,
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

  // The library assigns runtime indices in array order, so hidden
  // neurons must precede output neurons to keep the topology forward-
  // only. Inserting the new hidden neuron before the first output
  // preserves the `from < to` invariant the library asserts on load.
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
 * Build a cart-pole {@link EpisodeAdapter} for the shared rollout helper.
 *
 * The library's default output squash is HARD_TANH (range `[-1, 1]`), so
 * the natural threshold for "push right" is 0. This stays sensible even
 * after structural mutation injects a LOGISTIC hidden layer because the
 * **output** neuron's squash is unchanged.
 */
function cartPoleAdapter(start: CartPoleState): EpisodeAdapter<CartPoleState, 1 | -1> {
  return {
    initialState: start,
    encode: encodeState,
    decode: (out) => (out[0] >= 0 ? 1 : -1),
    step: (s, a) => step(s, a),
    isTerminal: isFailed,
  };
}

/**
 * Score a creature by running the cart-pole simulator. By default the
 * controller is evaluated once from the symmetric `(0, 0, 0, 0)` start.
 * Pass `options.trials > 1` together with `options.initialPerturbation > 0`
 * to evaluate the controller across several perturbed initial states
 * and return the **mean** survival count — the honest variant used by
 * the evolver.
 *
 * Because the mean of trials capped at `maxSteps` equals `maxSteps` only
 * when every trial reached the cap, a multi-trial score of `MAX_STEPS`
 * proves the controller solved the task on every initial state in the
 * batch — not just one lucky symmetric launch (issue #143).
 */
export function scoreController(
  creature: Creature,
  maxSteps: number = MAX_STEPS,
  options?: ScoreOptions,
): number {
  const trials = options?.trials ?? 1;
  const perturbation = options?.initialPerturbation ?? 0;

  if (trials <= 1 && perturbation === 0) {
    return runEpisode(creature, cartPoleAdapter(initialState()), { maxSteps }).steps;
  }

  const random = createDeterministicRandom(options?.trialSeed ?? 0);
  let total = 0;
  for (let t = 0; t < trials; t++) {
    const start = perturbation > 0 ? perturbedInitialState(random, perturbation) : initialState();
    total += runEpisode(creature, cartPoleAdapter(start), { maxSteps }).steps;
  }
  return total / trials;
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
  return runEpisode(creature, cartPoleAdapter(initialState()), { maxSteps }).trace;
}

interface ScoredMember {
  json: CreatureExport;
  score: number;
  neurons: number;
  synapses: number;
}

function topologyCounts(json: CreatureExport): { neurons: number; synapses: number } {
  // The export omits input neurons (they are implicit in `input`), so we
  // add them back to report a comparable "total neurons" figure.
  return {
    neurons: json.neurons.length + (json.input ?? INPUT_COUNT),
    synapses: json.synapses.length,
  };
}

/**
 * Run a generational evolutionary algorithm over creature genomes. The
 * top half of each generation seeds the next via mutation; the elite is
 * carried over unchanged so the best score is monotonically
 * non-decreasing. Stops as soon as the champion's score reaches
 * {@link SOLVED_THRESHOLD} or `maxGenerations` is exhausted (whichever
 * comes first) — the **hard generation cap** is the second guarantee.
 */
export function evolveCartPoleController(
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
  // No hand-crafted topology — `new Creature(input, output)` decides the
  // initial structure, with random weights and a random output bias.
  const initialExports = buildRandomPopulation(options.seed, options.populationSize);
  let population: ScoredMember[] = initialExports.map((json) => {
    const creature = Creature.fromJSON(json);
    const counts = topologyCounts(json);
    return { json, score: score(creature), neurons: counts.neurons, synapses: counts.synapses };
  });

  let bestJSON = population[0].json;
  let bestScore = -Infinity;
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

    if (bestScore >= SOLVED_THRESHOLD) {
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
      const counts = topologyCounts(childJSON);
      nextPopulation.push({
        json: childJSON,
        score: score(childCreature),
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
    generations: solvedAt >= 0 ? solvedAt + 1 : options.maxGenerations,
    solved: bestScore >= SOLVED_THRESHOLD,
  };
}

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/cart_pole.svg";

/** Number of evenly-spaced keyframes sampled for the SMIL-animated SVG. */
export const SVG_FRAME_COUNT = 60;

/**
 * Generations at which the runner captures evolution snapshots. The
 * cadence is extended past the previous `[1, 10, 100, 500]` because
 * variable-topology evolution from uniform-random noise typically
 * needs more generations to converge than the old fixed-topology
 * search did.
 */
export const EVOLUTION_CHECKPOINTS: number[] = [1, 10, 100, 500, 1000];

/** Hidden directory under which snapshot files are written. */
export const SNAPSHOTS_DIR = ".synthetic-cart-pole/snapshots";

/** Path to the multi-panel evolution-progression SVG the runner emits. */
export const EVOLUTION_PROGRESS_SVG_PATH = "docs/screenshots/cart_pole_evolution.svg";

/** Path to the per-generation evolution-chart SVG the runner emits. */
export const EVOLUTION_CHART_PATH = "docs/screenshots/cart_pole_evolution_chart.svg";

if (import.meta.main) {
  const start = Date.now();

  console.log("🎢 Cart-Pole Balancing Example");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-cart-pole");

  console.log("🧪 Sanity check: hand-crafted tilt-direction policy");
  const sanityScore = scoreTiltDirectionPolicy();
  console.log(`   Hand-crafted policy survived ${sanityScore} steps.`);

  console.log("\n🧬 Evolving controller from uniform-random NEAT noise...");
  ensureDirSync(SNAPSHOTS_DIR);
  for (const entry of Deno.readDirSync(SNAPSHOTS_DIR)) {
    if (entry.isFile) Deno.removeSync(join(SNAPSHOTS_DIR, entry.name));
  }
  const evolutionSamples: EvolutionSample[] = [];
  const evolutionStart = Date.now();
  const result = evolveCartPoleController({
    ...DEFAULT_EVOLVE_OPTIONS,
    snapshotConfig: {
      checkpoints: [...EVOLUTION_CHECKPOINTS],
      outputDir: SNAPSHOTS_DIR,
    },
    onGeneration: ({ generation, bestScore, meanScore, neurons, synapses }) => {
      evolutionSamples.push({ generation, score: bestScore, neurons, synapses });
      if (generation % 5 === 0 || bestScore >= SOLVED_THRESHOLD) {
        console.log(
          `   Gen ${generation.toString().padStart(3)}  best=${
            bestScore.toFixed(1).padStart(6)
          }  mean=${meanScore.toFixed(1).padStart(6)}  ` +
            `neurons=${neurons}  synapses=${synapses}`,
        );
      }
    },
  });

  console.log(
    `\n${result.solved ? "✅ Solved" : "⚠️  Did not solve"} ` +
      `after ${result.generations} generations (best=${result.bestScore.toFixed(1)}, ` +
      `threshold=${SOLVED_THRESHOLD}).`,
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

  // Render the per-generation evolution chart (score / neurons / synapses).
  if (evolutionSamples.length > 0) {
    const evolutionSvg = renderEvolutionChartSVG(evolutionSamples, {
      title: "Cart-Pole — Evolution",
      scoreLabel: "best score",
    });
    await Deno.writeTextFile(EVOLUTION_CHART_PATH, evolutionSvg);
    console.log(`📈 Wrote evolution chart ${EVOLUTION_CHART_PATH}`);
  }

  // Render the multi-panel evolution-progression strip from the
  // checkpoint snapshots captured during the run.
  const snapshots = loadSnapshots(SNAPSHOTS_DIR);
  if (snapshots.length > 0) {
    const progressionSvg = renderEvolutionProgressSvg(snapshots, {
      title: "Cart-Pole — Evolution Progress",
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
