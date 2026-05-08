/**
 * Tests for issue #178 — acronyms must be spelled out (or linked to a
 * definition) the first time they appear on a page. The audience is
 * people who are learning, so we should not assume they know what
 * "MLP", "SGD", "NEAT" or similar mean.
 *
 * The test enforces a weaker but objective property: for every README
 * in the repository, every acronym from the curated glossary that
 * appears in the file must also have its plain-English expansion
 * present somewhere in the same file. Authors are expected to put the
 * expansion at the first use, but the test is content-only — it does
 * not police order so that the rule remains a simple "what" check on
 * the document rather than a brittle proximity scan.
 */

import { assert } from "@std/assert";

/**
 * Acronyms whose expansion (case-insensitive) must appear in any
 * README that uses them. Keep entries focused on terms a beginner
 * would not be expected to know — common web/file acronyms (HTML,
 * JSON, SVG, CSS) are intentionally excluded because expanding them
 * everywhere would harm readability.
 */
const GLOSSARY: Record<string, readonly string[]> = {
  NEAT: ["NeuroEvolution of Augmenting Topologies"],
  MNIST: ["Modified National Institute of Standards and Technology"],
  XOR: ["exclusive OR", "exclusive-or"],
  MLP: ["multi-layer perceptron", "multilayer perceptron"],
  SGD: ["stochastic gradient descent"],
  MCMC: ["Markov chain Monte Carlo"],
  MH: ["Metropolis-Hastings"],
  PRNG: ["pseudorandom number generator", "pseudo-random number generator"],
  FFI: ["Foreign Function Interface"],
  WASM: ["WebAssembly"],
  RL: ["reinforcement learning"],
  CTRNN: ["continuous-time recurrent neural network"],
  BCE: ["binary cross-entropy"],
  RCS: ["reaction control system"],
};

const READMES = [
  "README.md",
  "adaptive_mutation/README.md",
  "cart_pole/README.md",
  "crispr_injection/README.md",
  "crossover/README.md",
  "discovery/README.md",
  "discovery_at_scale/README.md",
  "evolution_showcase/README.md",
  "intelligent_design/README.md",
  "lunar_lander/README.md",
  "maze_navigation/README.md",
  "mcmc_acceptance/README.md",
  "memetic_evolution/README.md",
  "mnist_classification/README.md",
  "mountain_car/README.md",
  "neuron_pruning/README.md",
  "snake_game/README.md",
  "stock_market/README.md",
  "suggest_improvements/README.md",
  "synthetic_synapse/README.md",
  "xor_classification/README.md",
] as const;

/**
 * Strip fenced code blocks and inline code spans so an acronym that
 * appears only inside a code identifier (e.g. `evolveMLPClassifier`)
 * does not trigger the glossary requirement.
 */
function stripCode(markdown: string): string {
  // Remove fenced code blocks first (greedy across lines)
  const fenceless = markdown.replace(/```[\s\S]*?```/g, " ");
  // Then inline code spans
  return fenceless.replace(/`[^`]*`/g, " ");
}

/** Match the acronym only as a standalone token (so MNIST doesn't fire on "MNIST_NEAT"). */
function usesAcronym(text: string, acronym: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${acronym}(?![A-Za-z0-9_])`);
  return re.test(text);
}

function containsExpansion(text: string, expansions: readonly string[]): boolean {
  // Strip Markdown blockquote prefixes (`> `) at the start of any line and
  // then collapse all runs of whitespace to a single space so an expansion
  // that wraps across two lines in the source still matches.
  const unquoted = text.replace(/^[ \t]*>+[ \t]?/gm, "");
  const flattened = unquoted.replace(/\s+/g, " ").toLowerCase();
  return expansions.some((e) => flattened.includes(e.toLowerCase()));
}

for (const path of READMES) {
  Deno.test(`README ${path} expands every glossary acronym it uses`, async () => {
    const markdown = await Deno.readTextFile(path);
    const prose = stripCode(markdown);

    const missing: string[] = [];
    for (const [acronym, expansions] of Object.entries(GLOSSARY)) {
      if (!usesAcronym(prose, acronym)) continue;
      if (!containsExpansion(prose, expansions)) {
        missing.push(`${acronym} (expected one of: ${expansions.join(" | ")})`);
      }
    }

    assert(
      missing.length === 0,
      `${path} uses these acronyms without spelling them out:\n  - ${missing.join("\n  - ")}`,
    );
  });
}
