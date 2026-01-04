/**
 * Intelligent Design Example: Squash Improvement Scan
 *
 * This example demonstrates how to use the NEAT-AI Intelligent Design module
 * to systematically test different activation functions (squashes) for each
 * hidden neuron in a creature to find improvements.
 *
 * The workflow:
 * 1. Load or create a reference creature
 * 2. Generate synthetic training data
 * 3. Score the baseline creature
 * 4. Scan hidden neurons, trying different squash functions
 * 5. Combine improvements and save the result
 *
 * This mirrors how a production system (e.g. at example.com/model-training)
 * would use Intelligent Design to optimise trained models.
 */

import { parseArgs } from "@std/cli";
import { format } from "@std/fmt/duration";
import { emptyDirSync, ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import {
  alternativeSquashes,
  combineImprovements,
  Creature,
  type CreatureExport,
  safeWriteJson,
  scanForSquashImprovements,
} from "@stsoftware/neat-ai";
import { addTag, getTag } from "@stsoftware/tags/mod";

const start = Date.now();

// Parse command-line arguments
const args = parseArgs(Deno.args);
const targetSquash = args.squash ?? "GELU";

console.log("🧬 Intelligent Design Squash Improvement Example");
console.log(`   Target squash: ${targetSquash}`);
console.log(`   Available squashes: ${alternativeSquashes.length}`);
console.log("");

// Set up directories (all under a hidden, gitignored folder)
const WORKING_DIR = ".synthetic-intelligent-design";
const DATA_DIR = join(WORKING_DIR, "data");
const CREATURES_DIR = join(WORKING_DIR, "creatures");
const OUTPUT_DIR = join(WORKING_DIR, "output");

ensureDirSync(DATA_DIR);
ensureDirSync(CREATURES_DIR);
emptyDirSync(OUTPUT_DIR);

// Step 1: Create or load a reference creature
console.log("📦 Step 1: Creating reference creature...");
const creature = createReferenceCreature();
const creatureExport = creature.exportJSON();

const baselinePath = join(CREATURES_DIR, "baseline.json");
await safeWriteJson(baselinePath, creatureExport);
console.log(`   Saved baseline creature to ${baselinePath}`);
console.log(
  `   Hidden neurons: ${
    creatureExport.neurons.filter((n) => n.type === "hidden").length
  }`,
);

// Step 2: Generate synthetic training data
console.log("\n📊 Step 2: Generating synthetic training data...");
generateSyntheticData(DATA_DIR, creatureExport);

// Step 3: Score the baseline creature
console.log("\n📈 Step 3: Scoring baseline creature...");
const baselineResult = creature.scoreDir(DATA_DIR, {});
const baselineScore = baselineResult.score;
addTag(creatureExport, "score", `${baselineScore}`);
addTag(creatureExport, "error", `${baselineResult.error}`);
console.log(`   Baseline score: ${baselineScore.toPrecision(6)}`);

// Step 4: Run the squash improvement scan
console.log("\n🔬 Step 4: Scanning for squash improvements...");
console.log(`   Testing: ${targetSquash}`);

const scanResult = await scanForSquashImprovements({
  creature: creatureExport,
  targetSquash: targetSquash,
  outputDir: OUTPUT_DIR,
  dataDir: DATA_DIR,
  bestScore: baselineScore,
  maxImprovements: 5, // Limit for the example
  timeoutMs: 5 * 60 * 1000, // 5 minutes for the example
  onProgress: (completed, total) => {
    if (completed % 10 === 0) {
      const percent = ((completed / total) * 100).toFixed(1);
      console.log(`   Progress: ${percent}% (${completed}/${total})`);
    }
  },
});

console.log(
  `\n✨ Scan complete in ${format(scanResult.duration, { ignoreZero: true })}`,
);
console.log(`   Tested: ${scanResult.tested} neurons`);
console.log(`   Improvements found: ${scanResult.improved}`);
if (scanResult.timedOut) {
  console.log("   ⏰ Scan was terminated due to timeout");
}

// Step 5: Combine improvements (if any)
if (scanResult.improvements.size > 0) {
  console.log("\n🧪 Step 5: Combining improvements...");

  const { creature: improvedCreature, message } = combineImprovements(
    creatureExport,
    scanResult.improvements,
    DATA_DIR,
    baselineScore,
  );

  const improvedScore = Number.parseFloat(
    getTag(improvedCreature, "score") ?? "0",
  );
  const improvement = improvedScore - baselineScore;

  console.log(`   ${message}`);
  console.log(`   Final score: ${improvedScore.toPrecision(6)}`);
  console.log(`   Improvement: ${improvement.toPrecision(3)}`);

  const improvedPath = join(CREATURES_DIR, "improved.json");
  await safeWriteJson(improvedPath, improvedCreature);
  console.log(`   Saved improved creature to ${improvedPath}`);
} else {
  console.log("\n🚫 No improvements found for this squash function.");
  console.log("   Try a different target squash or a larger creature.");
}

console.log(
  `\n🏁 Example completed in ${
    format(Date.now() - start, { ignoreZero: true })
  }`,
);

/**
 * Creates a reference creature for testing.
 *
 * In a real application, this would load a trained model from your
 * model repository (e.g. git@example.com:models/best-model.json).
 */
function createReferenceCreature(): Creature {
  // Create a simple creature with some hidden neurons
  const json: CreatureExport = {
    neurons: [
      // Input neurons
      { type: "input", squash: "LOGISTIC", index: 0, uuid: "input-0" },
      { type: "input", squash: "LOGISTIC", index: 1, uuid: "input-1" },
      { type: "input", squash: "LOGISTIC", index: 2, uuid: "input-2" },
      { type: "input", squash: "LOGISTIC", index: 3, uuid: "input-3" },

      // Hidden neurons with various squashes
      {
        type: "hidden",
        squash: "TANH",
        index: 4,
        bias: 0.1,
        uuid: "hidden-0",
      },
      {
        type: "hidden",
        squash: "LOGISTIC",
        index: 5,
        bias: -0.2,
        uuid: "hidden-1",
      },
      {
        type: "hidden",
        squash: "LeakyReLU",
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
      {
        type: "hidden",
        squash: "Swish",
        index: 8,
        bias: 0.15,
        uuid: "hidden-4",
      },

      // Output neuron
      {
        type: "output",
        squash: "LOGISTIC",
        index: 9,
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
      { from: 1, to: 8, weight: 0.5 },
      { from: 2, to: 8, weight: 0.2 },

      // Hidden to hidden (some depth)
      { from: 4, to: 6, weight: 0.3 },
      { from: 5, to: 7, weight: -0.2 },
      { from: 6, to: 8, weight: 0.4 },

      // Hidden to output
      { from: 4, to: 9, weight: 0.6 },
      { from: 5, to: 9, weight: -0.3 },
      { from: 6, to: 9, weight: 0.4 },
      { from: 7, to: 9, weight: -0.5 },
      { from: 8, to: 9, weight: 0.7 },
    ],
    input: 4,
    output: 1,
  };

  return Creature.fromJSON(json);
}

/**
 * Generates synthetic training data for testing.
 *
 * In a real application, this data would come from your training
 * data generation pipeline (e.g. example.com/data-pipeline).
 */
function generateSyntheticData(dataDir: string, _creature: CreatureExport) {
  // Generate simple binary training data
  const inputSize = 4;
  const outputSize = 1;
  const recordCount = 500;

  // Calculate record size: 4 bytes per float32
  const recordSize = (inputSize + outputSize) * 4;
  const buffer = new ArrayBuffer(recordCount * recordSize);
  const view = new DataView(buffer);

  let offset = 0;
  for (let i = 0; i < recordCount; i++) {
    // Generate random inputs
    const inputs = [];
    for (let j = 0; j < inputSize; j++) {
      const value = Math.random() * 2 - 1; // Range: -1 to 1
      inputs.push(value);
      view.setFloat32(offset, value, true); // little-endian
      offset += 4;
    }

    // Generate target output (some function of inputs)
    const target = Math.tanh(
      inputs[0] * 0.5 + inputs[1] * -0.3 + inputs[2] * 0.4 + inputs[3] * -0.2,
    );
    view.setFloat32(offset, target, true);
    offset += 4;
  }

  // Write to file
  const dataPath = join(dataDir, "synthetic.bin");
  Deno.writeFileSync(dataPath, new Uint8Array(buffer));
  console.log(`   Generated ${recordCount} records to ${dataPath}`);
}

