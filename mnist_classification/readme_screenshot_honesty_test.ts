/**
 * Tests for the MNIST README's honesty about which run produced the
 * embedded `evolution.svg` screenshot (issue #191).
 *
 * The reporter pointed out that the README narrates a long-form NEAT
 * evolution from uniform-random noise (hours of wall-clock, up to
 * `MAX_GENERATIONS` = 50 000 generations) but the embedded chart shows
 * the MLP/SGD baseline crossing 95 % in ~10 epochs with constant
 * neuron and synapse counts. That is misleading — the chart is from
 * the **MLP baseline** run that `quality.sh` executes by default, not
 * from the NEAT evolution.
 *
 * These are "what" tests — they read the README markdown and the
 * actual SVG title and assert the README's caption and surrounding
 * prose match the chart that is actually embedded.
 */

import { assert, assertStringIncludes } from "@std/assert";

const README_PATH = "mnist_classification/README.md";
const EVOLUTION_SVG_PATH = "docs/screenshots/mnist_classification/evolution.svg";

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/** Pull the markdown image line that references the evolution chart. */
function findEvolutionChartImageLine(readme: string): string {
  const lines = readme.split("\n");
  const match = lines.find((line) =>
    line.includes("![") && line.includes("mnist_classification/evolution.svg")
  );
  assert(
    match !== undefined,
    `README must embed the evolution chart at ${EVOLUTION_SVG_PATH}`,
  );
  return match!;
}

/** Pull the `<title>…</title>` from the SVG. */
function loadSvgTitle(): string {
  const svg = Deno.readTextFileSync(EVOLUTION_SVG_PATH);
  const m = svg.match(/<title>([^<]+)<\/title>/);
  assert(m !== null, `${EVOLUTION_SVG_PATH} must have a <title> element`);
  return m![1];
}

Deno.test("MNIST README chart caption identifies the MLP baseline run", () => {
  // The chart embedded in the README is produced by the MLP baseline
  // (the default `quality.sh` mode); its <title> says so. The README
  // caption must agree — saying "MLP baseline" — so a reader does not
  // mistake a 10-epoch fixed-topology MLP curve for a 50 000-generation
  // NEAT-from-noise evolution.
  const line = findEvolutionChartImageLine(loadReadme()).toLowerCase();
  assertStringIncludes(
    line,
    "mlp baseline",
    "evolution chart caption must identify the screenshot as the MLP baseline run",
  );
});

Deno.test("MNIST README chart caption matches the actual SVG <title>", () => {
  // The reporter's worry is that the chart's narrative (10 generations,
  // constant neuron/synapse count) does not match the README's narrative
  // (hours, 50 000 generations, growing topology). The simplest defence
  // is to require the caption to repeat the SVG's own title verbatim.
  const svgTitle = loadSvgTitle().toLowerCase();
  const line = findEvolutionChartImageLine(loadReadme()).toLowerCase();
  assertStringIncludes(
    line,
    svgTitle,
    `evolution chart caption must include the SVG's own <title> ("${svgTitle}")`,
  );
});

Deno.test("MNIST README explains the embedded chart is NOT from the NEAT run", () => {
  // Somewhere in the README the reader needs an explicit statement that
  // the embedded screenshot comes from the MLP baseline, not from the
  // NEAT-from-noise evolution. Phrase it any way you like, but the two
  // ideas must appear together in a single paragraph so the disclaimer
  // is unmissable.
  const readme = loadReadme().toLowerCase();
  const paragraphs = readme.split(/\n\s*\n/);
  const disclaimer = paragraphs.find((p) =>
    p.includes("evolution.svg") &&
    p.includes("mlp baseline") &&
    (p.includes("not") && (p.includes("neat run") || p.includes("neat evolution") ||
      p.includes("neat-from-noise")))
  );
  assert(
    disclaimer !== undefined,
    "README must contain a paragraph that names evolution.svg, identifies it as the MLP baseline, and states it is NOT the NEAT evolution",
  );
});

Deno.test("MNIST README explains why MLP neuron/synapse counts are constant", () => {
  // The reporter saw a flat neuron/synapse line on the chart and read
  // it as "you cheated — you guessed the right number". That is true
  // for the MLP baseline (it is a hand-prescribed 196 → 64 → 10 MLP),
  // but the README must say so explicitly so no reader is misled. The
  // word "constant" or "fixed" must appear near the words "neuron" and
  // "synapse" in the same paragraph that mentions the MLP baseline.
  const readme = loadReadme().toLowerCase();
  const paragraphs = readme.split(/\n\s*\n/);
  const para = paragraphs.find((p) =>
    p.includes("mlp baseline") &&
    (p.includes("constant") || p.includes("fixed") || p.includes("hand-prescribed")) &&
    p.includes("neuron") && p.includes("synapse")
  );
  assert(
    para !== undefined,
    "README must explain that the MLP baseline's neuron/synapse counts are constant by design (fixed topology), not a NEAT cheat",
  );
});
