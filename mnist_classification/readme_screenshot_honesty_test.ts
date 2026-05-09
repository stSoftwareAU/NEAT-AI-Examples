/**
 * Tests for the MNIST README's honesty about the latest measured run
 * (issue #210 — supersedes #191).
 *
 * The pre-audit README (#191 era) embedded the MLP-baseline chart while
 * narrating a long-form NEAT evolution; the audit (#210) reframes the
 * example so the published evolution genuinely runs `Creature.evolveDir`
 * over a binary `.bin` training subset from a minimal seed
 * `new Creature(196, 10)`. The README must therefore:
 *
 *   1. Embed the audit's two telemetry SVGs (`fitness.svg`,
 *      `topology.svg`) — not the legacy `evolution.svg`.
 *   2. Link the per-generation CSV at the audit-mandated path.
 *   3. Quote measured numbers (final best fitness, total generations,
 *      wall-clock) consistent with the committed CSV.
 *   4. Show non-trivial neuron / synapse change between the gen-1 row
 *      and the final row of the committed CSV.
 *
 * These are "what" tests — they read the README markdown and the
 * committed CSV and assert on the observable contents.
 */

import { assert, assertGreater, assertStringIncludes } from "@std/assert";

const README_PATH = "mnist_classification/README.md";
const FITNESS_SVG_PATH = "docs/screenshots/mnist_classification/fitness.svg";
const TOPOLOGY_SVG_PATH = "docs/screenshots/mnist_classification/topology.svg";
const CSV_PATH = "docs/data/mnist_classification/evolution.csv";

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

function loadCsvRows(): { header: string; rows: string[][] } {
  const text = Deno.readTextFileSync(CSV_PATH);
  const lines = text.trim().split("\n");
  const header = lines[0];
  const rows = lines.slice(1).map((l) => l.split(","));
  return { header, rows };
}

Deno.test("MNIST README embeds the audit fitness SVG", () => {
  const readme = loadReadme();
  assertStringIncludes(
    readme,
    "mnist_classification/fitness.svg",
    `README must embed the audit best-vs-mean fitness chart at ${FITNESS_SVG_PATH}`,
  );
  // The file must actually exist on disk so the link is not broken.
  const stat = Deno.statSync(FITNESS_SVG_PATH);
  assertGreater(stat.size, 0, `${FITNESS_SVG_PATH} must be a non-empty SVG`);
});

Deno.test("MNIST README embeds the audit topology SVG", () => {
  const readme = loadReadme();
  assertStringIncludes(
    readme,
    "mnist_classification/topology.svg",
    `README must embed the audit neuron/synapse chart at ${TOPOLOGY_SVG_PATH}`,
  );
  const stat = Deno.statSync(TOPOLOGY_SVG_PATH);
  assertGreater(stat.size, 0, `${TOPOLOGY_SVG_PATH} must be a non-empty SVG`);
});

Deno.test("MNIST README links the per-generation CSV at the audit path", () => {
  const readme = loadReadme();
  assertStringIncludes(
    readme,
    "docs/data/mnist_classification/evolution.csv",
    "README must link the per-generation CSV at the audit-mandated path",
  );
  const stat = Deno.statSync(CSV_PATH);
  assertGreater(stat.size, 0, `${CSV_PATH} must be a non-empty CSV`);
});

Deno.test("MNIST audit CSV header matches the schema mandated by issue #210", () => {
  const { header } = loadCsvRows();
  assert(
    header === "generation,best_fitness,mean_fitness,neuron_count,synapse_count",
    `CSV header must be the audit schema, got "${header}"`,
  );
});

Deno.test(
  "MNIST audit CSV shows non-trivial neuron/synapse change between gen-1 and final",
  () => {
    const { rows } = loadCsvRows();
    assertGreater(rows.length, 1, "CSV must have at least 2 rows");
    const first = rows[0];
    const last = rows[rows.length - 1];
    const firstNeurons = Number(first[3]);
    const firstSynapses = Number(first[4]);
    const lastNeurons = Number(last[3]);
    const lastSynapses = Number(last[4]);
    // Audit acceptance criterion: "Neuron and synapse counts genuinely
    // change between generation 0 and the final generation." Either the
    // neuron count or the synapse count must differ — flatlining means
    // the seed memorised the topology hint.
    const changed = firstNeurons !== lastNeurons || firstSynapses !== lastSynapses;
    assert(
      changed,
      `Topology must genuinely change across the run; got start=${firstNeurons}/${firstSynapses}` +
        ` final=${lastNeurons}/${lastSynapses}`,
    );
  },
);

Deno.test("MNIST README quotes the measured generation count from the CSV", () => {
  const { rows } = loadCsvRows();
  const finalGen = rows[rows.length - 1][0];
  const readme = loadReadme();
  // The README must mention the actual final generation number; the
  // exact phrasing is up to the author but the integer must appear.
  assertStringIncludes(
    readme,
    finalGen,
    `README must quote the final generation count from the CSV (${finalGen})`,
  );
});

Deno.test("MNIST README mentions the issue #210 audit by number", () => {
  const readme = loadReadme();
  assertStringIncludes(
    readme,
    "#210",
    "README must reference issue #210 so the audit context is discoverable",
  );
});
