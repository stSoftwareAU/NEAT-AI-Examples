import { assert, assertEquals } from "@std/assert";

/**
 * Verify `docs/factory_adoption.md` — the canonical adoption decision record for
 * tracking issue #517 — still agrees with the example sources it describes (Issue #788).
 *
 * These are "what" tests: the doc is the published artefact under test, and the
 * example sources are the reference data it claims to describe. A Group A row may
 * only say "Migrated" when that example really seeds from `Creature.forDataset(...)`,
 * and may not say "Planned" when the migration has already landed.
 */

const DOC_PATH = "docs/factory_adoption.md";

interface GroupARow {
  example: string;
  status: string;
}

function readDoc(): string {
  return Deno.readTextFileSync(DOC_PATH);
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

/** Parse the Group A adoption table into `{ example, status }` rows. */
function groupARows(text: string): GroupARow[] {
  const rows: GroupARow[] = [];
  for (const line of section(text, "### Group A").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    // A data row is `| \`example\` | status | issue | notes |` → leading/trailing empties.
    if (cells.length < 5) continue;
    const example = cells[1].replace(/`/g, "");
    if (!/^[a-z_]+$/.test(example)) continue;
    rows.push({ example, status: cells[2] });
  }
  return rows;
}

/**
 * True when the example's own sources call the data-derived factory.
 *
 * Comment lines and quoted mentions (log output, doc comments) are ignored so
 * only a real `Creature.forDataset(...)` call counts.
 */
function seedsFromFactory(example: string): boolean {
  for (const entry of Deno.readDirSync(example)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith("_test.ts")) {
      continue;
    }
    const source = Deno.readTextFileSync(`${example}/${entry.name}`);
    for (const raw of source.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) continue;
      const match = line.match(/Creature\.forDataset\s*\(/);
      if (!match) continue;
      // Skip mentions inside string literals (usage banners, log lines).
      const before = line.slice(0, match.index);
      if (/["'`]/.test(before)) continue;
      return true;
    }
  }
  return false;
}

Deno.test("factory_adoption.md carries a status-as-at date so drift stays visible", () => {
  const text = readDoc();
  assert(
    /status as at \d{4}-\d{2}-\d{2}/i.test(text),
    `Expected ${DOC_PATH} to state the date its adoption status was last verified`,
  );
});

Deno.test("Group A table lists every factory-seeded example as Migrated", () => {
  const rows = groupARows(readDoc());
  assert(rows.length > 0, "Expected to parse at least one Group A row");
  for (const { example, status } of rows) {
    if (!seedsFromFactory(example)) continue;
    assert(
      status.includes("✅") && status.includes("Migrated"),
      `${example} seeds from Creature.forDataset(...) but ${DOC_PATH} lists it as "${status}"`,
    );
  }
});

Deno.test("Group A table only claims Migrated for examples that seed from the factory", () => {
  const rows = groupARows(readDoc());
  for (const { example, status } of rows) {
    if (!status.includes("Migrated")) continue;
    assert(
      seedsFromFactory(example),
      `${DOC_PATH} lists ${example} as Migrated but no Creature.forDataset(...) call was found`,
    );
  }
});

Deno.test("Adoption-flow diagram does not route migrated examples to the TODO node", () => {
  const text = readDoc();
  const migrated = groupARows(text)
    .filter((row) => row.status.includes("Migrated"))
    .map((row) => row.example);
  const todo = text.match(/A_TODO\["([^"]*)"\]/);
  if (!todo) return; // No outstanding Group A work charted — nothing to contradict.
  for (const example of migrated) {
    assert(
      !todo[1].includes(example),
      `Diagram routes migrated example ${example} to A_TODO in ${DOC_PATH}`,
    );
  }
});

Deno.test("Completed Group A is not charted or worded as outstanding", () => {
  const text = readDoc();
  const outstanding = groupARows(text).filter((row) => !row.status.includes("Migrated"));
  if (outstanding.length > 0) return; // Group A genuinely incomplete — deferral wording is correct.

  assertEquals(
    text.match(/A_TODO/g),
    null,
    `Group A is complete, so ${DOC_PATH} must not chart an A_TODO node`,
  );
  assertEquals(
    text.match(/once Group A is complete/g),
    null,
    `Group A is complete, so ${DOC_PATH} must not defer work "once Group A is complete"`,
  );
});
