/**
 * Regenerate checked-in MNIST docs artefacts from persisted champion +
 * milestone history — no evolution.
 */

import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import { Creature } from "@stsoftware/neat-ai";

import { loadMultiRunState } from "../common/multi_run_state.ts";
import { evaluateOnHoldout, loadMnistDigitSplit } from "./exploration_campaign.ts";
import { buildGridCells, EXAMPLE_SLUG, SCREENSHOT_PATH } from "./mnist_classification.ts";
import { renderMnistRecordedCharts } from "./recorded_evolution.ts";
import { renderDigitGridSVG } from "./svg.ts";

if (import.meta.main) {
  const state = await loadMultiRunState(EXAMPLE_SLUG);
  if (state.creatureExport === undefined) {
    throw new Error(
      "No champion in docs/data/mnist_classification/creature.json — run evolution first.",
    );
  }

  console.log("🖼️  Regenerating MNIST docs artefacts from persisted champion + milestones…");
  const { split } = await loadMnistDigitSplit();
  const creature = Creature.fromJSON(state.creatureExport);
  const holdout = evaluateOnHoldout(creature, split);

  await renderMnistRecordedCharts();
  const cells = buildGridCells(creature, split.test, 3);
  const gridSvg = renderDigitGridSVG({
    cells,
    accuracy: holdout.testAccuracy,
    validationAccuracy: holdout.validationAccuracy,
  });
  ensureDirSync(join("docs", "screenshots"));
  await Deno.writeTextFile(SCREENSHOT_PATH, gridSvg);

  console.log(
    `   Hold-out: test=${(holdout.testAccuracy * 100).toFixed(2)}% ` +
      `val=${(holdout.validationAccuracy * 100).toFixed(2)}% ` +
      `(${creature.neurons.length}n / ${creature.synapses.length}s)`,
  );
  console.log(`   Wrote ${SCREENSHOT_PATH}`);
  console.log(
    "   Wrote docs/screenshots/mnist_classification/{milestones,complexity,timeline}.svg",
  );
}
