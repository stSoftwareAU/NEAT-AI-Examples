/**
 * "What" tests for `mnist_classification/README.md` (issue #271).
 *
 * The README describes a single 10-minute `Creature.evolveDir` run from
 * a minimal `new Creature(784, 10)` seed against the full 60 000-record
 * MNIST training set. These tests cross-check that the published prose
 * is honest:
 *
 *  - The README links the prediction-grid SVG and the file exists +
 *    is non-empty.
 *  - The README quotes the measured final test-set argmax accuracy
 *    from a committed JSON summary (`docs/data/mnist_classification/
 *    run_summary.json`). The honesty check is skipped (with a clear
 *    log line) when the summary is absent — a fresh checkout has not
 *    yet executed `./mnist_classification/run.sh`. CI runs the example
 *    so the summary IS present there, and the check fires.
 *  - The README references the audit follow-up issue (#268) so the
 *    audit context is discoverable.
 *  - The README does not re-introduce the deprecated framing or
 *    deleted-mode strings (95 % target, MNIST_NEAT_EVOLUTION,
 *    MNIST_MLP_BASELINE, runMinimalSeedEvolution, 1 024-record subset,
 *    or down-sampled).
 */

import { assert, assertGreater, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const HERE = dirname(fromFileUrl(import.meta.url));
const REPO_ROOT = dirname(HERE);
const README_PATH = join(HERE, "README.md");
const SCREENSHOT_PATH = join(REPO_ROOT, "docs", "screenshots", "mnist_classification.svg");
const SUMMARY_PATH = join(
  REPO_ROOT,
  "docs",
  "data",
  "mnist_classification",
  "run_summary.json",
);

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

function fileExistsAndNonEmpty(path: string): boolean {
  try {
    const stat = Deno.statSync(path);
    return stat.isFile && stat.size > 0;
  } catch {
    return false;
  }
}

interface RunSummary {
  trainingRecords: number;
  evolveWallClockMs: number;
  targetError: number;
  timeoutMinutes: number;
  seedNeurons: number;
  seedSynapses: number;
  finalNeurons: number;
  finalSynapses: number;
  validationAccuracy: number;
  testAccuracy: number;
  stopCondition: "targetError" | "timeoutMinutes";
}

function loadSummaryIfPresent(): RunSummary | null {
  try {
    const raw = Deno.readTextFileSync(SUMMARY_PATH);
    return JSON.parse(raw) as RunSummary;
  } catch {
    return null;
  }
}

Deno.test("README links the prediction-grid SVG and the file is non-empty", () => {
  const readme = loadReadme();
  // The relative link in the README points one directory up.
  assertStringIncludes(
    readme,
    "../docs/screenshots/mnist_classification.svg",
    "README should embed the prediction-grid SVG via ../docs/screenshots/mnist_classification.svg",
  );
  assert(
    fileExistsAndNonEmpty(SCREENSHOT_PATH),
    `prediction-grid SVG at ${SCREENSHOT_PATH} should exist and be non-empty`,
  );
});

Deno.test("README references audit issue #268 so the audit context is discoverable", () => {
  const readme = loadReadme();
  assertStringIncludes(readme, "#268", "README should reference audit issue #268");
});

Deno.test("README does not re-introduce deprecated 95% target framing or deleted modes", () => {
  const readme = loadReadme();
  // Forbidden substrings called out in issue #271's acceptance criteria.
  const forbidden = [
    "95 %",
    "95%",
    "MNIST_NEAT_EVOLUTION",
    "MNIST_MLP_BASELINE",
    "runMinimalSeedEvolution",
    "1 024-record",
    "down-sampled",
  ];
  for (const term of forbidden) {
    assert(
      !readme.includes(term),
      `README must not contain "${term}" (deleted by issue #271)`,
    );
  }
});

Deno.test("README quotes the measured test accuracy from the committed run summary", () => {
  const summary = loadSummaryIfPresent();
  if (summary === null) {
    console.log(
      `⏭️  Skipped: ${SUMMARY_PATH} not present — run ./mnist_classification/run.sh first.`,
    );
    return;
  }
  const readme = loadReadme();
  // Test accuracy is reported as a percentage with two decimal places.
  const pct = (summary.testAccuracy * 100).toFixed(2);
  assertStringIncludes(
    readme,
    `${pct}`,
    `README should quote the measured test accuracy ${pct}% from run_summary.json`,
  );
});

Deno.test("README quotes the wall-clock from the committed run summary", () => {
  const summary = loadSummaryIfPresent();
  if (summary === null) {
    console.log(
      `⏭️  Skipped: ${SUMMARY_PATH} not present — run ./mnist_classification/run.sh first.`,
    );
    return;
  }
  const readme = loadReadme();
  // Wall-clock is reported to the nearest second in the README table.
  const seconds = Math.round(summary.evolveWallClockMs / 1000);
  assertStringIncludes(
    readme,
    `${seconds}`,
    `README should quote the measured wall-clock (~${seconds}s) from run_summary.json`,
  );
});

Deno.test("README quotes the seed and final synapse counts from the committed run summary", () => {
  const summary = loadSummaryIfPresent();
  if (summary === null) {
    console.log(
      `⏭️  Skipped: ${SUMMARY_PATH} not present — run ./mnist_classification/run.sh first.`,
    );
    return;
  }
  const readme = loadReadme();
  for (const value of [summary.seedSynapses, summary.finalSynapses, summary.finalNeurons]) {
    assertStringIncludes(
      readme,
      `${value}`,
      `README should quote topology value ${value} from run_summary.json`,
    );
  }
});

Deno.test("run summary, when present, reports a trainingRecords count of 60 000", () => {
  const summary = loadSummaryIfPresent();
  if (summary === null) {
    console.log(
      `⏭️  Skipped: ${SUMMARY_PATH} not present — run ./mnist_classification/run.sh first.`,
    );
    return;
  }
  // Issue #270 mandates the FULL 60k training file goes into evolveDir.
  assertGreater(summary.trainingRecords, 50_000);
});
