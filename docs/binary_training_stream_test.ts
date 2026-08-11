import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BIN_TRAIN_DIR,
  TRAIN_BIN_FILENAME,
  writeMnistTrainingBin,
} from "../mnist_classification/mnist_classification.ts";
import { CLASS_COUNT, type DigitSample, FEATURE_COUNT } from "../mnist_classification/data.ts";

/**
 * Verify the binary `.bin` stream doc matches reality (Issue #789).
 *
 * The doc is the published artefact, so these are "what" tests — they assert
 * on its content and cross-check it against the writer the example actually
 * calls. The classification of each example is the part that rots: MNIST now
 * encodes its training file into the `.bin` stream, so a doc still listing it
 * as a non-emitting example — and citing a README section that no longer
 * exists — misleads the reader the page exists to inform.
 */

const DOC_PATH = "docs/binary_training_stream.md";
const MNIST_README_PATH = "mnist_classification/README.md";

/** Path the MNIST runner writes its `.bin` stream to, from the real constants. */
const MNIST_BIN_PATH = `${BIN_TRAIN_DIR}/${TRAIN_BIN_FILENAME}`;

/** Heading text of the README section the doc used to cite (removed upstream). */
const REMOVED_README_SECTION = "Where NEAT-AI is faster than this demo suggests";

function readDoc(): string {
  return Deno.readTextFileSync(DOC_PATH);
}

/** The body of the section whose heading matches `pattern`, up to the next `## `. */
function section(text: string, pattern: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && pattern.test(line));
  assert(start >= 0, `Expected a top-level section matching ${pattern} in ${DOC_PATH}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Table rows anywhere in `text` that name `example` in a code span. */
function rowsFor(text: string, example: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("|") && line.includes(`\`${example}\``));
}

/** Build `count` synthetic samples, one per class, cycling through the labels. */
function buildSamples(count: number): DigitSample[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: index % CLASS_COUNT,
    features: Array.from({ length: FEATURE_COUNT }, (_, i) => (i % 256) / 255),
    pixels: Array.from({ length: FEATURE_COUNT }, (_, i) => i % 256),
  }));
}

Deno.test("binary stream doc exists", () => {
  assert(Deno.statSync(DOC_PATH).isFile, `Expected ${DOC_PATH} to be a file`);
});

Deno.test("mnist_classification really emits a .bin file in the documented layout", () => {
  const dir = Deno.makeTempDirSync({ prefix: "binary_stream_doc_" });
  try {
    const path = join(dir, TRAIN_BIN_FILENAME);
    const samples = buildSamples(3);
    writeMnistTrainingBin(samples, path);

    const stride = FEATURE_COUNT + CLASS_COUNT;
    const bytes = Deno.readFileSync(path);
    assertEquals(
      bytes.byteLength,
      samples.length * stride * 4,
      "Expected exactly records × (I + O) × 4 bytes — no header, no padding",
    );

    // Inputs then one-hot targets, Float32, in sample order.
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    for (const [record, sample] of samples.entries()) {
      const base = record * stride;
      assertEquals(
        floats[base + 5],
        Math.fround(sample.features[5]),
        `Record ${record} should carry its input features first`,
      );
      for (let c = 0; c < CLASS_COUNT; c++) {
        assertEquals(
          floats[base + FEATURE_COUNT + c],
          c === sample.label ? 1 : 0,
          `Record ${record} should carry a one-hot target for class ${c}`,
        );
      }
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("doc lists mnist_classification as an emitting example with its real path", () => {
  const text = readDoc();
  const rows = rowsFor(text, "mnist_classification");
  assert(
    rows.length > 0,
    `Expected ${DOC_PATH} to list mnist_classification in an emitting-examples table`,
  );
  for (const row of rows) {
    assert(
      row.includes(MNIST_BIN_PATH),
      `Expected the mnist_classification row to cite ${MNIST_BIN_PATH}, got: ${row}`,
    );
    assert(
      row.includes("writeMnistTrainingBin"),
      `Expected the mnist_classification row to name its writer, got: ${row}`,
    );
  }
});

Deno.test("doc does not claim mnist_classification skips the .bin stream", () => {
  const text = readDoc();
  const stale = [
    /do not currently emit a `\.bin` file/i,
    /deliberately leaves out/i,
  ];
  for (const pattern of stale) {
    assert(
      !pattern.test(text),
      `Expected ${DOC_PATH} to drop stale non-emitting prose matching ${pattern}`,
    );
  }
});

Deno.test("doc cites no README section that no longer exists", () => {
  const doc = readDoc();
  const readme = Deno.readTextFileSync(MNIST_README_PATH);
  assert(
    !readme.includes(REMOVED_README_SECTION),
    `${MNIST_README_PATH} no longer has a "${REMOVED_README_SECTION}" section — ` +
      "update this test if it is ever reinstated",
  );
  assert(
    !doc.includes(REMOVED_README_SECTION),
    `Expected ${DOC_PATH} to drop the dead reference to "${REMOVED_README_SECTION}"`,
  );
});

Deno.test("every example the doc lists as emitting a .bin cites a working-directory path", () => {
  const text = readDoc();
  const bodies = [
    section(text, /emit a `\.bin` file/i),
    section(text, /emits a `\.bin` from real data/i),
    section(text, /emit a single `training\.bin`/i),
  ];
  const rows = bodies.flatMap((body) =>
    body.split("\n").filter((line) => line.startsWith("|") && /`[a-z0-9_]+`/.test(line))
  );
  assert(
    rows.length >= 12,
    `Expected the emitting tables to cover every emitting example, got ${rows.length}`,
  );
  for (const row of rows) {
    assert(
      /\.[a-z0-9-]+\/[a-z0-9_/*-]+\.bin/.test(row),
      `Expected a hidden working-directory .bin path in row: ${row}`,
    );
  }
});
