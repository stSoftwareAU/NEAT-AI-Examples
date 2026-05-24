/**
 * CLI entry point for the GRQ-style exploration campaign (issue #476).
 *
 * Usage (typically via `stock_market/exploration_campaign.sh`):
 *
 *     deno run ... exploration_campaign_cli.ts [--promote] [--squash-scan]
 *                                              [--squash-target=GELU]
 *                                              [--fast]
 *                                              [--working-dir=PATH]
 *                                              [--promote-dir=PATH]
 *
 * The working directory defaults to {@link DEFAULT_WORKING_DIR} (hidden,
 * gitignored). The promote target defaults to {@link DEFAULT_PROMOTE_DIR}
 * under `docs/data/` and is only written when `--promote` is supplied.
 *
 * `--fast` swaps the default phase schedule for a tiny set so a local
 * smoke test finishes inside a minute.
 */
import { parseArgs } from "@std/cli";
import { format } from "@std/fmt/duration";

import { buildSamples, splitChronologically } from "./data.ts";
import { fetchDataset } from "../common/data_cache.ts";
import {
  DATASET_PATH,
  DATASET_SHA256,
  DATASET_URL,
  loadPrices,
  WINDOW_SIZE,
} from "./stock_market.ts";
import {
  DEFAULT_PROMOTE_DIR,
  DEFAULT_WORKING_DIR,
  type ExplorationPhase,
  promoteExplorationArtefacts,
  runExplorationCampaign,
} from "./exploration_campaign.ts";

/** Tiny phase schedule used by `--fast`. */
const FAST_PHASES: ExplorationPhase[] = [
  {
    name: "structure-fast",
    trainingSampleRate: 0.1,
    costOfGrowth: 0.000001,
    maxGenerations: 5,
    timeoutMinutes: 1,
  },
  {
    name: "polish-fast",
    trainingSampleRate: 1,
    costOfGrowth: 0,
    maxGenerations: 5,
    timeoutMinutes: 1,
  },
];

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    boolean: ["promote", "squash-scan", "fast"],
    string: ["squash-target", "working-dir", "promote-dir"],
    default: {
      "squash-target": "GELU",
      "working-dir": DEFAULT_WORKING_DIR,
      "promote-dir": DEFAULT_PROMOTE_DIR,
    },
  });

  const workingDir = String(args["working-dir"]);
  const promoteDir = String(args["promote-dir"]);

  console.log("🧬 Stock Market — GRQ-style exploration campaign (issue #476)");
  console.log(`   working dir : ${workingDir}`);
  console.log(`   promote     : ${args.promote ? promoteDir : "(disabled — pass --promote)"}`);
  console.log(`   squash scan : ${args["squash-scan"] ? args["squash-target"] : "off"}`);
  console.log(`   fast mode   : ${args.fast ? "yes" : "no"}`);

  // Load the public S&P 500 dataset (cached on first run).
  await fetchDataset({
    url: DATASET_URL,
    path: DATASET_PATH,
    sha256: DATASET_SHA256,
  });
  const prices = await loadPrices(DATASET_PATH);
  console.log(
    `   prices      : ${prices.length} points (${prices[0].date} → ` +
      `${prices[prices.length - 1].date})`,
  );

  const samples = buildSamples(prices, { windowSize: WINDOW_SIZE });
  const split = splitChronologically(samples, {
    trainFraction: 0.7,
    validationFraction: 0.15,
  });
  console.log(
    `   split       : train=${split.train.length} val=${split.validation.length} ` +
      `test=${split.test.length}`,
  );

  const started = Date.now();
  const result = await runExplorationCampaign({
    split,
    windowSize: WINDOW_SIZE,
    workingDir,
    seed: 24601,
    populationSize: args.fast ? 6 : 30,
    phases: args.fast ? FAST_PHASES : undefined,
    squashScan: args["squash-scan"] === true,
    squashScanTarget: String(args["squash-target"]),
  });

  console.log("\n=== Campaign summary ===");
  for (let i = 0; i < result.summary.phases.length; i++) {
    const phase = result.summary.phases[i];
    console.log(
      `  ${i + 1}. ${phase.name.padEnd(20)} gens=${phase.generations.toString().padStart(4)} ` +
        `err=${phase.trainError.toPrecision(4)} ` +
        `neurons=${phase.finalNeurons} synapses=${phase.finalSynapses} | ` +
        `train=${(phase.trainBalanced * 100).toFixed(1)}% ` +
        `val=${(phase.validationBalanced * 100).toFixed(1)}% ` +
        `test=${(phase.testBalanced * 100).toFixed(1)}% (balanced)`,
    );
  }
  if (result.summary.squashScan) {
    const s = result.summary.squashScan;
    console.log(
      `  squash      tested=${s.tested} improved=${s.improved} applied=${s.applied} ` +
        `baseline=${s.baselineScore.toPrecision(4)} -> ` +
        `${s.improvedScore === null ? "n/a" : s.improvedScore.toPrecision(4)}`,
    );
  }

  if (args.promote) {
    const promoted = await promoteExplorationArtefacts({ workingDir, promoteDir });
    console.log(
      promoted
        ? `🚚 Promoted champion + summary to ${promoteDir}`
        : `⚠️  Nothing promoted — ${workingDir} is missing champion or summary`,
    );
  } else {
    console.log(
      "ℹ️  Run again with --promote to copy champion + summary into " +
        `${promoteDir}`,
    );
  }

  console.log(
    `\n🏁 Completed in ${format(Date.now() - started, { ignoreZero: true })}`,
  );
}
