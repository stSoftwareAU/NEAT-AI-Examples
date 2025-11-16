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

import { bold, cyan, green, red, yellow } from "@std/fmt/colors";
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
const META_DIR = join(WORK_ROOT, "meta");
const TARGET_CACHE_PATH = join(META_DIR, "target-neuron.json");

export const SYNTHETIC_CONFIG: SyntheticConfig = {
  totalRecords: 512,
  recordsPerFile: 256,
  seed: 13371337,
};

export const TARGET_SELECTION_SAMPLE_SIZE = 256;
const OUTPUT_NEURON_UUID = "output-0";
const MAX_FORCED_FOCUS = 2;
const MIN_TARGET_ERROR = 1e-4;
const TARGET_OVERRIDE_AUTO_SENTINEL = "auto";
const FOCUSED_INPUT_SCALE = 4;
const DISCOVERY_RECORDING_TIMEOUT_MINUTES = 2;
const DISCOVERY_ANALYSIS_TIMEOUT_MINUTES = 2;
const DISCOVERY_MIN_IMPROVEMENT_PERCENTAGE = 0.00005;
const DISCOVERY_COST_OF_GROWTH = 0;
type TargetSelectionSource =
  | "env-override"
  | "cached"
  | "leaky"
  | "global";

interface TargetSelectionSample {
  readonly input: Float32Array;
  readonly expected: Float32Array;
}

interface TargetCacheEntry {
  baselineHash: string;
  targetNeuronUUID: string;
  meanSquaredError: number;
  sampleCount: number;
  updatedAt: string;
}

interface LoadedReferenceCreature {
  creature: Creature;
  baselineJSON: CreatureExport;
  baselineHash: string;
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

async function loadReferenceCreature(): Promise<LoadedReferenceCreature> {
  const raw = await Deno.readTextFile(REFERENCE_CREATURE_PATH);
  const baselineHash = await computeBaselineHash(raw);
  const exportJSON = JSON.parse(raw) as CreatureExport;
  const creature = Creature.fromJSON(exportJSON);
  creature.validate();
  CreatureUtil.makeUUID(creature);
  return { creature, baselineJSON: exportJSON, baselineHash };
}

export function generateTargetSelectionSamples(
  creature: Creature,
  sampleCount: number,
  random: () => number,
  focusedInputIndices?: Set<number>,
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
      const useFocused = focusedInputIndices &&
        focusedInputIndices.has(obsIndex);
      if (focusedInputIndices && focusedInputIndices.size > 0) {
        input[obsIndex] = useFocused
          ? (random() * 2 - 1) * FOCUSED_INPUT_SCALE
          : 0;
      } else {
        input[obsIndex] = random() * 2 - 1;
      }
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
  onProgress?: (processed: number, total: number) => void,
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

  hiddenNeurons.forEach((neuron, index) => {
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

    if (
      onProgress &&
      ((index + 1) % 100 === 0 || index + 1 === hiddenNeurons.length)
    ) {
      onProgress(index + 1, hiddenNeurons.length);
    }
  });

  if (!worstNeuronUUID) {
    throw new Error("Unable to determine a target neuron from sample records.");
  }

  return {
    uuid: worstNeuronUUID,
    meanSquaredError: worstError,
  };
}

function resolveTargetOverride(
  baselineJSON: CreatureExport,
  sampleRecords: readonly TargetSelectionSample[],
):
  | { uuid: string; meanSquaredError: number; source: TargetSelectionSource }
  | null {
  const envValue = Deno.env.get("DISCOVERY_TARGET_UUID")?.trim();
  if (
    envValue &&
    envValue.toLowerCase() === TARGET_OVERRIDE_AUTO_SENTINEL
  ) {
    console.info(
      yellow(
        "DISCOVERY_TARGET_UUID=auto – skipping target override and using automatic selection.",
      ),
    );
    return null;
  }

  if (!envValue || envValue.length === 0) {
    return null;
  }

  const targetNeuron = baselineJSON.neurons.find((neuron) =>
    neuron.uuid === envValue
  );
  if (!targetNeuron) {
    console.warn(
      yellow(
        `Requested override neuron ${envValue} was not found in the reference creature; falling back to automatic selection.`,
      ),
    );
    return null;
  }

  const meanSquaredError = evaluateCrippledNeuronError(
    baselineJSON,
    sampleRecords,
    envValue,
  );

  return { uuid: envValue, meanSquaredError, source: "env-override" };
}

function chooseTargetNeuronFromCandidates(
  baselineJSON: CreatureExport,
  sampleRecords: readonly TargetSelectionSample[],
  candidateUUIDs: string[],
  onProgress?: (processed: number, total: number) => void,
): { uuid: string; meanSquaredError: number } | null {
  if (candidateUUIDs.length === 0) return null;
  let worstNeuronUUID = "";
  let worstError = -Infinity;

  candidateUUIDs.forEach((uuid, index) => {
    try {
      const error = evaluateCrippledNeuronError(
        baselineJSON,
        sampleRecords,
        uuid,
      );
      if (error > worstError) {
        worstError = error;
        worstNeuronUUID = uuid;
      }
    } catch (error) {
      console.warn(
        `Skipping candidate neuron ${uuid} during target selection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    onProgress?.(index + 1, candidateUUIDs.length);
  });

  if (!worstNeuronUUID) {
    return null;
  }
  return { uuid: worstNeuronUUID, meanSquaredError: worstError };
}

async function computeBaselineHash(
  source: CreatureExport | string,
): Promise<string> {
  const encoder = new TextEncoder();
  const payload = typeof source === "string" ? source : JSON.stringify(source);
  const bytes = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function loadCachedTarget(
  baselineHash: string,
): Promise<TargetCacheEntry | null> {
  try {
    const raw = await Deno.readTextFile(TARGET_CACHE_PATH);
    const parsed = JSON.parse(raw) as TargetCacheEntry;
    if (parsed.baselineHash === baselineHash) {
      return parsed;
    }
  } catch {
    // Cache miss or parse error; treat as absent.
  }
  return null;
}

async function saveCachedTarget(entry: TargetCacheEntry): Promise<void> {
  await ensureDir(META_DIR);
  await Deno.writeTextFile(TARGET_CACHE_PATH, JSON.stringify(entry, null, 2));
}

function computeForcedFocusNeurons(
  creatureJSON: CreatureExport,
  targetNeuronUUID: string,
): string[] {
  const neuronTypes = new Map(
    creatureJSON.neurons.map((neuron) => [neuron.uuid, neuron.type]),
  );
  const downstream = new Set<string>();
  const upstream = new Set<string>();

  for (const synapse of creatureJSON.synapses) {
    if (synapse.fromUUID === targetNeuronUUID) {
      downstream.add(synapse.toUUID);
    } else if (synapse.toUUID === targetNeuronUUID) {
      upstream.add(synapse.fromUUID);
    }
  }

  const preferredOutput =
    creatureJSON.neurons.find((neuron) =>
      neuron.type === "output" && neuron.uuid === OUTPUT_NEURON_UUID
    )
      ?.uuid ??
      creatureJSON.neurons.find((neuron) => neuron.type === "output")?.uuid;

  const prioritized: string[] = [];

  const addCandidate = (uuid: string) => {
    if (uuid === targetNeuronUUID) return;
    if (prioritized.includes(uuid)) return;
    const type = neuronTypes.get(uuid);
    if (type === "hidden" || type === "output") {
      prioritized.push(uuid);
    }
  };

  // Prioritise downstream (where the missing neuron previously fed), then output, then upstream supporters.
  [...downstream].forEach(addCandidate);
  if (preferredOutput) {
    addCandidate(preferredOutput);
  }
  [...upstream].forEach(addCandidate);

  if (prioritized.length > 0) {
    return prioritized.slice(0, MAX_FORCED_FOCUS);
  }

  return preferredOutput ? [preferredOutput] : [];
}

function computeFocusedInputIndices(
  creatureJSON: CreatureExport,
  targetNeuronUUID: string,
): Set<number> {
  const indices = new Set<number>();
  for (const synapse of creatureJSON.synapses) {
    if (synapse.toUUID !== targetNeuronUUID) continue;
    if (!synapse.fromUUID.startsWith("input-")) continue;
    const [, rawIndex] = synapse.fromUUID.split("-");
    const parsed = Number(rawIndex);
    if (Number.isFinite(parsed)) {
      indices.add(parsed);
    }
  }
  return indices;
}

function collectDownstreamTargets(
  creatureJSON: CreatureExport,
  targetNeuronUUID: string,
): Set<string> {
  const downstream = new Set<string>();
  for (const synapse of creatureJSON.synapses) {
    if (synapse.fromUUID === targetNeuronUUID) {
      downstream.add(synapse.toUUID);
    }
  }
  return downstream;
}

function accentuateTargetPath(
  creatureJSON: CreatureExport,
  targetNeuronUUID: string,
  downstream: Set<string>,
): boolean {
  if (downstream.size === 0) return false;
  let modified = false;
  for (const synapse of creatureJSON.synapses) {
    if (!downstream.has(synapse.toUUID)) continue;
    if (synapse.fromUUID === targetNeuronUUID) {
      synapse.weight *= FOCUSED_INPUT_SCALE;
    } else {
      synapse.weight = 0;
    }
    modified = true;
  }
  for (const neuron of creatureJSON.neurons) {
    if (downstream.has(neuron.uuid)) {
      neuron.bias = 0;
      modified = true;
    }
  }
  return modified;
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
  crippled.validate();
  CreatureUtil.makeUUID(crippled);
  return crippled;
}

async function generateSyntheticDataset(
  creature: Creature,
  config: SyntheticConfig,
  focusedInputIndices?: Set<number>,
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
          const useFocused = focusedInputIndices && focusedInputIndices.has(i);
          if (focusedInputIndices && focusedInputIndices.size > 0) {
            view[i] = useFocused ? (random() * 2 - 1) * FOCUSED_INPUT_SCALE : 0;
          } else {
            view[i] = random() * 2 - 1;
          }
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
  const stage = (label: string) => {
    console.info(bold(`\n== ${label} ==`));
  };
  const formatSeconds = (seconds: number) => `${seconds.toFixed(1)}s`;

  stage("Stage 1/4: Loading reference creature");
  const loaded = await loadReferenceCreature();
  let referenceCreature = loaded.creature;
  const baselineJSON = loaded.baselineJSON;
  let baselineHash = loaded.baselineHash;
  console.info(
    green(
      `Loaded reference creature (Observations: ${
        referenceCreature.input.toLocaleString("en-AU")
      }, Neurons: ${
        referenceCreature.neurons.length.toLocaleString("en-AU")
      }, Synapses: ${
        referenceCreature.synapses.length.toLocaleString("en-AU")
      }).`,
    ),
  );

  const selectionRandom = createDeterministicRandom(SYNTHETIC_CONFIG.seed);
  const selectionSamples = generateTargetSelectionSamples(
    referenceCreature,
    TARGET_SELECTION_SAMPLE_SIZE,
    selectionRandom,
  );

  const leakyCandidateUUIDs = baselineJSON.neurons
    .filter((neuron) =>
      neuron.type === "hidden" && neuron.squash === "LeakyReLU"
    )
    .map((neuron) => neuron.uuid);

  const overrideSelection = resolveTargetOverride(
    baselineJSON,
    selectionSamples,
  );

  let selectionSource: TargetSelectionSource = "cached";
  let cachedTarget: TargetCacheEntry | null = null;

  if (overrideSelection) {
    selectionSource = overrideSelection.source;
    cachedTarget = {
      baselineHash,
      targetNeuronUUID: overrideSelection.uuid,
      meanSquaredError: overrideSelection.meanSquaredError,
      sampleCount: TARGET_SELECTION_SAMPLE_SIZE,
      updatedAt: new Date().toISOString(),
    };
  } else {
    cachedTarget = await loadCachedTarget(baselineHash);
    selectionSource = cachedTarget ? "cached" : "leaky";
  }

  if (!cachedTarget) {
    let selection: { uuid: string; meanSquaredError: number } | null = null;

    if (leakyCandidateUUIDs.length > 0) {
      console.info(
        yellow(
          `Selecting target neuron from ${
            leakyCandidateUUIDs.length.toLocaleString("en-AU")
          } hidden LeakyReLU neurons...`,
        ),
      );
      selection = chooseTargetNeuronFromCandidates(
        baselineJSON,
        selectionSamples,
        leakyCandidateUUIDs,
        (processed, total) => {
          if (
            processed === total ||
            processed <= 5 ||
            processed % 50 === 0
          ) {
            console.info(
              `  • LeakyReLU selection progress: ${
                processed.toLocaleString("en-AU")
              } / ${total.toLocaleString("en-AU")}`,
            );
          }
        },
      );
      if (
        selection && selection.meanSquaredError < MIN_TARGET_ERROR
      ) {
        console.warn(
          yellow(
            `Selected LeakyReLU neuron yielded mse ${
              selection.meanSquaredError.toFixed(6)
            }, below threshold ${MIN_TARGET_ERROR}. Falling back to global search.`,
          ),
        );
        selection = null;
      }
    }

    if (!selection) {
      selectionSource = "global";
      console.info(
        yellow(
          `Selecting target neuron across ${
            baselineJSON.neurons.filter((n) => n.type === "hidden").length
              .toLocaleString("en-AU")
          } hidden neurons (this may take ~1 minute)...`,
        ),
      );
      selection = chooseTargetNeuron(
        baselineJSON,
        selectionSamples,
        (processed, total) => {
          if (
            processed === total ||
            processed <= 5 ||
            processed % 100 === 0
          ) {
            console.info(
              `  • Target selection progress: ${
                processed.toLocaleString("en-AU")
              } / ${total.toLocaleString("en-AU")} hidden neurons`,
            );
          }
        },
      );
    }

    cachedTarget = {
      baselineHash,
      targetNeuronUUID: selection.uuid,
      meanSquaredError: selection.meanSquaredError,
      sampleCount: TARGET_SELECTION_SAMPLE_SIZE,
      updatedAt: new Date().toISOString(),
    };
    await saveCachedTarget(cachedTarget);
  }

  const targetNeuronUUID = cachedTarget.targetNeuronUUID;
  const focusedInputIndices = computeFocusedInputIndices(
    baselineJSON,
    targetNeuronUUID,
  );
  const downstreamTargets = collectDownstreamTargets(
    baselineJSON,
    targetNeuronUUID,
  );
  let targetSampleError = cachedTarget.meanSquaredError;
  if (focusedInputIndices.size > 0) {
    const shapedRandom = createDeterministicRandom(
      SYNTHETIC_CONFIG.seed + 1,
    );
    const shapedSamples = generateTargetSelectionSamples(
      referenceCreature,
      TARGET_SELECTION_SAMPLE_SIZE,
      shapedRandom,
      focusedInputIndices,
    );
    targetSampleError = evaluateCrippledNeuronError(
      baselineJSON,
      shapedSamples,
      targetNeuronUUID,
    );
    cachedTarget.meanSquaredError = targetSampleError;
  }
  if (accentuateTargetPath(baselineJSON, targetNeuronUUID, downstreamTargets)) {
    referenceCreature = Creature.fromJSON(baselineJSON);
    referenceCreature.validate();
    CreatureUtil.makeUUID(referenceCreature);
    baselineHash = await computeBaselineHash(baselineJSON);
    console.info(
      `Accentuated downstream neuron(s) for ${targetNeuronUUID} to highlight the missing path.`,
    );
  }
  const selectedBaselineNeuron = baselineJSON.neurons.find((neuron) =>
    neuron.uuid === targetNeuronUUID
  );
  const selectionPrefix = (() => {
    switch (selectionSource) {
      case "cached":
        return "cached ";
      case "env-override":
        return "environment override ";
      case "leaky":
        return "LeakyReLU ";
      case "global":
        return "global ";
      default:
        return "";
    }
  })();
  const selectionLabel = (() => {
    switch (selectionSource) {
      case "cached":
        return "cache";
      case "env-override":
        return "environment override";
      case "leaky":
        return "LeakyReLU shortlist";
      case "global":
        return "global scan";
      default:
        return selectionSource;
    }
  })();
  console.info(
    green(
      `Using ${selectionPrefix}target neuron ${targetNeuronUUID} (squash: ${
        selectedBaselineNeuron?.squash ?? "unknown"
      }, sample mse ≈ ${
        targetSampleError.toFixed(6)
      }, source: ${selectionLabel}).`,
    ),
  );
  const forcedFocusNeurons = computeForcedFocusNeurons(
    baselineJSON,
    targetNeuronUUID,
  );
  if (focusedInputIndices.size > 0) {
    const focusedSummary = [...focusedInputIndices].sort((a, b) => a - b)
      .map((idx) => `input-${idx}`);
    console.info(
      `Focused synthetic inputs: ${
        focusedSummary.join(", ")
      } (scaled by ${FOCUSED_INPUT_SCALE}×).`,
    );
  } else {
    console.info(
      "No direct input drivers found; using uniform synthetic inputs.",
    );
  }

  console.info(
    `Target neuron selected for removal: ${targetNeuronUUID} (sample mse ≈ ${
      targetSampleError.toFixed(6)
    })`,
  );

  stage("Stage 2/4: Generating synthetic training data");
  console.info(
    yellow(
      "Discovery recording/analysis timeouts start AFTER this data preparation completes.",
    ),
  );
  const dataStart = performance.now();
  referenceCreature.clearState();
  await generateSyntheticDataset(
    referenceCreature,
    SYNTHETIC_CONFIG,
    focusedInputIndices,
  );
  console.info(
    green(
      `Synthetic dataset ready in ${
        formatSeconds((performance.now() - dataStart) / 1000)
      }.`,
    ),
  );

  console.info("Saving baseline creature snapshot...");
  const baselinePath = await saveCreature(referenceCreature, "baseline.json");

  stage("Stage 3/4: Creating crippled creature");
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
  const focusSummary = effectiveFocusNeurons.length > 0
    ? yellow(effectiveFocusNeurons.join(", "))
    : yellow("none (weighted selection fallback)");
  console.info(`Forced focus neurons (directly impacted): ${focusSummary}`);
  const crippledPath = await saveCreature(
    crippledCreature,
    "crippled.json",
  );

  const discoveryMaxNeurons = effectiveFocusNeurons.length > 0
    ? 1
    : MAX_FORCED_FOCUS;
  const discoveryOptions: NeatOptions = {
    verbose: true,
    log: 1,
    disableRandomSamples: true,
    costOfGrowth: DISCOVERY_COST_OF_GROWTH,
    discoverySampleRate: 0.5,
    discoveryBatchSize: 8,
    discoveryTimeOutMinutes: DISCOVERY_RECORDING_TIMEOUT_MINUTES,
    discoveryAnalysisTimeoutMinutes: DISCOVERY_ANALYSIS_TIMEOUT_MINUTES,
    discoveryMinImprovementPercentage: DISCOVERY_MIN_IMPROVEMENT_PERCENTAGE,
    discoveryRustFlushRecords: 16,
    discoveryMaxNeurons,
    discoveryDrainEveryNBatches: 32,
    discoveryFocusNeuronUUIDs: effectiveFocusNeurons,
  };

  stage("Stage 4/4: Running discovery (timeouts active)");
  console.info(
    bold(
      `Discovery configuration: sampleRate=${discoveryOptions.discoverySampleRate}, batchSize=${discoveryOptions.discoveryBatchSize}, timeout=${discoveryOptions.discoveryTimeOutMinutes}m, analysisTimeout=${discoveryOptions.discoveryAnalysisTimeoutMinutes}m`,
    ),
  );
  console.info(
    cyan(
      `Discovery data dir: ${DATA_DIR} (records=${SYNTHETIC_CONFIG.totalRecords}, sampleRate=${discoveryOptions.discoverySampleRate})`,
    ),
  );
  console.info(
    yellow(
      "Recording timeout applies now (≈1 minute) followed by a 1-minute analysis window. Total discovery runtime should stay under ~2 minutes.",
    ),
  );

  console.info("Running discovery...");
  const discoveryStart = performance.now();
  const discoveryResult = await crippledCreature.discoveryDir(
    DATA_DIR,
    discoveryOptions,
  );
  const discoveryDurationSeconds = (performance.now() - discoveryStart) / 1000;
  const discoveryDurationRounded = discoveryDurationSeconds.toFixed(1);
  const configuredWindowSeconds = ((discoveryOptions.discoveryTimeOutMinutes ??
    0) + (discoveryOptions.discoveryAnalysisTimeoutMinutes ?? 0)) * 60;
  const slackSeconds = 60;
  if (discoveryDurationSeconds > configuredWindowSeconds + slackSeconds) {
    console.warn(
      red(
        `Discovery exceeded configured ${
          configuredWindowSeconds / 60
        } minute window by ${
          (discoveryDurationSeconds - configuredWindowSeconds).toFixed(1)
        }s (${discoveryDurationRounded}s total).`,
      ),
    );
    Deno.exit(1);
  } else if (discoveryDurationSeconds > configuredWindowSeconds) {
    console.warn(
      yellow(
        `Discovery slightly exceeded configured window by ${
          (discoveryDurationSeconds - configuredWindowSeconds).toFixed(1)
        }s.`,
      ),
    );
  } else {
    console.info(
      `Discovery finished in ${green(discoveryDurationRounded)} seconds.`,
    );
  }

  const improvement = discoveryResult.improvement;
  if (!improvement) {
    console.error(
      "Discovery completed without producing an improved creature. Exiting with failure.",
    );
    Deno.exit(1);
  }

  const improvedCreature = Creature.fromJSON(improvement.creature);
  const discoveryPath = await saveCreature(
    improvedCreature,
    "discovered.json",
  );

  const crippledNeurons = new Set(
    crippledCreature.neurons.map((neuron) => neuron.uuid),
  );
  const improvedJSON = improvedCreature.exportJSON();
  const newlyAddedHidden = improvedJSON.neurons.filter((neuron) =>
    neuron.type === "hidden" && !crippledNeurons.has(neuron.uuid)
  );
  const baselineTarget = baselineJSON.neurons.find((neuron) =>
    neuron.uuid === targetNeuronUUID
  );
  const matchingNeuron = newlyAddedHidden.find((neuron) => {
    return improvedJSON.synapses.some((synapse) =>
      synapse.fromUUID === neuron.uuid &&
      downstreamTargets.has(synapse.toUUID)
    );
  });

  if (matchingNeuron) {
    console.info(
      green(
        `✅ Discovered neuron '${matchingNeuron.uuid}' (${matchingNeuron.squash}) feeds the same downstream targets as removed ${baselineTarget?.squash} neuron ${targetNeuronUUID}.`,
      ),
    );
  } else {
    console.error(
      red(
        "❌ Discovery completed but the missing neuron was not reconstructed. Please rerun with more generous timeouts.",
      ),
    );
    Deno.exit(1);
  }

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
