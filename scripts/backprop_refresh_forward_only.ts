/**
 * One-shot helper: prepare XOR training data, then regenerate prediction
 * screenshots for forward-only examples after NEAT-AI-Backpropagation
 * has written an improved champion into docs/data/<slug>/creature.json.
 *
 * Usage:
 *   deno run -A scripts/backprop_refresh_forward_only.ts prepare-xor
 *   deno run -A scripts/backprop_refresh_forward_only.ts render-xor
 *   deno run -A scripts/backprop_refresh_forward_only.ts render-stock
 */

import { ensureDirSync } from "@std/fs";
import { Creature } from "@stsoftware/neat-ai";

import { fetchDataset } from "../common/data_cache.ts";
import { loadMultiRunState } from "../common/multi_run_state.ts";
import {
  buildSamples,
  computeNormalizationStats,
  type DataSplit,
  type NormalizationStats,
  normalizeSamples,
  splitChronologically,
} from "../stock_market/data.ts";
import {
  balancedDirectionalAccuracy,
  classifyGlyph,
  cumulativeStrategyReturn,
  DATASET_PATH,
  DATASET_SHA256,
  DATASET_URL,
  directionalAccuracy,
  loadPrices,
  replayController,
  SCREENSHOT_PATH as STOCK_SCREENSHOT_PATH,
  WINDOW_SIZE,
  writeStockTrainingDataset,
} from "../stock_market/stock_market.ts";
import { renderChartSVG } from "../stock_market/svg.ts";
import {
  correctCount,
  DECISION_BOUNDARY_GRID,
  meanSquaredError,
  SCREENSHOT_PATH as XOR_SCREENSHOT_PATH,
  writeXorDataset,
  xorSamples,
} from "../xor_classification/xor_classification.ts";
import { renderDecisionBoundarySVG } from "../xor_classification/svg.ts";

async function prepareXor(): Promise<void> {
  const path = writeXorDataset(".synthetic-xor/data");
  console.log(`wrote ${path}`);
}

async function renderXor(): Promise<void> {
  const state = await loadMultiRunState("xor_classification");
  if (state.creatureExport === undefined) {
    throw new Error("missing docs/data/xor_classification/creature.json");
  }
  const creature = Creature.fromJSON(state.creatureExport);
  const svg = renderDecisionBoundarySVG(creature, {
    gridResolution: DECISION_BOUNDARY_GRID,
    samples: xorSamples(),
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(XOR_SCREENSHOT_PATH, svg);
  console.log(
    `xor mse=${meanSquaredError(creature).toFixed(6)} correct=${correctCount(creature)}/4`,
  );
  console.log(`wrote ${XOR_SCREENSHOT_PATH}`);
}

async function prepareStock(): Promise<void> {
  await fetchDataset({
    url: DATASET_URL,
    path: DATASET_PATH,
    sha256: DATASET_SHA256,
  });
  const prices = await loadPrices(DATASET_PATH);
  const samples = buildSamples(prices, { windowSize: WINDOW_SIZE });
  const split: DataSplit = splitChronologically(samples, {
    trainFraction: 0.7,
    validationFraction: 0.15,
  });
  const normStats: NormalizationStats = computeNormalizationStats(split.train);
  const normTrain = normalizeSamples(split.train, normStats);
  const trainBin = writeStockTrainingDataset(normTrain, ".synthetic-stock/data");
  ensureDirSync(".synthetic-stock/creatures");
  await Deno.writeTextFile(
    ".synthetic-stock/creatures/normalization.json",
    JSON.stringify(normStats, null, 2),
  );
  console.log(`wrote ${trainBin} (${normTrain.length} records)`);
}

async function renderStock(): Promise<void> {
  const state = await loadMultiRunState("stock_market");
  if (state.creatureExport === undefined) {
    throw new Error("missing docs/data/stock_market/creature.json");
  }
  await fetchDataset({
    url: DATASET_URL,
    path: DATASET_PATH,
    sha256: DATASET_SHA256,
  });
  const prices = await loadPrices(DATASET_PATH);
  const samples = buildSamples(prices, { windowSize: WINDOW_SIZE });
  const split: DataSplit = splitChronologically(samples, {
    trainFraction: 0.7,
    validationFraction: 0.15,
  });
  const normStats: NormalizationStats = computeNormalizationStats(split.train);
  const normValidation = normalizeSamples(split.validation, normStats);
  const normTest = normalizeSamples(split.test, normStats);
  const creature = Creature.fromJSON(state.creatureExport);
  const valBalanced = balancedDirectionalAccuracy(creature, normValidation);
  const records = replayController(creature, normTest);
  const testAccuracy = records.length === 0
    ? 0
    : records.filter((r) => r.correct).length / records.length;
  const cumulativeReturn = cumulativeStrategyReturn(records);
  const svg = renderChartSVG({
    records,
    glyphFor: classifyGlyph,
    validationAccuracy: valBalanced,
    testAccuracy,
    cumulativeStrategyReturn: cumulativeReturn,
  });
  ensureDirSync("docs/screenshots");
  await Deno.writeTextFile(STOCK_SCREENSHOT_PATH, svg);
  console.log(
    `stock valBalanced=${(valBalanced * 100).toFixed(2)}% ` +
      `test=${(testAccuracy * 100).toFixed(2)}% ` +
      `return=${(cumulativeReturn * 100).toFixed(2)}% ` +
      `rawVal=${(directionalAccuracy(creature, normValidation) * 100).toFixed(2)}%`,
  );
  console.log(`wrote ${STOCK_SCREENSHOT_PATH}`);
}

const cmd = Deno.args[0];
if (cmd === "prepare-xor") {
  await prepareXor();
} else if (cmd === "render-xor") {
  await renderXor();
} else if (cmd === "prepare-stock") {
  await prepareStock();
} else if (cmd === "render-stock") {
  await renderStock();
} else {
  console.error(
    "usage: prepare-xor | render-xor | prepare-stock | render-stock",
  );
  Deno.exit(1);
}
