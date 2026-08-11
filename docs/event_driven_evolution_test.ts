import { assert } from "@std/assert";
import { Creature } from "@stsoftware/neat-ai";

/**
 * Verify the event-driven navigation doc matches reality (Issue #787).
 *
 * The doc is the published artefact, so these are "what" tests — they assert
 * on its content and cross-check the API names it advertises against the
 * NEAT-AI dependency the examples actually call. The migration scoreboard is
 * the part that rots: every reinforcement example shipped on
 * `Creature.evolveRL()` long ago, so a doc still showing unticked boxes or
 * naming a different migration target actively misleads a reader.
 */

const DOC_PATH = "docs/event-driven-evolution.md";

/** Every reinforcement / event-driven example, with its migration issue. */
const RL_EXAMPLES = [
  { name: "cart_pole", issue: 236 },
  { name: "mountain_car", issue: 237 },
  { name: "snake_game", issue: 238 },
  { name: "maze_navigation", issue: 239 },
  { name: "lunar_lander", issue: 292 },
] as const;

function readDoc(): string {
  return Deno.readTextFileSync(DOC_PATH);
}

/** The body of the `## …Migration status…` section, up to the next `## ` heading. */
function migrationSection(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^## .*migration status/i.test(line));
  assert(start >= 0, `Expected a top-level "Migration status" section in ${DOC_PATH}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Paradigm-table rows naming `example` — the rows that carry an API column. */
function paradigmRowsFor(text: string, example: string): string[] {
  return text.split("\n").filter((line) =>
    line.startsWith("|") &&
    line.includes(`\`${example}\``) &&
    /reinforcement|supervised/i.test(line)
  );
}

Deno.test("event-driven doc exists", () => {
  assert(Deno.statSync(DOC_PATH).isFile, `Expected ${DOC_PATH} to be a file`);
});

Deno.test("event-driven doc names the API the dependency actually exposes", () => {
  const proto = Creature.prototype as unknown as Record<string, unknown>;
  assert(
    typeof proto.evolveRL === "function",
    "Expected Creature.prototype.evolveRL to be a function",
  );
  assert(
    typeof proto.evolveEnv === "function",
    "Expected Creature.prototype.evolveEnv to be a function",
  );

  const text = readDoc();
  assert(text.includes("evolveRL"), `Expected ${DOC_PATH} to name evolveRL()`);
  assert(
    text.includes("evolveEnv"),
    `Expected ${DOC_PATH} to state how evolveEnv() relates to evolveRL()`,
  );
});

Deno.test("paradigm table names evolveRL() for every reinforcement example", () => {
  const text = readDoc();
  for (const { name } of RL_EXAMPLES) {
    const rows = paradigmRowsFor(text, name);
    assert(rows.length > 0, `Expected a paradigm-table row for ${name}`);
    for (const row of rows) {
      assert(
        row.includes("evolveRL"),
        `Expected the ${name} row to name evolveRL() as its API, got: ${row}`,
      );
      assert(
        !row.includes("evolveEnv"),
        `Expected the ${name} row not to name evolveEnv() — the example calls evolveRL()`,
      );
    }
  }
});

Deno.test("migration status records every reinforcement example as migrated", () => {
  const section = migrationSection(readDoc());
  assert(
    !section.includes("- [ ]"),
    "Expected no unticked migration checkboxes — all five migrations are complete",
  );
  for (const { name, issue } of RL_EXAMPLES) {
    assert(section.includes(name), `Expected the migration status to account for ${name}`);
    assert(
      section.includes(`#${issue}`),
      `Expected the migration status to cite the closed migration issue #${issue} for ${name}`,
    );
  }
});

Deno.test("event-driven doc carries no pending-migration prose", () => {
  const text = readDoc();
  const stale = [
    /will migrate one-by-one/i,
    /when every box is ticked/i,
    /tick a box when/i,
    /can be retired/i,
  ];
  for (const pattern of stale) {
    assert(
      !pattern.test(text),
      `Expected ${DOC_PATH} to drop stale pending-migration prose matching ${pattern}`,
    );
  }
});

Deno.test("event-driven doc links the upstream API spec", () => {
  const text = readDoc();
  assert(
    text.includes("stSoftwareAU/NEAT-AI/blob/Develop/docs/event-driven-evolution.md"),
    `Expected ${DOC_PATH} to link the upstream API spec rather than restate it`,
  );
});
