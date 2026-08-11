import { assert } from "@std/assert";

/**
 * Verify `docs/neat_ai_feature_audit.md` — the file `README.md` points at as the source of
 * truth for which capability each example demonstrates — still agrees with the repository it
 * describes (Issue #790).
 *
 * These are "what" tests: the audit is the published artefact under test and the example
 * READMEs (plus the sibling `docs/binary_training_stream.md`) are the reference data it claims
 * to describe. The audit may not call a capability undemonstrated while another doc tables the
 * examples demonstrating it, may not accuse a README of wording it no longer contains, and its
 * register must really list every example README.
 */

const DOC_PATH = "docs/neat_ai_feature_audit.md";
const BIN_DOC_PATH = "docs/binary_training_stream.md";

function readDoc(path = DOC_PATH): string {
  return Deno.readTextFileSync(path);
}

/** Slice the document between a heading and the next heading at the same level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  assert(start >= 0, `Expected ${DOC_PATH} to contain the heading ${heading}`);
  const level = heading.split(" ")[0];
  const rest = text.slice(start + heading.length);
  const next = rest.indexOf(`\n${level} `);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Table rows (lines starting with `|`) that are not the header or separator. */
function tableRows(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("|") && !/^\|[\s|:-]+\|$/.test(line));
}

/** Every `<example>/README.md` in the repository root. */
function exampleReadmes(): string[] {
  const found: string[] = [];
  for (const entry of Deno.readDirSync(".")) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    if (entry.name === "docs" || entry.name === "common" || entry.name === "quality") continue;
    try {
      Deno.statSync(`${entry.name}/README.md`);
      found.push(`${entry.name}/README.md`);
    } catch {
      // Directory carries no README — nothing for the register to list.
    }
  }
  return found.sort();
}

/** README paths the register links to, as repository-relative paths. */
function registeredReadmes(text: string): string[] {
  const registerRows = tableRows(section(text, "## 📚 Per-README accuracy register"));
  const paths = new Set<string>();
  for (const row of registerRows) {
    for (const match of row.matchAll(/\]\(\.\.\/([^)]+README\.md)\)/g)) paths.add(match[1]);
  }
  return [...paths].sort();
}

/** Normalise markdown emphasis and whitespace so a quote can be matched against prose. */
function normalise(value: string): string {
  return value.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
}

/** Example directory names `docs/binary_training_stream.md` records as emitting a `.bin` file. */
function binStreamExamples(): string[] {
  const names = new Set<string>();
  for (const row of tableRows(readDoc(BIN_DOC_PATH))) {
    const first = row.split("|")[1]?.trim() ?? "";
    const match = first.match(/^`([a-z_]+)`$/);
    if (!match) continue;
    try {
      if (Deno.statSync(match[1]).isDirectory) names.add(match[1]);
    } catch {
      // Not an example directory — a wire-format table row rather than an example row.
    }
  }
  return [...names].sort();
}

Deno.test("audit records the date its verdicts were last verified", () => {
  assert(
    /as at \d{4}-\d{2}-\d{2}/i.test(readDoc()),
    `Expected ${DOC_PATH} to state the date its verdicts were last checked against the repo`,
  );
});

Deno.test("register lists every example README in the repository", () => {
  const registered = registeredReadmes(readDoc());
  for (const readme of exampleReadmes()) {
    assert(
      registered.includes(readme),
      `${readme} exists but the per-README register in ${DOC_PATH} does not list it`,
    );
  }
});

Deno.test("register only lists READMEs that exist", () => {
  for (const readme of registeredReadmes(readDoc())) {
    assert(
      exampleReadmes().includes(readme),
      `${DOC_PATH} registers ${readme}, which is not an example README in this repository`,
    );
  }
});

Deno.test("binary .bin capability row is not marked undemonstrated", () => {
  const demonstrating = binStreamExamples();
  assert(demonstrating.length > 0, `Expected ${BIN_DOC_PATH} to table examples emitting a .bin`);

  const row = tableRows(readDoc()).find((line) => line.includes("Binary `.bin` Training Stream"));
  assert(row, `Expected ${DOC_PATH} to carry a capability row for the binary .bin training stream`);
  assert(
    !/not yet demonstrated|no example exhibits it/i.test(row),
    `${BIN_DOC_PATH} tables ${demonstrating.length} examples emitting a .bin, but ${DOC_PATH} ` +
      `still records the capability as undemonstrated: ${row.trim()}`,
  );
  assert(
    demonstrating.some((example) => row.includes(example)) ||
      row.includes("binary_training_stream"),
    `The .bin capability row in ${DOC_PATH} names no demonstrating example and does not cite ` +
      BIN_DOC_PATH,
  );
});

Deno.test("rows accusing a README of misleading wording quote wording it still contains", () => {
  for (const row of tableRows(readDoc())) {
    if (!/Misleading|Misrepresent|\*\*Yes/i.test(row)) continue;
    if (row.includes("Resolved")) continue; // Superseded row — checked by the test below.
    const readmes = [...row.matchAll(/\]\(\.\.\/([^)]+README\.md)\)/g)].map((m) => m[1]);
    const quotes = [...row.matchAll(/(?<!~)"([^"]{12,})"(?!~)/g)].map((m) => normalise(m[1]));
    if (readmes.length === 0 || quotes.length === 0) continue;
    const prose = readmes.map((path) => normalise(Deno.readTextFileSync(path)));
    assert(
      quotes.some((quote) => prose.some((text) => text.includes(quote))),
      `${DOC_PATH} flags ${readmes.join(", ")} over wording none of them still contain: ` +
        quotes.map((quote) => `"${quote}"`).join(" / "),
    );
  }
});

Deno.test("superseded quotes really are gone from the README they are struck through for", () => {
  let checked = 0;
  for (const row of tableRows(readDoc())) {
    const readmes = [...row.matchAll(/\]\(\.\.\/([^)]+README\.md)\)/g)].map((m) => m[1]);
    if (readmes.length === 0) continue;
    for (const match of row.matchAll(/~~"([^"]+)"~~/g)) {
      const quote = normalise(match[1]);
      checked++;
      for (const path of readmes) {
        assert(
          !normalise(Deno.readTextFileSync(path)).includes(quote),
          `${DOC_PATH} strikes through "${quote}" as superseded, but ${path} still contains it`,
        );
      }
    }
  }
  assert(checked > 0, `Expected ${DOC_PATH} to mark at least one superseded quote with ~~"…"~~`);
});
