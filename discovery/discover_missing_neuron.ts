#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

/**
 * Example program demonstrating neuron discovery with the NEAT-AI library.
 *
 * The script will:
 *   1. Create a simple reference creature with hidden neurons
 *   2. Generate synthetic training data
 *   3. Remove a hidden neuron to "cripple" the creature
 *   4. Run discovery to attempt to recover the missing functionality
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env \
 *     discovery/discover_missing_neuron.ts
 */

import { emptyDirSync, ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, CreatureUtil, type NeatOptions } from "@stsoftware/neat-ai";

export { createDeterministicRandom } from "../shared/deterministic_random.ts";
import { createDeterministicRandom } from "../shared/deterministic_random.ts";

const WORK_ROOT = ".synthetic-discovery";
const DATA_DIR = join(WORK_ROOT, "data");
const CREATURE_DIR = join(WORK_ROOT, "creatures");
const OUTPUT_DIR = join(WORK_ROOT, "output");

export const SYNTHETIC_CONFIG = {
  totalRecords: 256,
  recordsPerFile: 128,
  seed: 13371337,
};

/**
 * Creates a reference creature for the discovery example.
 * This creature has several hidden neurons with different activation functions.
 */
export function createReferenceCreature(): CreatureExport {
  const json: CreatureExport = {
    neurons: [
      // Input neurons
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },
      { type: "input", squash: "LOGISTIC", index: 3, uuid: "input-3" },

      // Hidden neurons - one of these will be "removed"
      {
        type: "hidden",
        squash: "TANH",
        index: 4,
        bias: 0.1,
        uuid: "hidden-0",
      },
      {
        type: "hidden",
        squash: "LeakyReLU",
        index: 5,
        bias: -0.2,
        uuid: "hidden-1",
      },
      {
        type: "hidden",
        squash: "LOGISTIC",
        index: 6,
        bias: 0.05,
        uuid: "hidden-2",
      },
      {
        type: "hidden",
        squash: "SELU",
        index: 7,
        bias: -0.1,
        uuid: "hidden-3",
      },

      // Output neuron
      {
        type: "output",
        squash: "LOGISTIC",
        index: 8,
        bias: 0,
        uuid: "output-0",
      },
    ],
    synapses: [
      // Input to hidden layer
      { from: 0, to: 4, weight: 0.5 },
      { from: 1, to: 4, weight: -0.3 },
      { from: 1, to: 5, weight: 0.7 },
      { from: 2, to: 5, weight: 0.4 },
      { from: 2, to: 6, weight: -0.2 },
      { from: 3, to: 6, weight: 0.6 },
      { from: 0, to: 7, weight: 0.3 },
      { from: 3, to: 7, weight: -0.4 },

      // Hidden to hidden connections
      { from: 4, to: 6, weight: 0.3 },
      { from: 5, to: 7, weight: -0.2 },

      // Hidden to output
      { from: 4, to: 8, weight: 0.6 },
      { from: 5, to: 8, weight: -0.4 },
      { from: 6, to: 8, weight: 0.5 },
      { from: 7, to: 8, weight: 0.3 },
    ],
    input: 4,
    output: 1,
  };

  return json;
}

/**
 * Creates a "crippled" creature by removing a target neuron.
 */
export function createCrippledCreature(
  baselineJSON: CreatureExport,
  targetNeuronUUID: string,
): Creature {
  const exportJSON: CreatureExport = structuredClone(baselineJSON);

  // Find the index of the target neuron to be removed
  const targetIndex = exportJSON.neurons.findIndex(
    (neuron) => neuron.uuid === targetNeuronUUID,
  );

  if (targetIndex === -1) {
    throw new Error(`Target neuron ${targetNeuronUUID} not found`);
  }

  // Filter out synapses connected to the target neuron (using index-based from/to)
  exportJSON.synapses = exportJSON.synapses.filter(
    (synapse) => synapse.from !== targetIndex && synapse.to !== targetIndex,
  );

  // Remove the target neuron
  exportJSON.neurons = exportJSON.neurons.filter(
    (neuron) => neuron.uuid !== targetNeuronUUID,
  );

  // Update indices for remaining neurons and synapses
  // Neurons after the removed one need their index decremented
  exportJSON.neurons.forEach((neuron) => {
    if (neuron.index > targetIndex) {
      neuron.index--;
    }
  });

  // Synapses need their from/to indices updated
  exportJSON.synapses.forEach((synapse) => {
    if (synapse.from > targetIndex) {
      synapse.from--;
    }
    if (synapse.to > targetIndex) {
      synapse.to--;
    }
  });

  const crippled = Creature.fromJSON(exportJSON);
  crippled.validate();
  CreatureUtil.makeUUID(crippled);
  return crippled;
}

/**
 * Generates synthetic training data based on the reference creature's behavior.
 */
export function generateSyntheticData(
  creature: Creature,
  dataDir: string,
  config: typeof SYNTHETIC_CONFIG,
): void {
  const random = createDeterministicRandom(config.seed);
  const bytesPerRecord = (creature.input + creature.output) * 4;

  let remaining = config.totalRecords;
  let fileIndex = 0;

  while (remaining > 0) {
    const batchSize = Math.min(config.recordsPerFile, remaining);
    const filePath = join(
      dataDir,
      `synthetic_${String(fileIndex).padStart(4, "0")}.bin`,
    );

    const buffer = new Uint8Array(bytesPerRecord * batchSize);
    const view = new Float32Array(buffer.buffer);

    let offset = 0;
    for (let record = 0; record < batchSize; record++) {
      // Generate random input
      for (let i = 0; i < creature.input; i++) {
        view[offset + i] = random() * 2 - 1;
      }

      // Get creature's output for this input
      const input = view.subarray(offset, offset + creature.input);
      creature.clearState();
      const output = creature.activate(Float32Array.from(input));

      // Store output
      for (let j = 0; j < creature.output; j++) {
        view[offset + creature.input + j] = output[j] ?? 0;
      }

      offset += creature.input + creature.output;
    }

    Deno.writeFileSync(filePath, buffer);
    console.log(`   Generated ${batchSize} records to ${filePath}`);

    remaining -= batchSize;
    fileIndex++;
  }
}

/**
 * Saves a creature to a JSON file.
 */
async function saveCreature(
  creature: Creature | CreatureExport,
  fileName: string,
): Promise<string> {
  const outputPath = join(CREATURE_DIR, fileName);
  const json = "exportJSON" in creature ? creature.exportJSON() : creature;
  await Deno.writeTextFile(outputPath, JSON.stringify(json, null, 2));
  return outputPath;
}

async function runDiscoveryExample(): Promise<void> {
  const stage = (label: string) => {
    console.log(`\n== ${label} ==`);
  };

  // Setup directories
  ensureDirSync(WORK_ROOT);
  ensureDirSync(DATA_DIR);
  ensureDirSync(CREATURE_DIR);
  emptyDirSync(OUTPUT_DIR);

  // Stage 1: Create reference creature
  stage("Stage 1/4: Creating reference creature");
  const baselineJSON = createReferenceCreature();
  const referenceCreature = Creature.fromJSON(baselineJSON);
  referenceCreature.validate();
  CreatureUtil.makeUUID(referenceCreature);

  console.log(
    `   Observations: ${referenceCreature.input}, ` +
      `Neurons: ${referenceCreature.neurons.length}, ` +
      `Synapses: ${referenceCreature.synapses.length}`,
  );

  // Save baseline
  const baselinePath = await saveCreature(referenceCreature, "baseline.json");
  console.log(`   Saved baseline creature to ${baselinePath}`);

  // Stage 2: Generate synthetic training data
  stage("Stage 2/4: Generating synthetic training data");
  generateSyntheticData(referenceCreature, DATA_DIR, SYNTHETIC_CONFIG);

  // Stage 3: Create crippled creature (remove hidden-1 which is LeakyReLU)
  stage("Stage 3/4: Creating crippled creature");
  const targetNeuronUUID = "hidden-1";
  const targetNeuron = baselineJSON.neurons.find(
    (n) => n.uuid === targetNeuronUUID,
  );
  console.log(
    `   Removing neuron: ${targetNeuronUUID} (squash: ${targetNeuron?.squash})`,
  );

  const crippledCreature = createCrippledCreature(baselineJSON, targetNeuronUUID);
  console.log(
    `   Crippled creature: ${crippledCreature.neurons.length} neurons, ` +
      `${crippledCreature.synapses.length} synapses`,
  );

  const crippledPath = await saveCreature(crippledCreature, "crippled.json");
  console.log(`   Saved crippled creature to ${crippledPath}`);

  // Score both creatures to show the difference
  const baselineScore = referenceCreature.scoreDir(DATA_DIR, {});
  const crippledScore = crippledCreature.scoreDir(DATA_DIR, {});
  console.log(
    `   Baseline score: ${baselineScore.score.toPrecision(6)}, ` +
      `Crippled score: ${crippledScore.score.toPrecision(6)}`,
  );

  // Stage 4: Run discovery
  stage("Stage 4/4: Running discovery");
  console.log("   Attempting to recover missing functionality...");

  const discoveryOptions: NeatOptions = {
    verbose: false,
    costOfGrowth: 0,
    discoverySampleRate: 1,
    discoveryBatchSize: 4,
    discoveryTimeOutMinutes: 1,
    discoveryAnalysisTimeoutMinutes: 1,
    discoveryMinImprovementPercentage: 0.001,
    discoveryMaxNeurons: 2,
    discoveryDisableSynapseCandidates: true,
    discoveryDisableHarmfulCandidates: true,
    discoveryDisableSquashCandidates: true,
  };

  const startTime = performance.now();
  const discoveryResult = await crippledCreature.discoveryDir(
    DATA_DIR,
    discoveryOptions,
  );
  const durationSeconds = ((performance.now() - startTime) / 1000).toFixed(1);

  console.log(`   Discovery completed in ${durationSeconds}s`);

  // Process results
  const improvement = discoveryResult.improvement;
  if (improvement) {
    const improvedCreature = Creature.fromJSON(improvement.creature);
    const discoveredPath = await saveCreature(
      improvedCreature,
      "discovered.json",
    );

    const improvedScore = improvedCreature.scoreDir(DATA_DIR, {});
    console.log(`\n   Discovery found an improvement!`);
    console.log(`   Improved score: ${improvedScore.score.toPrecision(6)}`);
    console.log(`   Score delta: ${improvement.scoreDelta.toFixed(6)}`);
    console.log(`   Saved discovered creature to ${discoveredPath}`);
  } else {
    console.log(`\n   No improvement found in this run.`);
    console.log(
      `   This can happen with small datasets - try increasing totalRecords.`,
    );
  }

  // Summary
  console.log("\n== Summary ==");
  console.log(`   Baseline creature: ${baselinePath}`);
  console.log(`   Crippled creature: ${crippledPath}`);
  console.log(`   Target neuron: ${targetNeuronUUID} (${targetNeuron?.squash})`);
  console.log(
    `   Discovery outcome: ${improvement ? "Improvement found" : "No improvement"}`,
  );
}

if (import.meta.main) {
  await runDiscoveryExample();
}
