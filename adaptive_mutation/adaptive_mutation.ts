/**
 * Adaptive Mutation Rate Demo (issue #86).
 *
 * Visualises one of NEAT-AI's hidden but important behaviours: the
 * mutation operator distribution shifts away from topology mutations
 * (add/remove neuron, add/remove synapse) and toward weight/bias
 * mutations as a creature grows. Tiny seed creatures need new structure
 * — adding a hidden neuron is often the only way forward — but once a
 * creature has hundreds of neurons and thousands of synapses, the
 * remaining error is overwhelmingly down to weight tuning, not extra
 * topology. NEAT-AI exploits this and weights its operator selection
 * accordingly.
 *
 * The demo runs two evolution loops on the same synthetic regression
 * task with everything held constant except the seed creature size:
 *
 * - **Small run** — starts from a `buildLargeCreature` with 5 hidden
 *   neurons and very low density (the smallest deterministic creature
 *   the helper can produce while staying valid).
 * - **Large run** — starts from `buildLargeCreature`'s defaults
 *   (~256 hidden, ~10k synapses).
 *
 * At every generation the demo samples K mutation operators and asks
 * the **adaptive policy** to pick each one. The policy reads each
 * candidate creature's current size and reduces the topology share as
 * size grows. We tally the chosen operators per generation and plot
 * topology share versus weight/bias share for both runs side-by-side
 * — the small-run topology share stays high while the large-run
 * topology share collapses toward zero almost immediately.
 *
 * No actual NEAT-AI training pass is invoked. The "evolution" here is
 * a deterministic mutation walk that updates each creature's neuron
 * and synapse counts after each operator. That keeps the demo
 * self-contained, byte-deterministic, and well under the 90-second
 * budget while still illustrating the size-driven shift that the
 * library performs internally.
 */
import { format } from "@std/fmt/duration";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";

import { buildLargeCreature } from "../common/large_creature.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { renderAdaptiveMutationSVG } from "./svg.ts";

/** Working-directory root for artefacts produced by this demo. */
export const WORKING_ROOT = ".adaptive-mutation";

/** Path to the SVG snapshot the runner emits for the README. */
export const SCREENSHOT_PATH = "docs/screenshots/adaptive_mutation.svg";

/**
 * Mirror copy of the SVG written under `WORKING_ROOT/output/` so the
 * canonical "output/" location requested in issue #86 is also populated.
 */
export const WORKING_OUTPUT_PATH = join(WORKING_ROOT, "output", "adaptive_mutation.svg");

/** Mutation operator categories tracked by this demo. */
export type MutationCategory = "topology" | "weight";

/** Concrete mutation operator names — sub-categorise the buckets above. */
export type MutationOperator =
  | "add_neuron"
  | "remove_neuron"
  | "add_synapse"
  | "remove_synapse"
  | "mod_weight"
  | "mod_bias";

/** Map every operator to one of the two top-level categories. */
export const OPERATOR_CATEGORY: Record<MutationOperator, MutationCategory> = {
  add_neuron: "topology",
  remove_neuron: "topology",
  add_synapse: "topology",
  remove_synapse: "topology",
  mod_weight: "weight",
  mod_bias: "weight",
};

/** Lightweight creature surrogate — only what the policy needs. */
export interface CreatureSize {
  /** Number of hidden neurons. */
  hidden: number;
  /** Number of synapses (edges). */
  synapses: number;
}

/** Configuration for the adaptive mutation policy. */
export interface AdaptivePolicyConfig {
  /**
   * Topology-mutation probability for a vanishingly small creature
   * (size → 0). Must lie in (0, 1]. Default 0.6.
   */
  baseTopologyProb: number;
  /**
   * Size scale at which the topology probability is halved. Larger
   * values keep topology mutations active for bigger creatures.
   * Must be > 0. Default 80.
   */
  sizeScale: number;
  /**
   * Per-topology-operator weights. Normalised internally so they
   * always sum to 1. Defaults bias slightly toward additive operators.
   */
  topologyOperatorWeights: Record<
    "add_neuron" | "remove_neuron" | "add_synapse" | "remove_synapse",
    number
  >;
  /**
   * Per-weight-operator weights. Normalised internally so they always
   * sum to 1.
   */
  weightOperatorWeights: Record<"mod_weight" | "mod_bias", number>;
}

/** Sensible defaults for the size-driven shift. */
export const DEFAULT_POLICY_CONFIG: AdaptivePolicyConfig = {
  baseTopologyProb: 0.6,
  sizeScale: 80,
  topologyOperatorWeights: {
    add_neuron: 0.30,
    add_synapse: 0.40,
    remove_neuron: 0.10,
    remove_synapse: 0.20,
  },
  weightOperatorWeights: {
    mod_weight: 0.7,
    mod_bias: 0.3,
  },
};

/**
 * Probability the policy chooses a **topology** operator for a creature
 * of the given size. Pure function of size; useful in tests and the
 * SVG legend caption.
 */
export function topologyProbability(
  size: CreatureSize,
  policy: AdaptivePolicyConfig = DEFAULT_POLICY_CONFIG,
): number {
  if (policy.baseTopologyProb <= 0 || policy.baseTopologyProb > 1) {
    throw new Error(
      `baseTopologyProb must be in (0, 1], got ${policy.baseTopologyProb}`,
    );
  }
  if (policy.sizeScale <= 0) {
    throw new Error(`sizeScale must be > 0, got ${policy.sizeScale}`);
  }
  const total = Math.max(0, size.hidden) + Math.max(0, size.synapses);
  return policy.baseTopologyProb / (1 + total / policy.sizeScale);
}

/**
 * Pick a single mutation operator using `random` and the adaptive
 * policy. The probability of returning a topology operator is
 * `topologyProbability(size, policy)`; given that bucket, the operator
 * is chosen by the corresponding weight map.
 */
export function chooseOperator(
  size: CreatureSize,
  random: () => number,
  policy: AdaptivePolicyConfig = DEFAULT_POLICY_CONFIG,
): MutationOperator {
  const pTopology = topologyProbability(size, policy);
  if (random() < pTopology) {
    return weightedPick(policy.topologyOperatorWeights, random) as MutationOperator;
  }
  return weightedPick(policy.weightOperatorWeights, random) as MutationOperator;
}

function weightedPick(weights: Record<string, number>, random: () => number): string {
  const entries = Object.entries(weights);
  let total = 0;
  for (const [, w] of entries) {
    if (w < 0) throw new Error(`operator weight must be >= 0, got ${w}`);
    total += w;
  }
  if (total <= 0) {
    throw new Error("operator weights must contain at least one positive entry");
  }
  let r = random() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r < 0) return name;
  }
  return entries[entries.length - 1][0];
}

/**
 * Apply the size-changing effect of `op` to `size` in place. Bookkeeping
 * only — the demo does not actually perturb weights, since the policy
 * cares solely about creature size.
 */
export function applyOperator(size: CreatureSize, op: MutationOperator): void {
  switch (op) {
    case "add_neuron":
      // A new hidden neuron typically lands on an existing edge, so
      // one synapse is "split" into two.
      size.hidden += 1;
      size.synapses += 1;
      return;
    case "add_synapse":
      size.synapses += 1;
      return;
    case "remove_neuron":
      // Refuse to drop below one hidden neuron so the network stays
      // capable of solving anything non-linear.
      if (size.hidden > 1) {
        size.hidden -= 1;
        // Removing a neuron drops at least its incoming + outgoing
        // synapses; we approximate by 2.
        size.synapses = Math.max(1, size.synapses - 2);
      }
      return;
    case "remove_synapse":
      if (size.synapses > 1) size.synapses -= 1;
      return;
    case "mod_weight":
    case "mod_bias":
      // No size change.
      return;
  }
}

/** Per-generation tally for one evolution loop. */
export interface GenerationRecord {
  /** Zero-indexed generation. */
  generation: number;
  /** Mean creature size (hidden + synapses) at the START of this gen. */
  meanSize: number;
  /** Number of topology operators applied in this generation. */
  topologyMutations: number;
  /** Number of weight/bias operators applied in this generation. */
  weightMutations: number;
  /**
   * Topology mutation share — `topologyMutations / (topologyMutations
   * + weightMutations)`. Falls in [0, 1].
   */
  topologyRate: number;
  /** Weight/bias mutation share — `1 - topologyRate`. */
  weightRate: number;
}

/** Configuration for one of the two evolution loops. */
export interface RunConfig {
  /** Display label for the rendered chart panel. */
  label: string;
  /** Initial number of hidden neurons. */
  initialHidden: number;
  /** Connection density forwarded to `buildLargeCreature`. */
  density: number;
  /** Random seed for the deterministic creature constructor. */
  seed: number;
}

/** Combined demo configuration. */
export interface AdaptiveMutationConfig {
  /** Generations per run. */
  generations: number;
  /** Mutation operators applied per generation per creature. */
  mutationsPerGeneration: number;
  /** Population size per run. */
  populationSize: number;
  /** PRNG seed driving operator selection. */
  policySeed: number;
  /** Tunable adaptive policy. */
  policy: AdaptivePolicyConfig;
  /** Configuration for the small-creature run. */
  small: RunConfig;
  /** Configuration for the large-creature run. */
  large: RunConfig;
}

/**
 * Defaults tuned so the demo runs end-to-end in well under a second on
 * a developer machine while producing a clearly diverging two-panel
 * chart.
 */
export const DEFAULT_ADAPTIVE_MUTATION_CONFIG: AdaptiveMutationConfig = {
  generations: 60,
  mutationsPerGeneration: 4,
  populationSize: 8,
  policySeed: 86086086,
  policy: DEFAULT_POLICY_CONFIG,
  small: {
    label: "small (~5 hidden)",
    initialHidden: 5,
    density: 0.5,
    seed: 86_001,
  },
  large: {
    label: "large (~256 hidden, ~10k synapses)",
    initialHidden: 256,
    density: 0.3,
    seed: 86_002,
  },
};

/** Combined result of one run. */
export interface RunResult {
  /** Display label echoed from `RunConfig`. */
  label: string;
  /** Per-generation tallies for the run. */
  records: GenerationRecord[];
  /** Initial hidden + synapse counts at generation 0. */
  initialSize: CreatureSize;
  /** Final mean hidden + synapse counts after the last generation. */
  finalMeanSize: CreatureSize;
}

/** Combined result of running both evolution loops. */
export interface AdaptiveMutationResult {
  small: RunResult;
  large: RunResult;
  /** Mean topology share across all generations of the small run. */
  smallTopologyShareMean: number;
  /** Mean topology share across all generations of the large run. */
  largeTopologyShareMean: number;
}

/**
 * Build the initial population for a run by cloning the size of the
 * deterministic seed creature `populationSize` times. Per-creature
 * mutation walks then diverge once the loop starts.
 */
export function buildInitialPopulation(
  runConfig: RunConfig,
  populationSize: number,
): CreatureSize[] {
  if (populationSize <= 0) {
    throw new Error(`populationSize must be positive, got ${populationSize}`);
  }
  const creature = buildLargeCreature({
    inputs: 4,
    hidden: runConfig.initialHidden,
    outputs: 2,
    density: runConfig.density,
    seed: runConfig.seed,
  });
  const initial: CreatureSize = {
    hidden: runConfig.initialHidden,
    synapses: creature.synapses.length,
  };
  return Array.from({ length: populationSize }, () => ({ ...initial }));
}

/**
 * Run a single evolution loop. Each generation, every creature in the
 * population receives `mutationsPerGeneration` operators, chosen by
 * the adaptive policy from its current size. Returns one
 * {@link GenerationRecord} per generation.
 */
export function runSingleEvolution(
  runConfig: RunConfig,
  generations: number,
  mutationsPerGeneration: number,
  populationSize: number,
  policy: AdaptivePolicyConfig,
  random: () => number,
): RunResult {
  if (generations <= 0) {
    throw new Error(`generations must be positive, got ${generations}`);
  }
  if (mutationsPerGeneration <= 0) {
    throw new Error(
      `mutationsPerGeneration must be positive, got ${mutationsPerGeneration}`,
    );
  }
  const population = buildInitialPopulation(runConfig, populationSize);
  const initialSize: CreatureSize = { ...population[0] };
  const records: GenerationRecord[] = [];

  for (let g = 0; g < generations; g++) {
    let topologyCount = 0;
    let weightCount = 0;
    let sizeSum = 0;
    for (const creature of population) {
      sizeSum += creature.hidden + creature.synapses;
      for (let m = 0; m < mutationsPerGeneration; m++) {
        const op = chooseOperator(creature, random, policy);
        if (OPERATOR_CATEGORY[op] === "topology") topologyCount++;
        else weightCount++;
        applyOperator(creature, op);
      }
    }
    const total = topologyCount + weightCount;
    records.push({
      generation: g,
      meanSize: sizeSum / population.length,
      topologyMutations: topologyCount,
      weightMutations: weightCount,
      topologyRate: total === 0 ? 0 : topologyCount / total,
      weightRate: total === 0 ? 0 : weightCount / total,
    });
  }

  let hiddenSum = 0;
  let synapsesSum = 0;
  for (const creature of population) {
    hiddenSum += creature.hidden;
    synapsesSum += creature.synapses;
  }
  return {
    label: runConfig.label,
    records,
    initialSize,
    finalMeanSize: {
      hidden: hiddenSum / population.length,
      synapses: synapsesSum / population.length,
    },
  };
}

/** Mean of the `topologyRate` field across `records`. */
export function meanTopologyShare(records: readonly GenerationRecord[]): number {
  if (records.length === 0) return 0;
  let sum = 0;
  for (const r of records) sum += r.topologyRate;
  return sum / records.length;
}

/**
 * Run both evolution loops with shared policy configuration. Both runs
 * use independent PRNG streams seeded from `config.policySeed` so the
 * two runs do not co-vary on later draws.
 */
export function runAdaptiveMutationDemo(
  config: AdaptiveMutationConfig = DEFAULT_ADAPTIVE_MUTATION_CONFIG,
): AdaptiveMutationResult {
  if (config.generations <= 0) {
    throw new Error(`generations must be positive, got ${config.generations}`);
  }
  if (config.populationSize <= 0) {
    throw new Error(`populationSize must be positive, got ${config.populationSize}`);
  }

  const smallRandom = createDeterministicRandom(config.policySeed ^ 0x1111_1111);
  const largeRandom = createDeterministicRandom(config.policySeed ^ 0x2222_2222);

  const small = runSingleEvolution(
    config.small,
    config.generations,
    config.mutationsPerGeneration,
    config.populationSize,
    config.policy,
    smallRandom,
  );
  const large = runSingleEvolution(
    config.large,
    config.generations,
    config.mutationsPerGeneration,
    config.populationSize,
    config.policy,
    largeRandom,
  );

  return {
    small,
    large,
    smallTopologyShareMean: meanTopologyShare(small.records),
    largeTopologyShareMean: meanTopologyShare(large.records),
  };
}

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Adaptive Mutation Rate Demo (issue #86)");
  console.log("");

  setupWorkingDirs(WORKING_ROOT);

  console.log("🧪 Running small-creature and large-creature evolution loops...");
  const result = runAdaptiveMutationDemo(DEFAULT_ADAPTIVE_MUTATION_CONFIG);

  console.log("");
  console.log(
    `   small initial size  hidden=${result.small.initialSize.hidden}  ` +
      `synapses=${result.small.initialSize.synapses}`,
  );
  console.log(
    `   large initial size  hidden=${result.large.initialSize.hidden}  ` +
      `synapses=${result.large.initialSize.synapses}`,
  );
  console.log("");
  console.log(`   small mean topology share = ${result.smallTopologyShareMean.toFixed(4)}`);
  console.log(`   large mean topology share = ${result.largeTopologyShareMean.toFixed(4)}`);
  console.log(
    `   shift (small - large)     = ${
      (result.smallTopologyShareMean - result.largeTopologyShareMean).toFixed(4)
    }`,
  );

  const svg = renderAdaptiveMutationSVG({
    small: result.small,
    large: result.large,
  });
  ensureDirSync("docs/screenshots");
  ensureDirSync(join(WORKING_ROOT, "output"));
  await Deno.writeTextFile(SCREENSHOT_PATH, svg);
  await Deno.writeTextFile(WORKING_OUTPUT_PATH, svg);
  console.log(`\n🖼️  Wrote ${SCREENSHOT_PATH}`);
  console.log(`🖼️  Mirror at ${WORKING_OUTPUT_PATH}`);

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}
