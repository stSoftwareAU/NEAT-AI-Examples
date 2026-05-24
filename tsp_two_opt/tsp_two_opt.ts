/**
 * tsp_two_opt — evolve a 2-opt move selector on a nearest-neighbour seed
 * tour.
 *
 * This is a "memetic" framing of NEAT-AI as a learned **local-search
 * heuristic**: every episode starts from the deterministic
 * nearest-neighbour tour for the chosen TSPLIB instance (see
 * `common/tsp_instances.ts`) and the evolved controller proposes up to
 * {@link DEFAULT_PROPOSAL_BUDGET} 2-opt swaps to improve it. Accepted
 * swaps are applied in place; the post-budget improvement-over-NN ratio
 * is the fitness signal handed to NEAT-AI.
 *
 * Paradigm `🛠 technique` — the NEAT seed itself is uniform-random via
 * `new Creature(INPUT_COUNT, OUTPUT_COUNT)`. The hand-crafted
 * nearest-neighbour starting tour is the exempt "warm" piece (cf.
 * `crispr_injection`'s gene exemption in `AGENTS.md`).
 *
 * Evolution loop runs through `Creature.evolveEnv()` with a tiny
 * {@link LegacyEpisodeAdapter}: `reset` returns the seed tour state,
 * `observe` projects edge statistics via {@link encodeObservation},
 * `decode` picks a 2-opt swap via {@link decodeProposal}, and `step`
 * applies the swap and emits a per-step delta reward so the cumulative
 * episode reward is exactly the improvement-over-NN ratio in `[0, 1]`.
 *
 * Australian English throughout.
 */
import { format } from "@std/fmt/duration";
import { parseArgs } from "@std/cli/parse-args";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import {
  loadInstance,
  nearestNeighbourTour,
  tourLength,
  type TspCity,
  type TspInstance,
  type TspInstanceName,
} from "../common/tsp_instances.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import {
  appendMultiRunRun,
  loadMultiRunState,
  parseMultiRunFlags,
  wipeMultiRunState,
} from "../common/multi_run_state.ts";
import {
  decodeProposal,
  edgeLengths,
  encodeObservation,
  INPUT_COUNT,
  longestEdgeIndices,
  OUTPUT_COUNT,
} from "./agent.ts";
import {
  applyTwoOptSwap,
  DEFAULT_PROPOSAL_BUDGET,
  runEpisode,
  twoOptDelta,
} from "./environment.ts";
import { renderSideBySideTours } from "./svg.ts";

// Re-export the action / observation shape so downstream consumers can
// reach a single import surface.
export { INPUT_COUNT, K_LONGEST, OUTPUT_COUNT } from "./agent.ts";

/** Default options passed to {@link evolveTwoOptController}. */
export interface EvolveOptions {
  /** Instance to evolve against. */
  instance: TspInstance;
  /** Random seed passed to NEAT-AI. */
  seed: number;
  /** Population size. */
  populationSize: number;
  /** Target error (NEAT-AI standard stop condition; `0` = perfect). */
  targetError: number;
  /** Wall-clock budget in minutes (NEAT-AI standard backstop). */
  timeoutMinutes: number;
  /** Optional generation cap for fast unit tests. */
  iterations?: number;
  /** Number of 2-opt swap proposals per episode. */
  proposalBudget: number;
  /** Pre-seeded champion to resume from (multi-run flow). */
  seedCreatureExport?: CreatureExport;
}

/** Result of the evolutionary search. */
export interface EvolveResult {
  champion: Creature;
  /** Library-reported error from `evolveEnv`. */
  error: number;
  /** Library-reported score from `evolveEnv`. */
  score: number;
  /** Number of generations actually run. */
  generations: number;
  /** Wall-clock duration of the evolution loop in milliseconds. */
  wallclockMs: number;
}

/** Sensible defaults for direct (non-quick) runs. */
export const DEFAULT_EVOLVE_OPTIONS: Omit<EvolveOptions, "instance"> = {
  seed: 12345,
  populationSize: 40,
  // 0.05 of normalised error == champion closed at least 95% of the gap
  // between the nearest-neighbour seed and the published optimum.
  targetError: 0.05,
  timeoutMinutes: 5,
  proposalBudget: DEFAULT_PROPOSAL_BUDGET,
};

/**
 * Number of hidden neurons per layer in the seed creature. The
 * constructor accepts `layers: { count, squash }[]`; we hand-pick a
 * small two-layer stack with tanh / logistic activations so the
 * uniform-random seed has somewhere to plant features without being
 * burdened by an oversized initial topology.
 */
export const SEED_HIDDEN_LAYERS: ReadonlyArray<{ count: number; squash: string }> = [
  { count: 16, squash: "TANH" },
  { count: 12, squash: "LOGISTIC" },
];

/**
 * Build a fresh seed creature. When `seedCreatureExport` is supplied
 * (multi-run resume) the prior champion is re-hydrated via
 * {@link Creature.fromJSON} instead.
 */
export function buildSeedCreature(seedCreatureExport?: CreatureExport): Creature {
  if (seedCreatureExport !== undefined) {
    return Creature.fromJSON(seedCreatureExport);
  }
  // `layers` produces uniform-random weights for each hidden layer; the
  // overall creature is still random-noise per AGENTS.md (no hand-picked
  // weights, no hand-crafted topology beyond the stack of hidden layers
  // the issue explicitly requests via the Creature constructor).
  return new Creature(INPUT_COUNT, OUTPUT_COUNT, {
    layers: SEED_HIDDEN_LAYERS.slice(),
  });
}

/** State threaded through each `evolveEnv` episode. */
interface TwoOptEpisodeState {
  cities: ReadonlyArray<TspCity>;
  tour: number[];
  seedLength: number;
  optimum: number;
  proposalsLeft: number;
  proposalBudget: number;
  cumulativeReward: number;
}

/**
 * Build a {@link LegacyEpisodeAdapter} that runs one 2-opt improvement
 * episode against the supplied instance. The cumulative reward across
 * the episode is the improvement-over-NN ratio (in `[0, 1]`), so
 * `defaultRewardToError` makes the error `0` when the controller
 * matches the optimum exactly and `1` when it makes no progress.
 */
export function buildEpisodicAdapter(
  instance: TspInstance,
  proposalBudget: number,
) {
  const seedTour = nearestNeighbourTour(instance.cities, 0);
  const seedLength = tourLength(instance.cities, seedTour);
  const denom = Math.max(1e-9, seedLength);

  // Cumulative episode reward equals the fractional improvement over
  // the nearest-neighbour seed in Euclidean space — see
  // environment.ts. Per-step reward is `-delta / seedLength` so the
  // running total stays bounded in `[0, 1]`.
  return {
    inputCount: INPUT_COUNT,
    outputCount: OUTPUT_COUNT,
    maxSteps: proposalBudget,

    reset(_seed?: number): TwoOptEpisodeState {
      return {
        cities: instance.cities,
        tour: seedTour.slice(),
        seedLength,
        optimum: instance.optimum,
        proposalsLeft: proposalBudget,
        proposalBudget,
        cumulativeReward: 0,
      };
    },

    observe(state: TwoOptEpisodeState): Float32Array {
      return encodeObservation(
        state.cities,
        state.tour,
        state.proposalsLeft,
        state.proposalBudget,
      );
    },

    decode(output: Float32Array): Float32Array {
      // The decode contract does not have access to the current tour, so
      // we cannot pick the "current longest" here; `step` re-derives it
      // and applies the proposal. Returning the raw output keeps the
      // action shape narrow.
      return output;
    },

    step(
      state: TwoOptEpisodeState,
      action: Float32Array,
    ): { state: TwoOptEpisodeState; reward: number; done: boolean } {
      const lengths = edgeLengths(state.cities, state.tour);
      const sortedLongest = longestEdgeIndices(lengths);
      const proposal = decodeProposal(action, sortedLongest);
      let reward = 0;
      if (!proposal.noop) {
        const delta = twoOptDelta(state.cities, state.tour, proposal.i, proposal.j);
        if (delta < 0) {
          applyTwoOptSwap(state.tour, proposal.i, proposal.j);
          reward = -delta / denom;
        }
      }
      const nextProposalsLeft = state.proposalsLeft - 1;
      const done = nextProposalsLeft <= 0;
      const nextState: TwoOptEpisodeState = {
        ...state,
        tour: state.tour,
        proposalsLeft: nextProposalsLeft,
        cumulativeReward: state.cumulativeReward + reward,
      };
      return { state: nextState, reward, done };
    },
  };
}

/**
 * Run `Creature.evolveEnv()` against a fresh adapter. The fitness signal
 * is the per-episode improvement-over-NN ratio (mapped to error via
 * `defaultRewardToError`, i.e. `error = max(0, -reward)`; since reward
 * is non-negative, error is `0` once the optimum is reached).
 */
export async function evolveTwoOptController(
  options: EvolveOptions,
): Promise<EvolveResult> {
  const seedCreature = buildSeedCreature(options.seedCreatureExport);
  const adapter = buildEpisodicAdapter(options.instance, options.proposalBudget);

  const loopStart = Date.now();
  // evolveEnv mixes NeatOptions and EpisodicOptions; both are forwarded
  // to the runner. We use the default rewardToError (`max(0, -reward)`).
  const result = await seedCreature.evolveEnv(adapter, {
    populationSize: options.populationSize,
    iterations: options.iterations,
    timeoutMinutes: options.timeoutMinutes,
    targetError: Math.max(0, options.targetError),
    seed: options.seed >>> 0,
    // Single-trial scoring — the environment is fully deterministic.
    trialsPerScore: 1,
    // The cumulative episode reward sits in `[0, 1]` (improvement-over-NN
    // ratio). Map to a non-negative error of `1 - reward` so a perfect
    // run yields error = 0 and a no-progress run yields error = 1.
    rewardToError: (cumulative: number) => {
      const clamped = Math.max(0, Math.min(1, cumulative));
      return 1 - clamped;
    },
  });

  const wallclockMs = Date.now() - loopStart;

  return {
    champion: seedCreature,
    error: result.error,
    score: result.score,
    generations: result.generation,
    wallclockMs,
  };
}

/** Slug used by the multi-run persistence helpers and chart artefact paths. */
export const EXAMPLE_SLUG = "tsp_two_opt";

/** Path to the side-by-side SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/tsp_two_opt.svg";

/** Default `targetError` for a multi-run invocation. */
export const DEFAULT_MULTI_RUN_TARGET_ERROR = 0.05;

/** Default wall-clock budget for a single multi-run invocation. */
export const DEFAULT_MULTI_RUN_TIMEOUT_MINUTES = 5;

/** Parse the `--instance` CLI flag (defaults to `burma14`). */
export function parseInstanceFlag(argv: readonly string[]): TspInstanceName {
  const args = parseArgs(argv as string[], {
    string: ["instance"],
    default: { instance: "burma14" },
  });
  const value = String(args.instance);
  if (value !== "burma14" && value !== "ulysses22" && value !== "pcb442") {
    throw new Error(
      `Unknown --instance=${value}; valid options are burma14|ulysses22|pcb442`,
    );
  }
  return value;
}

/**
 * Parse the `--time-seconds=<N>` CLI flag. Returns `undefined` when the
 * flag is absent so callers can fall back to `--timeout=<minutes>` or the
 * documented default. A non-integer or non-positive value throws.
 *
 * The flag is the bounded "smoke mode" budget — `quality.sh` passes a
 * sub-minute value so CI can exercise the harness in seconds rather than
 * waiting on a multi-hour run.
 */
export function parseTimeSecondsFlag(argv: readonly string[]): number | undefined {
  const args = parseArgs(argv as string[], {
    string: ["time-seconds"],
  });
  const raw = args["time-seconds"];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid --time-seconds=${raw}; expected a positive number of seconds`,
    );
  }
  return value;
}

/**
 * Resolve the effective wall-clock budget in minutes from the CLI flags.
 *
 * Precedence (smoke beats human run):
 * 1. `--time-seconds=<N>` — converted via `N / 60`.
 * 2. `--timeout=<minutes>` (forwarded from {@link parseMultiRunFlags}).
 * 3. Documented {@link DEFAULT_MULTI_RUN_TIMEOUT_MINUTES} default.
 */
export function resolveTimeoutMinutes(
  argv: readonly string[],
  timeoutMinutesFromFlags: number | undefined,
  defaultMinutes: number = DEFAULT_MULTI_RUN_TIMEOUT_MINUTES,
): number {
  const seconds = parseTimeSecondsFlag(argv);
  if (seconds !== undefined) return seconds / 60;
  if (timeoutMinutesFromFlags !== undefined) return timeoutMinutesFromFlags;
  return defaultMinutes;
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧭 tsp_two_opt — learned 2-opt local-search heuristic");
  console.log("");

  const { creaturesDir } = setupWorkingDirs(".synthetic-tsp-two-opt");
  const instanceName = parseInstanceFlag(Deno.args);
  const instance = loadInstance(instanceName);

  const quick = Deno.env.get("TSP_TWO_OPT_QUICK") === "1";
  let quickBaseDir: string | undefined;
  if (quick) {
    quickBaseDir = await Deno.makeTempDir({ prefix: "tsp_two_opt_quick_" });
    console.log(
      "⚡ Quick mode (TSP_TWO_OPT_QUICK=1): tiny iterations cap, ephemeral artefacts " +
        `under ${quickBaseDir}`,
    );
  }

  const flags = parseMultiRunFlags(Deno.args);
  if (flags.fresh) {
    console.log("🧹 --fresh: wiping prior multi-run state.");
    await wipeMultiRunState(EXAMPLE_SLUG, quickBaseDir);
  }

  const persisted = await loadMultiRunState(EXAMPLE_SLUG, quickBaseDir);
  const resumed = persisted.creatureExport !== undefined;

  const timeoutMinutes = resolveTimeoutMinutes(Deno.args, flags.timeoutMinutes);
  const targetError = flags.targetError ?? DEFAULT_MULTI_RUN_TARGET_ERROR;

  console.log(
    `📍 Instance: ${instance.name} (${instance.cities.length} cities, ` +
      `optimum ${instance.optimum})`,
  );
  console.log(
    `🧬 Evolving controller via Creature.evolveEnv() — ` +
      `targetError=${targetError.toFixed(3)}, timeoutMinutes=${timeoutMinutes}` +
      (quick ? ", iterations=2 (quick mode)" : ""),
  );

  const evolveOptions: EvolveOptions = {
    instance,
    ...DEFAULT_EVOLVE_OPTIONS,
    timeoutMinutes,
    targetError,
    iterations: quick ? 2 : DEFAULT_EVOLVE_OPTIONS.iterations,
    seedCreatureExport: persisted.creatureExport,
  };

  const result = await evolveTwoOptController(evolveOptions);

  if (resumed) {
    console.log(`🔁 Resumed from prior champion (run ${persisted.nextRunIndex}).`);
  } else {
    console.log(`🌱 Fresh start — run ${persisted.nextRunIndex} begins from random noise.`);
  }

  // Replay the champion on the deterministic instance so we can report
  // the achieved improvement ratio and render the side-by-side SVG.
  const replay = runEpisode(result.champion, instance, {
    proposalBudget: evolveOptions.proposalBudget,
    recordFrames: false,
  });

  console.log(
    `\n✅ Champion ratio=${(replay.improvementRatio * 100).toFixed(1)}% ` +
      `(seed length ${replay.seedLength.toFixed(2)}, ` +
      `final length ${replay.finalLength.toFixed(2)}, ` +
      `optimum ${replay.optimum}, accepted ${replay.proposalsAccepted}/${replay.proposalsIssued}, ` +
      `wallclock=${(result.wallclockMs / 1000).toFixed(1)}s).`,
  );

  // Save the champion and update multi-run persistence.
  const championPath = join(creaturesDir, "champion.json");
  const championExport: CreatureExport = result.champion.exportJSON();
  await safeWriteJson(championPath, championExport);
  console.log(`💾 Saved champion to ${championPath}`);

  await appendMultiRunRun(EXAMPLE_SLUG, {
    creatureExport: championExport,
    // evolveEnv does not emit milestone payloads; we record nothing
    // here, but the champion is still persisted so subsequent runs
    // resume from this state.
    newSamples: [],
    runIndex: persisted.nextRunIndex,
    baseCumulativeGen: persisted.lastCumulativeGen,
  }, quickBaseDir);

  // Render the side-by-side SVG (seed vs improved tour).
  const svg = renderSideBySideTours({
    cities: instance.cities,
    left: {
      title: "Nearest-neighbour seed",
      tour: replay.seedTour,
      length: replay.seedLength,
    },
    right: {
      title: "Post-evolution improved",
      tour: replay.finalTour,
      length: replay.finalLength,
    },
    optimum: instance.optimum,
    instanceName: instance.name,
    proposalBudget: evolveOptions.proposalBudget,
  });
  if (quick && quickBaseDir !== undefined) {
    const tmpScreenshots = join(quickBaseDir, "screenshots");
    ensureDirSync(tmpScreenshots);
    await Deno.writeTextFile(join(tmpScreenshots, "tsp_two_opt.svg"), svg);
    console.log("⏭️  Quick mode: skipped overwriting canonical screenshot");
  } else {
    ensureDirSync("docs/screenshots");
    await Deno.writeTextFile(SCREENSHOT_PATH, svg);
    console.log(`🖼️  Wrote screenshot ${SCREENSHOT_PATH}`);
  }

  if (quick && quickBaseDir !== undefined) {
    try {
      await Deno.remove(quickBaseDir, { recursive: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
