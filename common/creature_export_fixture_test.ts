/**
 * Unit tests for the shared real-`CreatureExport` fixture builder (issue #722).
 *
 * These are "what" tests — they build fixtures and assert on the exported
 * structure, on reconstructability by the real library, and on the errors
 * raised for invalid neuron counts.
 */

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";

import { Creature } from "@stsoftware/neat-ai";

import { makeCreatureExport } from "./creature_export_fixture.ts";

Deno.test("makeCreatureExport builds a fresh seed the library can reload", () => {
  const creatureExport = makeCreatureExport({ input: 4, output: 2 });

  assertEquals(creatureExport.input, 4);
  assertEquals(creatureExport.output, 2);
  // A fresh seed has no hidden neurons and is fully connected input → output.
  assertEquals(creatureExport.neurons.length, 2);
  assertEquals(creatureExport.synapses.length, 8);

  // The decisive check a hand-rolled literal cannot pass: the real library
  // accepts the export and validates the resulting creature.
  const reloaded = Creature.fromJSON(creatureExport);
  reloaded.validate();
  assertEquals(reloaded.input, 4);
  assertEquals(reloaded.output, 2);
});

Deno.test("makeCreatureExport fresh seeds differ between calls", () => {
  const first = makeCreatureExport({ input: 3, output: 1 });
  const second = makeCreatureExport({ input: 3, output: 1 });

  // Random initialisation — two fresh seeds are distinct creatures, which is
  // what population-seeding tests need to distinguish them.
  assertNotEquals(JSON.stringify(first), JSON.stringify(second));
});

Deno.test("makeCreatureExport hidden variant is deterministic per seed", () => {
  const a = makeCreatureExport({ input: 4, output: 2, hidden: 3, seed: 11 });
  const b = makeCreatureExport({ input: 4, output: 2, hidden: 3, seed: 11 });
  const other = makeCreatureExport({ input: 4, output: 2, hidden: 3, seed: 12 });

  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assertNotEquals(JSON.stringify(a), JSON.stringify(other));

  const hidden = a.neurons.filter((neuron) => neuron.type === "hidden");
  assertEquals(hidden.length, 3);
  assert(a.synapses.length > 0, "hidden variant must be wired");
  Creature.fromJSON(a).validate();
});

Deno.test("makeCreatureExport rejects invalid neuron counts", () => {
  assertThrows(() => makeCreatureExport({ input: 0, output: 2 }), Error, "input");
  assertThrows(() => makeCreatureExport({ input: 2.5, output: 2 }), Error, "input");
  assertThrows(() => makeCreatureExport({ input: 4, output: 0 }), Error, "output");
  assertThrows(() => makeCreatureExport({ input: 4, output: 2, hidden: -1 }), Error, "hidden");
  assertThrows(() => makeCreatureExport({ input: 4, output: 2, hidden: 1.5 }), Error, "hidden");
});
