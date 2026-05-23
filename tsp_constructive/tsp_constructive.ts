/**
 * TSP Constructive Example.
 *
 * Evolves a NEAT-AI controller that builds a Travelling-Salesperson tour
 * one city at a time. At every step the agent observes the `K_NEAREST`
 * unvisited cities (relative to its current position) and emits a
 * softmax over those slots; the highest-scoring slot is committed and
 * the corresponding city is appended to the tour. Once every city has
 * been visited the closing edge back to the start city is added and the
 * fitness `optimum / tourLength` is reported back to evolution.
 *
 * The example covers two TSPLIB instances embedded in
 * `common/tsp_instances.ts`:
 *   - `burma14` (14 cities, published GEO optimum 3,323)
 *   - `ulysses22` (22 cities, published GEO optimum 7,013)
 *
 * 🌱 **Generation 1 starts from random noise.** The seed handed to
 * `Creature.evolveRL()` is a fresh `new Creature(INPUT_COUNT,
 * OUTPUT_COUNT)` — uniform-random direct input → output connections,
 * **no hand-crafted topology and no tuned weight init** (per
 * AGENTS.md).
 *
 * 📈 **Telemetry is milestone-only.** Per issue #298 NEAT-AI exposes
 * milestone-cadence statistics through `EvolveRLOptions.statistics =
 * true`. The runner captures the returned milestone array, persists it
 * via `common/multi_run_state.ts`, and renders the milestone-stats SVG
 * via `common/milestone_chart.ts`.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  EpisodeAdapter,
  type EvolveRLMilestone,
  type EvolveRLOptions,
  safeWriteJson,
  type StepResult,
} from "@stsoftware/neat-ai";

import { setupWorkingDirs } from "../common/working_dirs.ts";
import { type MilestoneSample, renderMilestoneChartSVG } from "../common/milestone_chart.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  type NewMultiRunSample,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import {
  boundingBoxDiagonal,
  loadInstance,
  nearestNeighbourTour,
  type TspCity,
  type TspInstance,
  type TspInstanceName,
} from "../common/tsp_instances.ts";

import {
  type Candidate,
  decodeAction,
  encodeObservation,
  INPUT_COUNT,
  kNearestUnvisited,
  OUTPUT_COUNT,
} from "./agent.ts";
import { geoTourLength, runConstructiveEpisode } from "./environment.ts";
import { renderTourSVG } from "./svg.ts";

/** Hard cap on episode length — at most `n` decision steps per episode. */
export const MAX_STEPS_BUFFER = 2;

/** Default population size for evolution. Small instances need a small pop. */
export const DEFAULT_POPULATION_SIZE = 60;

/** Default wall-clock cap (minutes) for a single evolution invocation. */
export const DEFAULT_TIMEOUT_MINUTES = 5;

/**
 * Default `targetError` for the evolveRL stop condition. The constructive
 * adapter emits a per-step reward derived from `optimum / length`, so
 * `targetError = 0.05` halts evolution once the champion tour is within
 * 5% of the published optimum.
 */
export const DEFAULT_TARGET_ERROR = 0.05;

/** Configuration for {@link evolveTspController}. */
export interface EvolveOptions {
  /** Random seed driving population initialisation and mutation. */
  seed: number;
  /** Population size for each generation. */
  populationSize: number;
  /** NEAT-AI standard target-error stop condition. */
  targetError: number;
  /** NEAT-AI standard wall-clock stop condition (integer ≥ 1). */
  timeoutMinutes: number;
  /** Optional generation cap (used by quick-mode + tests). */
  iterations?: number;
  /** TSPLIB instance to evolve against. Default `"burma14"`. */
  instanceName?: TspInstanceName;
  /**
   * Optional pre-seeded creature export, used by the multi-run resume
   * flow to continue evolution from a prior champion. When absent the
   * first generation starts from random noise (the fresh-run default).
   */
  seedCreatureExport?: CreatureExport;
}

/** Outcome of a single evolution run. */
export interface EvolveResult {
  /** Fittest controller produced by this run. */
  champion: Creature;
  /** Best fitness (`optimum / length`) achieved by the champion. */
  bestScore: number;
  /** Length of the champion tour in Euclidean units. */
  championLength: number;
  /** Champion tour in visit order (closed loop is implicit). */
  championTour: ReadonlyArray<number>;
  /** Number of generations the loop actually ran for. */
  generations: number;
  /** True when the champion's score met `1 - targetError`. */
  solved: boolean;
  /** Wall-clock duration of the evolution loop, in milliseconds. */
  wallclockMs: number;
  /** Why the loop terminated. */
  stopReason: "target" | "timeout" | "iterations";
  /** Milestone payloads collected via `statistics: true`. */
  milestones: MilestoneSample[];
}

/** Sensible defaults for the demonstration runner. */
export const DEFAULT_EVOLVE_OPTIONS: EvolveOptions = {
  seed: 13579,
  populationSize: DEFAULT_POPULATION_SIZE,
  targetError: DEFAULT_TARGET_ERROR,
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  instanceName: "burma14",
};

/** Slug used by the multi-run persistence helpers and artefact paths. */
export const EXAMPLE_SLUG = "tsp_constructive";

/** Path to the deterministic champion-tour SVG checked into docs. */
export const SCREENSHOT_PATH = "docs/screenshots/tsp_constructive.svg";

/** Path to the milestone-stats SVG checked into docs. */
export const MILESTONES_SVG_PATH = "docs/screenshots/tsp_constructive/milestones.svg";

/** Default `targetError` for a multi-run invocation (issue #322 cadence). */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = DEFAULT_TARGET_ERROR;

/** Default wall-clock budget for a single multi-run invocation, in minutes. */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = DEFAULT_TIMEOUT_MINUTES;

/** Per-episode adapter state — captured between steps. */
interface TspEpisodeState {
  /** Cities of the instance under evolution (frozen reference). */
  readonly cities: ReadonlyArray<TspCity>;
  /** Bounding-box diagonal — cached once per episode. */
  readonly diagonal: number;
  /** Visited flags indexed by city. */
  readonly visited: boolean[];
  /** Tour in visit order (start city first). */
  readonly tour: number[];
  /** Index of the city the agent is currently sitting on. */
  current: number;
  /** Previous-step displacement (un-normalised). Zero on step 1. */
  prevDx: number;
  prevDy: number;
  /** True once the closing edge has been added. */
  done: boolean;
}

/**
 * Episode adapter that drives a constructive TSP rollout. The adapter
 * is stateless across episodes — every call to {@link reset} returns a
 * brand-new `TspEpisodeState` initialised at city 0.
 */
export class TspConstructiveAdapter extends EpisodeAdapter<TspEpisodeState, number> {
  readonly instance: TspInstance;
  readonly diagonal: number;

  constructor(instance: TspInstance) {
    super();
    this.instance = instance;
    this.diagonal = boundingBoxDiagonal(instance.cities);
  }

  override get observationLength(): number {
    return INPUT_COUNT;
  }

  override maxSteps(): number {
    // One decision per non-start city. Add a buffer so the runner never
    // truncates a legitimate rollout.
    return this.instance.cities.length + MAX_STEPS_BUFFER;
  }

  override reset(
    _rngSeed: number,
  ): { observation: Float32Array; state: TspEpisodeState } {
    const cities = this.instance.cities;
    const visited = new Array<boolean>(cities.length).fill(false);
    const start = 0;
    visited[start] = true;
    const state: TspEpisodeState = {
      cities,
      diagonal: this.diagonal,
      visited,
      tour: [start],
      current: start,
      prevDx: 0,
      prevDy: 0,
      done: false,
    };
    const candidates: Candidate[] = kNearestUnvisited(cities, start, visited);
    const observation = encodeObservation(
      cities,
      start,
      candidates,
      [0, 0],
      this.diagonal,
    );
    return { observation, state };
  }

  override decodeAction(
    creatureOutput: Float32Array,
    state: TspEpisodeState,
  ): number {
    if (state.done) return 0;
    const candidates: Candidate[] = kNearestUnvisited(
      state.cities,
      state.current,
      state.visited,
    );
    if (candidates.length === 0) return 0;
    return decodeAction(creatureOutput, candidates);
  }

  override step(
    state: TspEpisodeState,
    action: number,
  ): StepResult<Float32Array> & { state: TspEpisodeState } {
    if (state.done) {
      // Defensive — runner should never call us past the terminal step.
      return {
        state,
        observation: new Float32Array(INPUT_COUNT),
        reward: 0,
        terminated: true,
        truncated: false,
      };
    }
    const candidates: Candidate[] = kNearestUnvisited(
      state.cities,
      state.current,
      state.visited,
    );
    if (candidates.length === 0) {
      // No moves left — shouldn't happen because we terminate when
      // `tour.length === n`.
      const closed = closeTour(state);
      return {
        state: closed,
        observation: new Float32Array(INPUT_COUNT),
        reward: terminalReward(state.cities, closed.tour, this.instance.optimum),
        terminated: true,
        truncated: false,
      };
    }
    const slot = action >= 0 && action < candidates.length ? action : 0;
    const next = candidates[slot].cityIndex;
    const dx = state.cities[next].x - state.cities[state.current].x;
    const dy = state.cities[next].y - state.cities[state.current].y;
    state.visited[next] = true;
    state.tour.push(next);
    state.current = next;
    state.prevDx = dx;
    state.prevDy = dy;

    const allVisited = state.tour.length === state.cities.length;
    if (allVisited) {
      const closed = closeTour(state);
      return {
        state: closed,
        observation: new Float32Array(INPUT_COUNT),
        reward: terminalReward(state.cities, closed.tour, this.instance.optimum),
        terminated: true,
        truncated: false,
      };
    }

    const nextCandidates = kNearestUnvisited(
      state.cities,
      state.current,
      state.visited,
    );
    const observation = encodeObservation(
      state.cities,
      state.current,
      nextCandidates,
      [dx, dy],
      this.diagonal,
    );
    return {
      state,
      observation,
      reward: 0,
      terminated: false,
      truncated: false,
    };
  }
}

function closeTour(state: TspEpisodeState): TspEpisodeState {
  state.done = true;
  return state;
}

/**
 * Terminal reward for a completed tour: `score - 1` where `score =
 * optimum / length` clipped to `[0, 1]`. NEAT-AI's
 * `defaultRewardToError` maps a `reward` in `[-1, 0]` to an `error`
 * in `[0, 1]`, so `error = 1 - score`. This keeps `targetError` and
 * `score` symmetric (`score >= 1 - targetError`).
 */
function terminalReward(
  cities: ReadonlyArray<TspCity>,
  tour: ReadonlyArray<number>,
  optimum: number,
): number {
  const length = geoTourLength(cities, tour);
  const score = length > 0 ? Math.min(1, optimum / length) : 0;
  return Math.max(-1, score - 1);
}

/** Convert a library milestone into the shared {@link MilestoneSample} shape. */
function toMilestoneSample(m: EvolveRLMilestone): MilestoneSample {
  return {
    generation: m.generation,
    bestScore: m.bestScore,
    bestNeurons: m.bestNeurons,
    bestSynapses: m.bestSynapses,
    meanEpisodeSteps: m.meanEpisodeSteps,
    generationWallClockMs: m.generationWallClockMs,
  };
}

/**
 * Convert a TSP milestone into the multi-run sample shape. The
 * adapter's `bestScore` lives in `[-1, 0]`, so `error = -bestScore`,
 * clamped defensively to `[0, 1]`.
 */
export function milestoneToMultiRunSample(m: EvolveRLMilestone): NewMultiRunSample {
  const error = Math.max(0, Math.min(1, -m.bestScore));
  return {
    runGen: m.generation,
    bestScore: m.bestScore,
    error,
    neurons: m.bestNeurons,
    synapses: m.bestSynapses,
    meanEpisodeSteps: m.meanEpisodeSteps,
    generationWallClockMs: m.generationWallClockMs,
  };
}

/**
 * Drive NEAT-AI's first-class reinforcement-learning evolution loop
 * against a {@link TspConstructiveAdapter}. Mutation, crossover,
 * elitism, plateau detection, and stop-condition handling are owned by
 * `Creature.evolveRL()` (the runtime that backs the conceptual
 * `Creature.evolveEnv()` event-driven API described in `AGENTS.md`).
 */
export async function evolveTspController(
  options: EvolveOptions = DEFAULT_EVOLVE_OPTIONS,
): Promise<EvolveResult> {
  const instanceName = options.instanceName ?? "burma14";
  const instance = loadInstance(instanceName);
  const adapter = new TspConstructiveAdapter(instance);

  // Fresh-run seed = uniform-random NEAT (no hand-crafted topology).
  const seedCreature = options.seedCreatureExport !== undefined
    ? Creature.fromJSON(options.seedCreatureExport)
    : new Creature(INPUT_COUNT, OUTPUT_COUNT);

  const absoluteTargetError = Math.max(0, options.targetError);
  const loopStart = Date.now();

  const evolveOptions: EvolveRLOptions = {
    seed: options.seed >>> 0,
    populationSize: options.populationSize,
    targetError: absoluteTargetError,
    timeoutMinutes: options.timeoutMinutes,
    iterations: options.iterations,
    // Deterministic environment (no per-trial perturbation) — one
    // episode per creature is sufficient.
    episodesPerCreature: 1,
    statistics: true,
  };

  const result = await seedCreature.evolveRL(adapter, evolveOptions);
  const wallclockMs = Date.now() - loopStart;
  const milestones: MilestoneSample[] = (result.milestones ?? []).map(toMilestoneSample);

  // Score the champion deterministically — sets `championTour` and
  // `championLength` exactly regardless of how evolveRL aggregated
  // rewards internally.
  const replay = runConstructiveEpisode(
    (input) => seedCreature.activate(input),
    instance.cities,
    instance.optimum,
    { diagonal: adapter.diagonal },
  );

  const targetScore = 1 - absoluteTargetError;
  const targetMet = replay.fitness >= targetScore;

  let stopReason: "target" | "timeout" | "iterations";
  if (targetMet) {
    stopReason = "target";
  } else if (
    options.iterations !== undefined && result.generation >= options.iterations
  ) {
    stopReason = "iterations";
  } else {
    stopReason = "timeout";
  }

  return {
    champion: seedCreature,
    bestScore: replay.fitness,
    championLength: replay.tourLength,
    championTour: replay.tour,
    generations: result.generation,
    solved: targetMet,
    wallclockMs,
    stopReason,
    milestones,
  };
}

/** Options accepted by {@link runMultiRunTsp}. */
export interface RunMultiRunTspOptions {
  /** Argv (defaults to `Deno.args`). */
  argv?: readonly string[];
  /** Base directory override for the multi-run persistence helpers. */
  baseDir?: string;
  /** Optional overrides applied to `DEFAULT_EVOLVE_OPTIONS`. */
  evolveOverrides?: Partial<EvolveOptions>;
  /** Override the instance parsed from argv (used by tests). */
  instanceName?: TspInstanceName;
}

/** Outcome of a single multi-run invocation. */
export interface MultiRunResult {
  evolveResult: EvolveResult;
  runIndex: number;
  lastCumulativeGen: number;
  totalMilestones: number;
  resumed: boolean;
  instanceName: TspInstanceName;
}

/** Recognised CLI instance flag. */
export function parseInstanceFlag(
  argv: readonly string[],
  fallback: TspInstanceName = "burma14",
): TspInstanceName {
  for (const arg of argv) {
    if (arg.startsWith("--instance=")) {
      const raw = arg.slice("--instance=".length);
      if (raw === "burma14" || raw === "ulysses22") return raw;
      throw new Error(
        `Unknown --instance value "${raw}" — expected "burma14" or "ulysses22"`,
      );
    }
  }
  return fallback;
}

/**
 * End-to-end multi-run wiring: parses flags, optionally wipes prior
 * state, loads any saved champion, evolves the controller, appends fresh
 * milestones to the merged history, and renders the milestone-stats SVG.
 */
export async function runMultiRunTsp(
  options: RunMultiRunTspOptions = {},
): Promise<MultiRunResult> {
  const argv = options.argv ?? Deno.args;
  const flags = parseMultiRunFlags(argv);
  const instanceName = options.instanceName ?? parseInstanceFlag(argv);
  const slug = `${EXAMPLE_SLUG}_${instanceName}`;

  if (flags.fresh) {
    await wipeMultiRunState(slug, options.baseDir);
  }

  const state = await loadMultiRunState(slug, options.baseDir);
  const resumed = state.creatureExport !== undefined;

  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  const evolveOptions: EvolveOptions = {
    ...DEFAULT_EVOLVE_OPTIONS,
    timeoutMinutes,
    targetError,
    instanceName,
    seedCreatureExport: state.creatureExport,
    ...options.evolveOverrides,
  };

  const evolveResult = await evolveTspController(evolveOptions);

  const newSamples: NewMultiRunSample[] = evolveResult.milestones.map((m) =>
    milestoneToMultiRunSample({
      generation: m.generation,
      bestScore: m.bestScore,
      bestNeurons: m.bestNeurons,
      bestSynapses: m.bestSynapses,
      meanEpisodeSteps: m.meanEpisodeSteps,
      generationWallClockMs: m.generationWallClockMs,
    })
  );

  await appendMultiRunRun(slug, {
    creatureExport: evolveResult.champion.exportJSON(),
    newSamples,
    runIndex: state.nextRunIndex,
    baseCumulativeGen: state.lastCumulativeGen,
  }, options.baseDir);

  const merged = await loadMultiRunState(slug, options.baseDir);

  if (merged.milestones.length > 0) {
    const base = options.baseDir ?? "docs";
    const screenshotsDir = join(base, "screenshots", slug);
    ensureDirSync(screenshotsDir);

    // Per-instance milestone-stats SVG, sourced from this run's
    // milestone array — the issue explicitly asks for
    // `common/milestone_chart.ts` here.
    const milestoneSamples: MilestoneSample[] = evolveResult.milestones;
    if (milestoneSamples.length > 0) {
      const svg = renderMilestoneChartSVG(milestoneSamples, {
        title: `TSP-constructive — ${instanceName} milestone stats`,
        caption: true,
        logX: true,
      });
      await Deno.writeTextFile(join(screenshotsDir, "milestones.svg"), svg);
    }
  }

  return {
    evolveResult,
    runIndex: state.nextRunIndex,
    lastCumulativeGen: merged.lastCumulativeGen,
    totalMilestones: merged.milestones.length,
    resumed,
    instanceName,
  };
}

/** Path to the deterministic champion-tour SVG for a given instance. */
export function tourScreenshotPath(instanceName: TspInstanceName): string {
  return `docs/screenshots/${EXAMPLE_SLUG}_${instanceName}.svg`;
}

if (import.meta.main) {
  const start = Date.now();

  console.log("📍 TSP Constructive Example (multi-run)");
  console.log("");

  // CI/quality quick mode keeps artefacts under a temp directory and
  // forces a tiny iterations cap.
  const quick = Deno.env.get("TSP_CONSTRUCTIVE_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "tsp_constructive_quick_" });
    console.log(
      "⚡ Quick mode (TSP_CONSTRUCTIVE_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

  const instanceName = parseInstanceFlag(Deno.args);
  const instance = loadInstance(instanceName);

  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
  }
  const timeoutMinutes = flags.timeoutMinutes ?? DEFAULT_MULTI_RUN_TIMEOUT_MINUTES;
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  console.log(
    `📦 Instance: ${instanceName} — ${instance.cities.length} cities, ` +
      `optimum=${instance.optimum}`,
  );
  console.log("🧬 Evolving controller via Creature.evolveRL() (the runtime behind evolveEnv())...");
  console.log(
    `   Stop conditions: targetError=${targetError} ` +
      `(score ≥ ${(1 - targetError).toFixed(3)}), ` +
      `timeoutMinutes=${timeoutMinutes}` +
      (quick ? ", iterations=3 (quick mode)" : ""),
  );

  const { creaturesDir, outputDir } = setupWorkingDirs(".synthetic-tsp-constructive");

  const multi = await runMultiRunTsp({
    baseDir: quickBaseDir,
    evolveOverrides: quick ? { iterations: 3 } : undefined,
  });
  const { evolveResult: result } = multi;

  if (multi.resumed) {
    console.log(`🔁 Resumed from prior champion (run ${multi.runIndex}).`);
  } else {
    console.log(`🌱 Fresh start — run ${multi.runIndex} begins from random noise.`);
  }

  const verdictIcon = result.solved ? "✅" : "⚠️";
  console.log(
    `\n${verdictIcon} Champion tour length ${result.championLength.toFixed(2)} ` +
      `(score=${result.bestScore.toFixed(3)}, optimum=${instance.optimum}, ` +
      `generations=${result.generations}, stop=${result.stopReason}, ` +
      `wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Working-directory copy of the champion for ad-hoc inspection.
  const championPath = join(creaturesDir, `${instanceName}-champion.json`);
  await safeWriteJson(championPath, result.champion.exportJSON());
  console.log(`💾 Saved champion to ${championPath}`);

  // Trajectory log so subsequent runs can rebuild the SVG without
  // re-evolving.
  const trajectoryPath = join(outputDir, `${instanceName}-tour.json`);
  const trajectoryLog = {
    instance: instanceName,
    tour: result.championTour,
    tourLength: result.championLength,
    optimum: instance.optimum,
    score: result.bestScore,
  };
  await Deno.writeTextFile(trajectoryPath, JSON.stringify(trajectoryLog, null, 2));
  console.log(`📜 Saved tour log to ${trajectoryPath}`);

  // Deterministic SVG of the champion tour. Quick mode keeps this under
  // the temp directory so the canonical docs screenshot is preserved.
  const referenceTour = nearestNeighbourTour(instance.cities, 0);
  const svg = renderTourSVG({
    instanceName,
    cities: instance.cities,
    tour: result.championTour,
    tourLength: result.championLength,
    optimum: instance.optimum,
    optimalTour: referenceTour,
  });
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(
      join(tmpScreenshots, `tsp_constructive_${instanceName}.svg`),
      svg,
    );
    console.log("⏭️  Quick mode: skipped overwriting canonical screenshot");
  } else {
    ensureDirSync("docs/screenshots");
    const target = tourScreenshotPath(instanceName);
    await Deno.writeTextFile(target, svg);
    console.log(`🖼️  Wrote screenshot ${target}`);
  }

  console.log(
    `📈 Milestone chart updated under ${
      quick ? quickBaseDir : "docs"
    }/screenshots/${EXAMPLE_SLUG}_${instanceName}/milestones.svg — ` +
      `${multi.totalMilestones} cumulative milestones across ${multi.runIndex} run(s).`,
  );

  if (quick && quickBaseDir !== undefined) {
    try {
      await Deno.remove(quickBaseDir, { recursive: true });
    } catch {
      // Tolerable — temp dir cleanup is best-effort.
    }
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
