/**
 * tsp_two_opt hybrid orchestrator (issue #482).
 *
 * Wires the three NEAT-AI hybrid (non-pure-NEAT) techniques on top of
 * the learned 2-opt local search for the `pcb442` instance:
 *
 *   1. **Memetic re-seed** — chunk `N+1` starts from chunk `N`'s
 *      exported champion (mirrors `memetic_evolution/memetic_evolution.ts`
 *      — two chained `evolve*` calls).
 *   2. **CRISPR splice**  — when chunk `N` produces no improvement over
 *      the previous chunk (stalled), the champion is spliced with a
 *      hand-crafted edit gene before chunk `N+1` begins. The splicer
 *      delegates to `injectGene` from `crispr_injection/` so the
 *      gene-splicing primitive is reused, not re-implemented.
 *   3. **MH acceptance**  — chunks from chunk 2 onwards run with the
 *      Metropolis-Hastings accept rule so swaps that slightly worsen
 *      the tour can still be accepted with probability
 *      `exp(-delta / (T · seedLength))`. At `T → 0` the rule degenerates
 *      to strict-improvement.
 *
 * The hand-crafted edit gene is the example's exempt warm-start piece —
 * consistent with `crispr_injection`'s gene exemption (AGENTS.md). The
 * MH rule is opt-in (`pcb442` only); `burma14` and `ulysses22` still
 * run the original strict-improvement loop and their CLI output is
 * unchanged.
 *
 * Australian English throughout.
 */
import { Creature, type CreatureExport } from "@stsoftware/neat-ai";
import { type TspInstance } from "../common/tsp_instances.ts";
import {
  asCreatureExport,
  type LegacyCreatureJSON,
  type LegacyNeuron,
  type LegacySynapse,
} from "../common/legacy_types.ts";
import { type InjectedGene, injectGene } from "../crispr_injection/crispr_injection.ts";
import { type EvolveResult, evolveTwoOptController } from "./tsp_two_opt.ts";
import { DEFAULT_PROPOSAL_BUDGET, runEpisode, type TwoOptAcceptanceMode } from "./environment.ts";

/**
 * Console-log markers for each hybrid technique. The smoke harness
 * (and the issue's acceptance criteria) greps for these substrings to
 * confirm every code path was reached.
 */
export const HYBRID_LOG_MARKERS = Object.freeze({
  memetic: "🧠 memetic re-seed",
  crispr: "🧬 CRISPR splice",
  mh: "🌡️ MH accept",
});

/** Stable UUIDs for the tsp_two_opt edit gene's two TANH hidden neurons. */
export const TSP_GENE_NEURON_UUIDS = Object.freeze(
  [
    "tsp-edit-gene-h0",
    "tsp-edit-gene-h1",
  ] as const,
);

/** Configuration for {@link runHybridEvolution}. */
export interface HybridOptions {
  /** TSP instance under evolution (intended for `pcb442`). */
  instance: TspInstance;
  /** Total wall-clock budget in minutes, split evenly across chunks. */
  totalTimeMinutes: number;
  /** Number of evolveEnv chunks to run. Minimum 2 (memetic needs >=2). */
  chunks?: number;
  /** Population size per chunk. */
  populationSize?: number;
  /** RNG seed forwarded to NEAT-AI (incremented per chunk). */
  seed?: number;
  /** Optional iterations cap per chunk (used by unit tests). */
  iterationsPerChunk?: number;
  /** Proposal budget per episode. */
  proposalBudget?: number;
  /** Sink for technique log markers (defaults to `console.log`). */
  log?: (line: string) => void;
  /** Dimensionless MH temperature applied on chunks 2+. */
  mhTemperature?: number;
  /**
   * Bypass stall detection and splice CRISPR on every chunk transition.
   * The 60s smoke run sets this so the harness reliably sees the
   * `🧬 CRISPR splice` marker even when chunk 1 happened to improve.
   */
  forceCrispr?: boolean;
  /**
   * Test seam: replace the inner evolver. Defaults to the real
   * {@link evolveTwoOptController}. Tests pass a deterministic stub to
   * inspect what the orchestrator threads through to each chunk.
   */
  evolver?: typeof evolveTwoOptController;
  /**
   * Test seam: replace the post-chunk replay used for stall detection.
   * Defaults to a strict-acceptance {@link runEpisode} call on the
   * champion. Tests stub this to feed deterministic improvement ratios.
   */
  replay?: (
    champion: Creature,
    instance: TspInstance,
    proposalBudget: number,
  ) => number;
}

/** Per-chunk evolutionary outcome plus the hybrid bookkeeping. */
export interface ChunkResult {
  /** Whatever the inner evolver returned. */
  result: EvolveResult;
  /** Improvement ratio in `[0, 1]` from the strict-replay episode. */
  improvementRatio: number;
  /** True when this chunk was seeded from the previous chunk's champion. */
  memeticReseeded: boolean;
  /** True when CRISPR splicing was applied before this chunk's evolution. */
  crisprApplied: boolean;
  /** Acceptance rule used inside this chunk's episodes. */
  acceptanceMode: TwoOptAcceptanceMode;
  /** MH temperature used inside this chunk's episodes (0 = strict). */
  temperature: number;
}

/** End-to-end result of {@link runHybridEvolution}. */
export interface HybridResult {
  /** Per-chunk outcomes in execution order. */
  chunks: ChunkResult[];
  /** Final champion (== `chunks.at(-1).result.champion`). */
  champion: Creature;
  /** Per-technique reachability flags — true if the technique fired ≥ once. */
  techniques: { memetic: boolean; crispr: boolean; mh: boolean };
}

/**
 * Build the tsp_two_opt-specific edit gene. The gene's two TANH hidden
 * neurons wire into the host's first two input columns and feed back
 * into the host's first two output neurons (by UUID — the host's output
 * UUIDs are auto-generated, so we resolve them at splice time). Weights
 * and biases are deliberately mid-range so the spliced creature still
 * validates after the new edges are added.
 */
export function buildTspEditGene(
  outputUUIDs: ReadonlyArray<string>,
): InjectedGene {
  if (outputUUIDs.length < 2) {
    throw new Error(
      `tsp_two_opt edit gene needs >= 2 host outputs, got ${outputUUIDs.length}`,
    );
  }
  const hidden: LegacyNeuron[] = [
    {
      type: "hidden",
      squash: "TANH",
      index: 0, // reindexed by injectGene
      bias: 0.3,
      uuid: TSP_GENE_NEURON_UUIDS[0],
    },
    {
      type: "hidden",
      squash: "TANH",
      index: 0,
      bias: -0.3,
      uuid: TSP_GENE_NEURON_UUIDS[1],
    },
  ];
  return {
    hidden,
    inputSynapses: [
      { fromInputIndex: 0, toUUID: TSP_GENE_NEURON_UUIDS[0], weight: 1.5 },
      { fromInputIndex: 1, toUUID: TSP_GENE_NEURON_UUIDS[1], weight: -1.5 },
    ],
    outputSynapses: [
      {
        fromUUID: TSP_GENE_NEURON_UUIDS[0],
        toOutputUUID: outputUUIDs[0],
        weight: 1.0,
      },
      {
        fromUUID: TSP_GENE_NEURON_UUIDS[1],
        toOutputUUID: outputUUIDs[1],
        weight: 1.0,
      },
    ],
    internalSynapses: [],
  };
}

/**
 * Project a live {@link Creature} into the index-based
 * {@link LegacyCreatureJSON} shape consumed by `injectGene`. Mirrors
 * the private helper of the same name in `crispr_injection/`.
 */
export function legacyJSONFromCreature(creature: Creature): LegacyCreatureJSON {
  const neurons: LegacyNeuron[] = creature.neurons.map((n, i) => ({
    type: n.type as LegacyNeuron["type"],
    squash: n.squash,
    index: i,
    bias: n.bias,
    uuid: n.uuid ?? `auto-${i}`,
  }));
  const synapses: LegacySynapse[] = creature.synapses.map((s) => ({
    from: s.from,
    to: s.to,
    weight: s.weight,
    ...(s.type ? { type: s.type as LegacySynapse["type"] } : {}),
  }));
  return {
    neurons,
    synapses,
    input: creature.input,
    output: creature.output,
  };
}

/**
 * Splice the tsp_two_opt edit gene into `champion`. Returns a fresh
 * {@link Creature} reconstructed from the spliced JSON plus the
 * intermediate JSON for inspection. The input `champion` is not
 * mutated. Reuses `injectGene` from `crispr_injection/` per the issue's
 * "reuse the gene-splicing primitive" requirement.
 */
export function spliceCrisprGene(champion: Creature): {
  spliced: Creature;
  spliceJSON: LegacyCreatureJSON;
} {
  const hostJSON = legacyJSONFromCreature(champion);
  const outputUUIDs = hostJSON.neurons
    .filter((n) => n.type === "output")
    .map((n) => n.uuid);
  const gene = buildTspEditGene(outputUUIDs);
  const spliceJSON = injectGene(hostJSON, gene);
  const spliced = Creature.fromJSON(asCreatureExport(spliceJSON));
  spliced.validate();
  return { spliced, spliceJSON };
}

/**
 * Replay an evolved champion against the instance under the strict
 * (default) acceptance rule and report the improvement ratio. Used by
 * the orchestrator to detect chunk stalls between transitions.
 */
export function measureChampionImprovement(
  champion: Creature,
  instance: TspInstance,
  proposalBudget: number,
): number {
  const record = runEpisode(champion, instance, { proposalBudget });
  return record.improvementRatio;
}

/**
 * Decide whether the most-recently-completed chunk constitutes a stall
 * relative to the prior chunk. The first transition (chunk 1 → 2) has
 * no "prior chunk" so we baseline against zero improvement.
 *
 * Exported so unit tests can pin the stall-detection rule.
 */
export function isChunkStalled(
  thisImprovement: number,
  priorImprovement: number | undefined,
  epsilon = 1e-6,
): boolean {
  const baseline = priorImprovement ?? 0;
  return thisImprovement <= baseline + epsilon;
}

/**
 * Run the hybrid orchestrator end-to-end. Chains `chunks` evolveEnv
 * calls; between chunks the next seed is the previous chunk's champion
 * (memetic), optionally spliced with the CRISPR edit gene when the
 * chunk stalled. Chunks 2+ run with MH acceptance.
 */
export async function runHybridEvolution(
  options: HybridOptions,
): Promise<HybridResult> {
  const chunks = Math.max(2, options.chunks ?? 2);
  const populationSize = options.populationSize ?? 40;
  const seed = options.seed ?? 12345;
  const proposalBudget = options.proposalBudget ?? DEFAULT_PROPOSAL_BUDGET;
  const log = options.log ?? ((line: string) => console.log(line));
  const mhTemperature = options.mhTemperature ?? 0.002;
  const evolver = options.evolver ?? evolveTwoOptController;
  const replay = options.replay ?? measureChampionImprovement;

  // NEAT-AI's `evolveEnv` requires an **integer** `timeoutMinutes` —
  // fractional values throw `ConfigurationError: Timeout Minutes must
  // be an integer`. The 60s smoke run (`--time-seconds=60`) gives the
  // hybrid orchestrator 0.5 min per chunk on a 2-chunk split, which is
  // not representable. We therefore floor the actual per-chunk budget
  // we ask of `evolveEnv` to `max(1, ceil(perChunkMinutes))` and rely
  // on the iteration cap (or NEAT's own per-generation work) to keep
  // the run inside the user's wall-clock expectation. The original
  // request is preserved on the result so the caller can report it.
  const totalTimeMinutes = Math.max(1 / 60, options.totalTimeMinutes);
  const requestedPerChunkMinutes = totalTimeMinutes / chunks;
  const perChunkMinutes = Math.max(1, Math.ceil(requestedPerChunkMinutes));

  const chunkResults: ChunkResult[] = [];
  let seedExport: CreatureExport | undefined;
  let priorImprovement: number | undefined;
  let lastChampion: Creature | undefined;
  let memeticSeen = false;
  let crisprSeen = false;
  let mhSeen = false;

  for (let chunkIdx = 0; chunkIdx < chunks; chunkIdx++) {
    let memeticReseeded = false;
    let crisprApplied = false;

    if (chunkIdx > 0 && lastChampion !== undefined) {
      memeticReseeded = true;
      memeticSeen = true;
      log(
        `${HYBRID_LOG_MARKERS.memetic} chunk ${chunkIdx + 1}/${chunks} ` +
          `seeded from prior champion.`,
      );

      // Stall-triggered CRISPR splice. `forceCrispr` overrides the
      // stall check so the 60s smoke deterministically exercises the
      // gene-splicing primitive.
      const stalled = isChunkStalled(
        chunkResults[chunkIdx - 1].improvementRatio,
        chunkResults[chunkIdx - 2]?.improvementRatio,
      );
      if (options.forceCrispr || stalled) {
        const { spliced } = spliceCrisprGene(lastChampion);
        seedExport = spliced.exportJSON();
        crisprApplied = true;
        crisprSeen = true;
        log(
          `${HYBRID_LOG_MARKERS.crispr} chunk ${chunkIdx + 1}/${chunks} ` +
            `spliced edit gene into stalled champion ` +
            `(prior improvement ${chunkResults[chunkIdx - 1].improvementRatio.toFixed(4)}).`,
        );
      }
    }

    // MH acceptance is enabled from chunk 2 onwards on pcb442.
    const acceptanceMode: TwoOptAcceptanceMode = chunkIdx === 0 ? "strict" : "mh";
    const temperature = acceptanceMode === "mh" ? mhTemperature : 0;
    if (acceptanceMode === "mh") {
      mhSeen = true;
      log(
        `${HYBRID_LOG_MARKERS.mh} chunk ${chunkIdx + 1}/${chunks} ` +
          `using MH acceptance T=${mhTemperature}.`,
      );
    }

    const result = await evolver({
      instance: options.instance,
      seed: (seed + chunkIdx) >>> 0,
      populationSize,
      iterations: options.iterationsPerChunk,
      // The orchestrator owns the stopping rule; per-chunk we just rely
      // on the wall-clock backstop and (optionally) iterations.
      targetError: 0,
      timeoutMinutes: perChunkMinutes,
      proposalBudget,
      seedCreatureExport: seedExport,
      acceptanceMode,
      temperature,
    });

    const improvementRatio = replay(
      result.champion,
      options.instance,
      proposalBudget,
    );

    chunkResults.push({
      result,
      improvementRatio,
      memeticReseeded,
      crisprApplied,
      acceptanceMode,
      temperature,
    });

    lastChampion = result.champion;
    seedExport = result.champion.exportJSON();
    priorImprovement = improvementRatio;
  }

  // `priorImprovement` is unused outside the loop today; reading it
  // here keeps the lint clean and documents the final chunk's state
  // for future extensions (the SVG renderer lives in issue #483).
  void priorImprovement;

  if (lastChampion === undefined) {
    // Unreachable — `chunks` is clamped to >= 2 so the loop always
    // assigns `lastChampion` — but the type guard satisfies TypeScript.
    throw new Error("runHybridEvolution produced no chunks");
  }

  return {
    chunks: chunkResults,
    champion: lastChampion,
    techniques: { memetic: memeticSeen, crispr: crisprSeen, mh: mhSeen },
  };
}
