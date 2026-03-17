/**
 * Crossover (Breeding) Example
 *
 * This example demonstrates how to breed two parent creatures to produce
 * offspring using the NEAT-AI library. Crossover is a fundamental
 * neuroevolution operation where two "parent" neural networks are combined
 * to produce a "child" that inherits traits from both.
 *
 * The workflow:
 * 1. Create two parent creatures with different architectures
 * 2. Generate synthetic training data
 * 3. Score both parents against the data
 * 4. Perform crossover to produce offspring
 * 5. Score the offspring and compare to parents
 */

import { format } from "@std/fmt/duration";
import { join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  CreatureUtil,
  type NeuronExport,
  safeWriteJson,
  type SynapseExport,
} from "@stsoftware/neat-ai";
import { addTag } from "@stsoftware/tags/mod";

import {
  generateSyntheticData,
  scoreCreature,
  type SyntheticConfig,
} from "../common/synthetic_data.ts";
import { setupWorkingDirs } from "../common/working_dirs.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";

export {
  generateSyntheticData,
  scoreCreature,
  type SyntheticConfig,
} from "../common/synthetic_data.ts";

export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 500,
  recordsPerFile: 500,
  seed: 77889900,
};

if (import.meta.main) {
  const start = Date.now();

  console.log("🧬 Crossover (Breeding) Example");
  console.log("");

  // Set up directories (all under a hidden, gitignored folder)
  const { dataDir, creaturesDir, outputDir } = setupWorkingDirs(".synthetic-crossover");

  // Step 1: Create two parent creatures
  console.log("📦 Step 1: Creating parent creatures...");
  const parentA = createParentA();
  const parentB = createParentB();

  const parentAExport = parentA.exportJSON();
  const parentBExport = parentB.exportJSON();

  const parentAPath = join(creaturesDir, "parent_a.json");
  const parentBPath = join(creaturesDir, "parent_b.json");
  await safeWriteJson(parentAPath, parentAExport);
  await safeWriteJson(parentBPath, parentBExport);

  const hiddenA = parentAExport.neurons.filter((n) => n.type === "hidden");
  const hiddenB = parentBExport.neurons.filter((n) => n.type === "hidden");
  console.log(
    `   Parent A: ${hiddenA.length} hidden neurons, ` +
      `squashes: ${hiddenA.map((n) => n.squash).join(", ")}`,
  );
  console.log(
    `   Parent B: ${hiddenB.length} hidden neurons, ` +
      `squashes: ${hiddenB.map((n) => n.squash).join(", ")}`,
  );

  // Step 2: Generate synthetic training data from parent A
  console.log("\n📊 Step 2: Generating synthetic training data...");
  generateSyntheticData(parentA, dataDir, SYNTHETIC_CONFIG);

  // Step 3: Score both parents
  console.log("\n📈 Step 3: Scoring parents...");
  const scoreA = scoreCreature(parentA, dataDir);
  const scoreB = scoreCreature(parentB, dataDir);
  addTag(parentAExport, "score", `${scoreA}`);
  addTag(parentBExport, "score", `${scoreB}`);
  console.log(`   Parent A score: ${scoreA.toPrecision(6)}`);
  console.log(`   Parent B score: ${scoreB.toPrecision(6)}`);

  // Step 4: Perform crossover
  console.log("\n🔬 Step 4: Performing crossover...");
  const offspring = performCrossover(parentA, parentB);

  if (offspring) {
    const offspringExport = offspring.exportJSON();
    const offspringHidden = offspringExport.neurons.filter((n) => n.type === "hidden");
    console.log(
      `   Offspring: ${offspringHidden.length} hidden neurons, ` +
        `squashes: ${offspringHidden.map((n) => n.squash).join(", ")}`,
    );

    const offspringPath = join(creaturesDir, "offspring.json");
    await safeWriteJson(offspringPath, offspringExport);

    // Step 5: Score the offspring
    console.log("\n📊 Step 5: Scoring offspring...");
    const scoreOffspring = scoreCreature(offspring, dataDir);
    addTag(offspringExport, "score", `${scoreOffspring}`);
    console.log(`   Offspring score: ${scoreOffspring.toPrecision(6)}`);

    // Compare
    console.log("\n📋 Comparison:");
    console.log(`   Parent A score:  ${scoreA.toPrecision(6)}`);
    console.log(`   Parent B score:  ${scoreB.toPrecision(6)}`);
    console.log(`   Offspring score: ${scoreOffspring.toPrecision(6)}`);

    const bestParentScore = Math.max(scoreA, scoreB);
    if (scoreOffspring > bestParentScore) {
      console.log("   Offspring outperforms both parents!");
    } else if (scoreOffspring > Math.min(scoreA, scoreB)) {
      console.log("   Offspring performs between the two parents.");
    } else {
      console.log(
        "   Offspring scores below both parents (common in single-generation crossover).",
      );
    }

    // Step 6: Multi-generation evolution using evolveDir
    console.log("\n🔄 Step 6: Multi-generation evolution from offspring...");
    offspring.score = scoreOffspring;
    const evolveResult = await offspring.evolveDir(dataDir, {
      populationSize: 10,
      iterations: 5,
      verbose: false,
      costOfGrowth: 0,
    });
    // evolveDir mutates the creature in-place and returns statistics
    const evolvedScore = scoreCreature(offspring, dataDir);
    console.log(
      `   Evolved score after ${evolveResult.generation} generations: ` +
        `${evolvedScore.toPrecision(6)}`,
    );

    const evolvedPath = join(creaturesDir, "evolved.json");
    await safeWriteJson(evolvedPath, offspring.exportJSON());

    // Save multiple offspring to output dir
    for (let i = 0; i < 3; i++) {
      const child = performCrossover(parentA, parentB);
      if (child) {
        const childPath = join(outputDir, `offspring_${i}.json`);
        await safeWriteJson(childPath, child.exportJSON());
      }
    }
  } else {
    console.log("   Crossover did not produce viable offspring.");
    console.log("   This can happen when parents are structurally incompatible.");
  }

  console.log(
    `\n🏁 Example completed in ${format(Date.now() - start, { ignoreZero: true })}`,
  );
}

/**
 * Creates the first parent creature (Parent A).
 *
 * This parent uses TANH and LOGISTIC activation functions, representing
 * one "lineage" of neural network architecture.
 */
export function createParentA(): Creature {
  const json: CreatureExport = {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },

      {
        type: "hidden",
        squash: "TANH",
        index: 3,
        bias: 0.15,
        uuid: "hidden-a0",
      },
      {
        type: "hidden",
        squash: "LOGISTIC",
        index: 4,
        bias: -0.1,
        uuid: "hidden-a1",
      },
      {
        type: "hidden",
        squash: "TANH",
        index: 5,
        bias: 0.05,
        uuid: "hidden-a2",
      },

      {
        type: "output",
        squash: "LOGISTIC",
        index: 6,
        bias: 0,
        uuid: "output-0",
      },
    ],
    synapses: [
      { from: 0, to: 3, weight: 0.6 },
      { from: 1, to: 3, weight: -0.4 },
      { from: 1, to: 4, weight: 0.7 },
      { from: 2, to: 4, weight: 0.3 },
      { from: 0, to: 5, weight: -0.5 },
      { from: 2, to: 5, weight: 0.4 },
      { from: 3, to: 6, weight: 0.8 },
      { from: 4, to: 6, weight: -0.3 },
      { from: 5, to: 6, weight: 0.5 },
    ],
    input: 3,
    output: 1,
  };

  return Creature.fromJSON(json);
}

/**
 * Creates the second parent creature (Parent B).
 *
 * This parent uses SELU and LeakyReLU activation functions, representing
 * a different "lineage" of neural network architecture.
 */
export function createParentB(): Creature {
  const json: CreatureExport = {
    neurons: [
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },

      {
        type: "hidden",
        squash: "SELU",
        index: 3,
        bias: -0.2,
        uuid: "hidden-b0",
      },
      {
        type: "hidden",
        squash: "LeakyReLU",
        index: 4,
        bias: 0.1,
        uuid: "hidden-b1",
      },
      {
        type: "hidden",
        squash: "SELU",
        index: 5,
        bias: 0.08,
        uuid: "hidden-b2",
      },

      {
        type: "output",
        squash: "LOGISTIC",
        index: 6,
        bias: 0,
        uuid: "output-0",
      },
    ],
    synapses: [
      { from: 0, to: 3, weight: -0.3 },
      { from: 1, to: 3, weight: 0.5 },
      { from: 1, to: 4, weight: -0.6 },
      { from: 2, to: 4, weight: 0.4 },
      { from: 0, to: 5, weight: 0.7 },
      { from: 2, to: 5, weight: -0.2 },
      { from: 3, to: 6, weight: -0.5 },
      { from: 4, to: 6, weight: 0.6 },
      { from: 5, to: 6, weight: 0.4 },
    ],
    input: 3,
    output: 1,
  };

  return Creature.fromJSON(json);
}

/**
 * Performs crossover between two parent creatures to produce offspring.
 *
 * This implements the core NEAT crossover operation: neurons and synapses
 * from both parents are combined to create a child creature. The mother's
 * (parentA) neurons are always included, while the father's (parentB)
 * unique neurons have a 50% chance of inclusion. Weights and biases of
 * matching structures are blended (averaged) between parents.
 *
 * The construction uses the index-based input format that Creature.fromJSON
 * expects, building a complete neuron and synapse list from scratch.
 *
 * Returns a new creature or undefined if the parents are incompatible.
 */
export function performCrossover(
  parentA: Creature,
  parentB: Creature,
): Creature | undefined {
  if (parentA.input !== parentB.input || parentA.output !== parentB.output) {
    return undefined;
  }

  const random = createDeterministicRandom(SYNTHETIC_CONFIG.seed);
  const inputCount = parentA.input;

  // Build index-based representations from internal creature state.
  // We access neurons and synapses directly from the Creature instances
  // to get index-based from/to values that Creature.fromJSON expects.
  const neuronsA = parentA.neurons;
  const neuronsB = parentB.neurons;

  // Collect hidden neurons from both parents by UUID
  const motherHidden: NeuronExport[] = [];
  for (let i = inputCount; i < neuronsA.length; i++) {
    const n = neuronsA[i];
    motherHidden.push({
      type: n.type === "output" ? "output" : "hidden",
      squash: n.squash,
      bias: n.bias,
      uuid: n.uuid,
      index: i,
    });
  }

  const fatherHiddenMap = new Map<string, { bias: number; squash: string }>();
  const fatherOnlyNeurons: NeuronExport[] = [];
  const motherUUIDs = new Set(motherHidden.map((n) => n.uuid));

  for (let i = inputCount; i < neuronsB.length; i++) {
    const n = neuronsB[i];
    if (n.type === "output") continue;
    if (motherUUIDs.has(n.uuid)) {
      fatherHiddenMap.set(n.uuid, { bias: n.bias, squash: n.squash });
    } else {
      fatherOnlyNeurons.push({
        type: "hidden",
        squash: n.squash,
        bias: n.bias,
        uuid: n.uuid,
        index: 0, // Will be re-indexed later
      });
    }
  }

  // Build offspring neuron list: inputs + mother's hidden + selected father hidden + outputs
  const offspringNeurons: NeuronExport[] = [];

  // Input neurons
  for (let i = 0; i < inputCount; i++) {
    offspringNeurons.push({
      type: "input",
      squash: "LOGISTIC",
      index: i,
      uuid: `input-${i}`,
    });
  }

  // Mother's hidden neurons (with blended biases where father matches)
  for (const neuron of motherHidden) {
    if (neuron.type === "output") continue;
    const fatherMatch = fatherHiddenMap.get(neuron.uuid);
    const blendedBias = fatherMatch !== undefined
      ? ((neuron.bias ?? 0) + fatherMatch.bias) / 2
      : neuron.bias;
    offspringNeurons.push({
      type: "hidden",
      squash: neuron.squash,
      bias: blendedBias,
      uuid: neuron.uuid,
      index: offspringNeurons.length,
    });
  }

  // Father's unique hidden neurons (50% inclusion)
  for (const neuron of fatherOnlyNeurons) {
    if (random() < 0.5) {
      offspringNeurons.push({
        type: "hidden",
        squash: neuron.squash,
        bias: neuron.bias,
        uuid: neuron.uuid,
        index: offspringNeurons.length,
      });
    }
  }

  // Output neuron(s)
  const outputNeuron = motherHidden.find((n) => n.type === "output");
  if (!outputNeuron) return undefined;
  offspringNeurons.push({
    type: "output",
    squash: outputNeuron.squash,
    bias: outputNeuron.bias,
    uuid: outputNeuron.uuid,
    index: offspringNeurons.length,
  });

  // Build UUID-to-index map for synapse construction
  const uuidToIndex = new Map<string, number>();
  for (const neuron of offspringNeurons) {
    if (neuron.uuid) {
      uuidToIndex.set(neuron.uuid, neuron.index);
    }
  }

  // Collect synapses from mother, keyed by fromUUID-toUUID
  const synapsesA = parentA.synapses;
  const synapseMap = new Map<string, { weight: number; from: number; to: number }>();

  for (const s of synapsesA) {
    const fromUUID = parentA.neurons[s.from].uuid;
    const toUUID = parentA.neurons[s.to].uuid;
    const fromIdx = uuidToIndex.get(fromUUID);
    const toIdx = uuidToIndex.get(toUUID);
    if (fromIdx !== undefined && toIdx !== undefined) {
      synapseMap.set(`${fromUUID}->${toUUID}`, {
        weight: s.weight,
        from: fromIdx,
        to: toIdx,
      });
    }
  }

  // Blend or add father's synapses
  const synapsesB = parentB.synapses;
  for (const s of synapsesB) {
    const fromUUID = parentB.neurons[s.from].uuid;
    const toUUID = parentB.neurons[s.to].uuid;
    const key = `${fromUUID}->${toUUID}`;

    const existing = synapseMap.get(key);
    if (existing) {
      // Blend weights
      existing.weight = (existing.weight + s.weight) / 2;
    } else {
      // Add father synapse if both endpoints exist in offspring
      const fromIdx = uuidToIndex.get(fromUUID);
      const toIdx = uuidToIndex.get(toUUID);
      if (fromIdx !== undefined && toIdx !== undefined) {
        synapseMap.set(key, { weight: s.weight, from: fromIdx, to: toIdx });
      }
    }
  }

  // Build synapse array
  const offspringSynapses: SynapseExport[] = [];
  for (const entry of synapseMap.values()) {
    offspringSynapses.push({
      from: entry.from,
      to: entry.to,
      weight: entry.weight,
    });
  }

  const offspringJSON: CreatureExport = {
    neurons: offspringNeurons,
    synapses: offspringSynapses,
    input: inputCount,
    output: parentA.output,
  };

  try {
    const offspring = Creature.fromJSON(offspringJSON);
    offspring.validate();
    CreatureUtil.makeUUID(offspring);
    return offspring;
  } catch {
    return undefined;
  }
}
