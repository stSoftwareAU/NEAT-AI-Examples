/**
 * Tests for `docs/binary_training_stream.md` and the cross-references from
 * example READMEs that emit a `.bin` training file. Issue #190.
 *
 * These are "what" tests — they verify what the documentation produces
 * (the file exists, contains a Mermaid block, and is linked from each
 * example README that writes a `.bin` file). They do not inspect any
 * source code patterns.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const DOC_PATH = "docs/binary_training_stream.md";

/** Examples that produce a `.bin` training file at runtime. */
const BIN_EMITTING_EXAMPLES = [
  "xor_classification",
  "discovery",
  "discovery_at_scale",
  "crispr_injection",
  "evolution_showcase",
  "crossover",
  "intelligent_design",
] as const;

/**
 * Examples whose README also discusses the binary `.bin` stream as a NEAT-AI
 * feature, even when the example itself does not currently write the file.
 * These are mentioned by name in the new doc to give readers a complete map.
 */
const RELATED_EXAMPLES = ["mnist_classification", "synthetic_synapse"] as const;

function loadDoc(): string {
  return Deno.readTextFileSync(DOC_PATH);
}

function extractMermaidBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/*  Doc presence and shape                                             */
/* ------------------------------------------------------------------ */

Deno.test("docs/binary_training_stream.md exists", () => {
  const content = loadDoc();
  assertEquals(
    content.length > 0,
    true,
    "binary_training_stream.md must not be empty",
  );
});

Deno.test("docs/binary_training_stream.md describes the chunked Float32 record format", () => {
  const content = loadDoc().toLowerCase();
  assertStringIncludes(content, "float32");
  assertStringIncludes(content, "little-endian");
  assertStringIncludes(content, "evolvedir");
});

Deno.test("docs/binary_training_stream.md includes a Mermaid diagram of the pipeline", () => {
  const blocks = extractMermaidBlocks(loadDoc());
  assertEquals(
    blocks.length >= 1,
    true,
    "Expected at least one ```mermaid``` block in binary_training_stream.md",
  );
  const diagram = blocks.join("\n").toLowerCase();
  assertStringIncludes(diagram, ".bin");
});

Deno.test("docs/binary_training_stream.md mentions every example that emits a .bin file", () => {
  const content = loadDoc();
  for (const name of BIN_EMITTING_EXAMPLES) {
    assertStringIncludes(
      content,
      name,
      `binary_training_stream.md should reference the ${name} example`,
    );
  }
});

Deno.test("docs/binary_training_stream.md mentions related examples that discuss the .bin stream", () => {
  const content = loadDoc();
  for (const name of RELATED_EXAMPLES) {
    assertStringIncludes(
      content,
      name,
      `binary_training_stream.md should reference the ${name} example`,
    );
  }
});

Deno.test("docs/binary_training_stream.md quantifies the speed advantage", () => {
  const content = loadDoc().toLowerCase();
  // The doc must explain why binary is faster — either via a benchmark or an
  // asymptotic argument. Check for either signal.
  const mentionsAsymptotic = content.includes("o(1)") && content.includes("o(n)");
  const mentionsParsing = content.includes("parsing") || content.includes("parse");
  assertEquals(
    mentionsAsymptotic || mentionsParsing,
    true,
    "Doc should explain the speed-up (asymptotic argument or parsing-overhead discussion)",
  );
});

/* ------------------------------------------------------------------ */
/*  Each emitting example README links to the new doc                  */
/* ------------------------------------------------------------------ */

for (const name of BIN_EMITTING_EXAMPLES) {
  Deno.test(
    `${name}/README.md links to docs/binary_training_stream.md`,
    () => {
      const readme = Deno.readTextFileSync(`${name}/README.md`);
      assertStringIncludes(
        readme,
        "../docs/binary_training_stream.md",
        `${name}/README.md should reference the new binary-training-stream doc`,
      );
    },
  );
}
