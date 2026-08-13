/**
 * Print hold-out validation/test accuracy for a creature JSON path.
 *
 * Usage:
 *   deno run -A scripts/mnist_holdout_score.ts <creature.json>
 *   deno run -A scripts/mnist_holdout_score.ts --compare <before.json> <after.json>
 *
 * Always emits exactly one JSON object on stdout (last line). The neat-ai
 * version banner may still appear earlier; consumers must parse the JSON line.
 */

import { Creature } from "@stsoftware/neat-ai";

import {
  evaluateOnHoldout,
  loadMnistDigitSplit,
} from "../mnist_classification/exploration_campaign.ts";

const { split } = await loadMnistDigitSplit();

function scorePath(path: string) {
  const creature = Creature.fromJSON(JSON.parse(Deno.readTextFileSync(path)));
  const holdout = evaluateOnHoldout(creature, split);
  return {
    path,
    testAccuracy: holdout.testAccuracy,
    validationAccuracy: holdout.validationAccuracy,
    neurons: creature.neurons.length,
    synapses: creature.synapses.length,
  };
}

if (Deno.args[0] === "--compare") {
  const beforePath = Deno.args[1];
  const afterPath = Deno.args[2];
  if (!beforePath || !afterPath) {
    console.error("usage: --compare <before.json> <after.json>");
    Deno.exit(1);
  }
  const before = scorePath(beforePath);
  const after = scorePath(afterPath);
  const improved = after.testAccuracy > before.testAccuracy + 1e-9;
  console.log(JSON.stringify({ before, after, improved }));
  Deno.exit(improved ? 0 : 1);
}

const path = Deno.args[0];
if (!path) {
  console.error("usage: mnist_holdout_score.ts <creature.json>");
  Deno.exit(1);
}
console.log(JSON.stringify(scorePath(path)));
