#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi

/**
 * Example program demonstrating how to reproduce discovery time-out
 * behaviour with the NEAT-AI library.
 *
 * The script will:
 *   1. Load the reference creature exported from GRQ.
 *   2. Generate synthetic training data (wide and long) into a hidden directory.
 *   3. Remove a hidden neuron to cripple the creature.
 *   4. Run `creature.discoveryDir()` with a forced focus neuron override so the
 *      discovery engine deterministically targets the missing neuron.
 *
 * The dataset is intentionally large so the discovery recorder needs to flush
 * partial results and exercise the Rust time-out logic. The synthetic assets
 * are written under `.synthetic-discovery/` which is hidden and ignored by git.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env --allow-ffi \
 *     discovery/discover_missing_neuron.ts
 */

import { ensureDir } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import {
  Creature,
  type CreatureExport,
  CreatureUtil,
  type NeatOptions,
} from "../../NEAT-AI/mod.ts";

interface SyntheticConfig {
  readonly totalRecords: number;
  readonly recordsPerFile: number;
  readonly seed: number;
}

const SCRIPT_DIR = fromFileUrl(new URL(".", import.meta.url));
const EXAMPLES_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_DIR = join(EXAMPLES_ROOT, "assets");
const REFERENCE_CREATURE_PATH = join(ASSETS_DIR, "fittest_creature.json");

const WORK_ROOT = join(EXAMPLES_ROOT, ".synthetic-discovery");
const DATA_DIR = join(WORK_ROOT, "data");
const CREATURE_DIR = join(WORK_ROOT, "creatures");

export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 4096,
  recordsPerFile: 512,
  seed: 13371337,
};

export const TARGET_SELECTION_SAMPLE_SIZE = 256;

interface TargetSelectionSample {
  readonly input: Float32Array;
  readonly expected: Float32Array;
}

export function createDeterministicRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadReferenceCreature(): Promise<Creature> {
  const raw = await Deno.readTextFile(REFERENCE_CREATURE_PATH);
  const exportJSON = JSON.parse(raw) as CreatureExport;
  const creature = Creature.fromJSON(exportJSON);
  creature.validate();
  CreatureUtil.makeUUID(creature);
  return creature;
}

export function generateTargetSelectionSamples(
  creature: Creature,
  sampleCount: number,
  random: () => number,
): TargetSelectionSample[] {
  if (sampleCount <= 0) {
    throw new Error("Sample count must be positive to select target neuron.");
  }
  const samples: TargetSelectionSample[] = [];
  const inputSize = creature.input;

  creature.clearState();

  for (let index = 0; index < sampleCount; index++) {
    const input = new Float32Array(inputSize);
    for (let obsIndex = 0; obsIndex < inputSize; obsIndex++) {
      input[obsIndex] = random() * 2 - 1;
    }
    const expected = creature.activate(Float32Array.from(input));
    samples.push({
      input: Float32Array.from(input),
      expected: Float32Array.from(expected),
    });
  }

  creature.clearState();
  return samples;
}

function calculateMeanSquaredError(
  predicted: Float32Array,
  expected: Float32Array,
): number {
  let sum = 0;
  const length = expected.length;
  for (let idx = 0; idx < length; idx++) {
    const delta = predicted[idx]! - expected[idx]!;
    sum += delta * delta;
  }
  return sum / length;
}

function evaluateCrippledNeuronError(
  baselineJSON: CreatureExport,
  sampleRecords: readonly TargetSelectionSample[],
  targetNeuronUUID: string,
): number {
  const crippled = createCrippledCreature(baselineJSON, targetNeuronUUID);
  let totalError = 0;

  for (const record of sampleRecords) {
    crippled.clearState();
    const predicted = crippled.activate(record.input);
    totalError += calculateMeanSquaredError(predicted, record.expected);
  }

  return totalError / sampleRecords.length;
}

export function chooseTargetNeuron(
  baselineJSON: CreatureExport,
  sampleRecords: readonly TargetSelectionSample[],
): { uuid: string; meanSquaredError: number } {
  const hiddenNeurons = baselineJSON.neurons.filter((neuron) =>
    neuron.type === "hidden"
  );
  if (hiddenNeurons.length === 0) {
    throw new Error(
      "Reference creature does not contain hidden neurons to target.",
    );
  }

  let worstNeuronUUID = "";
  let worstError = -Infinity;

  for (const neuron of hiddenNeurons) {
    try {
      const error = evaluateCrippledNeuronError(
        baselineJSON,
        sampleRecords,
        neuron.uuid,
      );
      if (error > worstError) {
        worstError = error;
        worstNeuronUUID = neuron.uuid;
      }
    } catch (error) {
      console.warn(
        `Skipping neuron ${neuron.uuid} during target selection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!worstNeuronUUID) {
    throw new Error("Unable to determine a target neuron from sample records.");
  }

  return {
    uuid: worstNeuronUUID,
    meanSquaredError: worstError,
  };
}

function computeForcedFocusNeurons(
  creatureJSON: CreatureExport,
  targetNeuronUUID: string,
): string[] {
  const neuronTypes = new Map(
    creatureJSON.neurons.map((neuron) => [neuron.uuid, neuron.type]),
  );
  const focusCandidates = new Set<string>();

  for (const synapse of creatureJSON.synapses) {
    if (synapse.fromUUID === targetNeuronUUID) {
      focusCandidates.add(synapse.toUUID);
    }
    if (synapse.toUUID === targetNeuronUUID) {
      focusCandidates.add(synapse.fromUUID);
    }
  }

  focusCandidates.delete(targetNeuronUUID);

  const filtered = [...focusCandidates].filter((uuid) => {
    const type = neuronTypes.get(uuid);
    return type === "hidden" || type === "output";
  });

  if (filtered.length > 0) {
    return filtered.slice(0, 4);
  }

  const defaultOutput = creatureJSON.neurons.find((neuron) =>
    neuron.type === "output"
  )?.uuid;

  return defaultOutput ? [defaultOutput] : [];
}

function createCrippledCreature(
  baselineJSON: CreatureExport,
  targetNeuronUUID: string,
): Creature {
  const exportJSON: CreatureExport = structuredClone(baselineJSON);

  exportJSON.neurons = exportJSON.neurons.filter((neuron) =>
    neuron.uuid !== targetNeuronUUID
  );
  exportJSON.synapses = exportJSON.synapses.filter((synapse) =>
    synapse.fromUUID !== targetNeuronUUID &&
    synapse.toUUID !== targetNeuronUUID
  );

  const crippled = Creature.fromJSON(exportJSON);
  crippled.fix();
  crippled.validate();
  CreatureUtil.makeUUID(crippled);
  return crippled;
}

async function generateSyntheticDataset(
  creature: Creature,
  config: SyntheticConfig,
): Promise<void> {
  await ensureDir(DATA_DIR);
  const bytesPerRecord = (creature.input + creature.output) * 4;
  const random = createDeterministicRandom(config.seed);

  let remaining = config.totalRecords;
  let fileIndex = 0;

  while (remaining > 0) {
    const batchSize = Math.min(config.recordsPerFile, remaining);
    const filePath = join(
      DATA_DIR,
      `synthetic_${String(fileIndex).padStart(4, "0")}.bin`,
    );
    const file = await Deno.open(filePath, {
      write: true,
      create: true,
      truncate: true,
    });
    try {
      const buffer = new Uint8Array(bytesPerRecord);
      const view = new Float32Array(buffer.buffer);
      for (let record = 0; record < batchSize; record++) {
        for (let i = 0; i < creature.input; i++) {
          view[i] = random() * 2 - 1;
        }
        const input = view.subarray(0, creature.input);
        const output = creature.activate(Float32Array.from(input));
        for (let j = 0; j < creature.output; j++) {
          view[creature.input + j] = output[j] ?? 0;
        }
        file.writeSync(buffer);
      }
    } finally {
      file.close();
    }

    console.info(
      `Wrote ${batchSize.toLocaleString("en-AU")} records to ${filePath}`,
    );
    remaining -= batchSize;
    fileIndex++;
  }
}

async function saveCreature(
  creature: Creature,
  fileName: string,
): Promise<string> {
  await ensureDir(CREATURE_DIR);
  const outputPath = join(CREATURE_DIR, fileName);
  await Deno.writeTextFile(
    outputPath,
    JSON.stringify(creature.exportJSON(), null, 1),
  );
  return outputPath;
}

async function summarizeDiscoveryRecording(
  creatureUUID: string,
): Promise<void> {
  const discoveryRoot = join(EXAMPLES_ROOT, ".discovery");
  let latestPath: string | null = null;
  let latestMtime = -Infinity;

  try {
    for await (const entry of Deno.readDir(discoveryRoot)) {
      if (!entry.isDirectory) continue;
      if (!entry.name.startsWith(`${creatureUUID}_`)) continue;
      const candidatePath = join(discoveryRoot, entry.name);
      const stat = await Deno.stat(candidatePath);
      const mtime = stat.mtime?.getTime() ?? 0;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestPath = candidatePath;
      }
    }
  } catch (error) {
    console.warn(
      `Unable to inspect discovery artefacts in ${discoveryRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (!latestPath) {
    console.warn("No discovery artefacts were created.");
    return;
  }

  const selectedIndicesPath = join(latestPath, "selected_indices.json");
  try {
    const raw = await Deno.readTextFile(selectedIndicesPath);
    const indices = JSON.parse(raw) as Record<string, number[]>;
    const totalRecords = Object.values(indices)
      .reduce((sum, arr) => sum + arr.length, 0);
    console.info(
      `Discovery recorded ${
        totalRecords.toLocaleString("en-AU")
      } sample(s) across ${Object.keys(indices).length} file(s).`,
    );
    for (const [filePath, rows] of Object.entries(indices)) {
      const fileName = filePath.split("/").pop() ?? filePath;
      console.info(
        `  • ${fileName}: ${rows.length.toLocaleString("en-AU")} record(s)`,
      );
    }
  } catch (error) {
    console.warn(
      `Unable to read discovery indices at ${selectedIndicesPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function runDiscoveryExample(): Promise<void> {
  console.info("Loading reference creature...");
  const referenceCreature = await loadReferenceCreature();

  const selectionRandom = createDeterministicRandom(SYNTHETIC_CONFIG.seed);
  const selectionSamples = generateTargetSelectionSamples(
    referenceCreature,
    TARGET_SELECTION_SAMPLE_SIZE,
    selectionRandom,
  );
  const baselineJSON = referenceCreature.exportJSON();
  const { uuid: targetNeuronUUID, meanSquaredError: targetSampleError } =
    chooseTargetNeuron(
      baselineJSON,
      selectionSamples,
    );
  const forcedFocusNeurons = computeForcedFocusNeurons(
    baselineJSON,
    targetNeuronUUID,
  );

  console.info(
    `Target neuron selected for removal: ${targetNeuronUUID} (sample mse ≈ ${
      targetSampleError.toFixed(6)
    })`,
  );

  console.info("Generating synthetic training data...");
  referenceCreature.clearState();
  await generateSyntheticDataset(referenceCreature, SYNTHETIC_CONFIG);

  console.info("Saving baseline creature snapshot...");
  const baselinePath = await saveCreature(referenceCreature, "baseline.json");

  console.info("Creating crippled creature without target neuron...");
  const crippledCreature = createCrippledCreature(
    baselineJSON,
    targetNeuronUUID,
  );
  const effectiveFocusNeurons = forcedFocusNeurons.filter((uuid) =>
    crippledCreature.neurons.some((neuron) =>
      (neuron.type === "hidden" || neuron.type === "output") &&
      neuron.uuid === uuid
    )
  );
  console.info(
    `Crippled creature topology: ${crippledCreature.neurons.length} neurons, ${crippledCreature.synapses.length} synapses`,
  );
  if (effectiveFocusNeurons.length !== forcedFocusNeurons.length) {
    console.info(
      `Filtered forced focus neurons from ${forcedFocusNeurons.length} to ${effectiveFocusNeurons.length} after fixing creature.`,
    );
  }
  const crippledPath = await saveCreature(
    crippledCreature,
    "crippled.json",
  );

  const discoveryOptions: NeatOptions = {
    verbose: true,
    log: 1,
    discoverySampleRate: 1,
    discoveryBatchSize: 1,
    discoveryTimeOutMinutes: 1,
    discoveryAnalysisTimeoutMinutes: 5,
    discoveryRustFlushRecords: 32,
    discoveryMaxNeurons: 6,
    discoveryDrainEveryNBatches: 32,
    discoveryFocusNeuronUUIDs: effectiveFocusNeurons,
  };

  console.info("Running discovery...");
  const discoveryResult = await crippledCreature.discoveryDir(
    DATA_DIR,
    discoveryOptions,
  );

  const improvement = discoveryResult.improvement;
  if (!improvement) {
    console.error(
      "Discovery completed without producing an improved creature. Exiting with failure.",
    );
    Deno.exit(1);
  }

  const discoveryPath = await saveCreature(
    Creature.fromJSON(improvement.creature),
    "discovered.json",
  );

  console.info("");
  console.info("Discovery summary");
  console.info("=================");
  console.info(`Baseline creature: ${baselinePath}`);
  console.info(`Crippled creature: ${crippledPath}`);
  console.info(`Improved creature: ${discoveryPath}`);
  console.info(`Target neuron UUID: ${targetNeuronUUID}`);
  console.info(
    `Focused neuron UUIDs: ${
      effectiveFocusNeurons.length > 0
        ? effectiveFocusNeurons.join(", ")
        : "none (weighted selection fallback)"
    }`,
  );
  console.info(
    `Discovery outcome: ${improvement.message}`,
  );
  console.info(
    `Better score delta: ${improvement.scoreDelta.toFixed(6)}`,
  );

  await summarizeDiscoveryRecording(
    crippledCreature.uuid ?? referenceCreature.uuid!,
  );
}

if (import.meta.main) {
  await ensureDir(WORK_ROOT);
  await runDiscoveryExample();
}
