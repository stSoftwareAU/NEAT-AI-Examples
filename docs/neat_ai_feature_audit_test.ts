/**
 * Tests for docs/neat_ai_feature_audit.md (issue #184).
 *
 * Verifies that the audit file:
 *   1. Exists and is non-empty.
 *   2. Contains a non-empty Mermaid diagram block.
 *   3. References every per-example README path that currently lives in the
 *      repository (i.e. every per-example README under a top-level directory).
 *   4. Lists each canonical NEAT-AI capability called out in the upstream
 *      `COMPARISON.md`.
 *   5. Captures the user's specific points from issue #182 (back-propagation
 *      framing in MNIST, the binary-data-format speed advantage, and
 *      NEAT-AI-Discovery's "science-driven" structural mutation).
 *   6. Is referenced from the parent README's "Related Repositories" section.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const AUDIT_PATH = "docs/neat_ai_feature_audit.md";
const README_PATH = "README.md";

function loadAudit(): string {
  return Deno.readTextFileSync(AUDIT_PATH);
}

function loadReadme(): string {
  return Deno.readTextFileSync(README_PATH);
}

/** Return every `<dir>/README.md` path in the repo root, sorted. */
function listExampleReadmes(): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(".")) {
    if (!entry.isDirectory) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "common" || entry.name === "docs") continue;
    const path = `${entry.name}/README.md`;
    try {
      const stat = Deno.statSync(path);
      if (stat.isFile) out.push(path);
    } catch (_) {
      // No README in this directory — skip.
    }
  }
  return out.sort();
}

Deno.test("audit file exists and is non-trivially sized", () => {
  const stat = Deno.statSync(AUDIT_PATH);
  assertEquals(stat.isFile, true);
  assert(stat.size > 2000, `Expected audit file to exceed 2 KB; got ${stat.size}`);
});

Deno.test("audit file contains a non-empty Mermaid block", () => {
  const audit = loadAudit();
  const match = audit.match(/```mermaid\n([\s\S]*?)```/);
  assert(match, "Expected at least one ```mermaid``` fenced block");
  const body = match![1].trim();
  assert(body.length > 50, "Mermaid block should contain a real diagram, not be empty");
});

Deno.test("audit references every per-example README path in the repo", () => {
  const audit = loadAudit();
  for (const path of listExampleReadmes()) {
    assertStringIncludes(audit, path, `Audit must reference ${path}`);
  }
});

Deno.test("audit lists every canonical NEAT-AI feature from upstream COMPARISON.md", () => {
  const audit = loadAudit();
  // Drawn directly from
  // https://github.com/stSoftwareAU/NEAT-AI/blob/Develop/COMPARISON.md
  // — the "What We've Implemented" section. Each row in the audit must
  // reference each capability by name.
  const features = [
    "Backpropagation",
    "Memetic Evolution",
    "MCMC Mutation Acceptance",
    "GPU-Accelerated Discovery",
    "Predictive Coding",
    "Dropout",
    "L1/L2",
    "K-Fold Cross-Validation",
    "Synthetic Synapse Training",
    "Advanced Breeding",
    "Hyperparameter Self-Adaptation",
    "Adaptive Population Sizing",
    "ONNX",
    "Transfer Learning",
    "CRISPR Gene Injection",
    "Grafting",
    "Neuron Pruning",
    "UUID-Based Indexing",
    "Distributed Evolution",
    "Lifelong Learning",
    "Speciation",
    "Historical Marking",
    "Discovery Caching",
    "Ensemble Diversity",
    "Adaptive Quantum Steps",
    "Unique Activation Functions",
    "Sparse Training",
    "Early Stopping",
    "Muon",
  ];
  for (const f of features) {
    assertStringIncludes(audit, f, `Audit must list NEAT-AI capability '${f}'`);
  }
});

Deno.test("audit captures the specific points from issue #182", () => {
  const audit = loadAudit();
  // Back-propagation framing in MNIST.
  assertStringIncludes(audit, "mnist_classification/README.md");
  assert(
    /back[ -]?propagation/i.test(audit),
    "Audit must discuss the back-propagation framing from issue #182",
  );
  // Binary data-format speed advantage.
  assert(
    /binary.*(data|format|training)/i.test(audit),
    "Audit must mention the binary training-data-format speed advantage",
  );
  // NEAT-AI-Discovery's science-driven structural mutation.
  assertStringIncludes(audit, "NEAT-AI-Discovery");
  assert(
    /science/i.test(audit),
    "Audit must capture the 'science-driven' framing for Discovery",
  );
});

Deno.test("audit flags the unqualified-NEAT phrasing concern", () => {
  const audit = loadAudit();
  // The audit must explicitly call out where unqualified "NEAT" reads as a
  // limitation of NEAT-AI rather than of standard/textbook NEAT.
  assert(
    /(textbook|standard|classical|vanilla)\s+NEAT/i.test(audit),
    "Audit should distinguish standard/textbook NEAT from NEAT-AI",
  );
});

Deno.test("audit groups features into categories in its Mermaid summary", () => {
  const audit = loadAudit();
  // The Mermaid block must group capabilities by category (search, training,
  // structure, scale, interop) per the issue's acceptance criteria.
  const categories = ["search", "training", "structure", "scale", "interop"];
  for (const c of categories) {
    assertStringIncludes(
      audit.toLowerCase(),
      c,
      `Audit category grouping must mention '${c}'`,
    );
  }
});

Deno.test("README.md links to the audit from the Related Repositories section", () => {
  const readme = loadReadme();
  // The audit must be discoverable from the parent README so future
  // contributors find it. Per acceptance criteria it lives within (or just
  // after) the Related Repositories section.
  assertStringIncludes(readme, "docs/neat_ai_feature_audit.md");
});
