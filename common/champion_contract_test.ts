/**
 * Unit tests for the champion behavioural contract helper.
 */

import { assertThrows } from "@std/assert";
import { Creature } from "@stsoftware/neat-ai";

import { assertChampionContract } from "./champion_contract.ts";
import { makeCreatureExport } from "./creature_export_fixture.ts";

Deno.test("assertChampionContract - accepts a valid creature of the expected arity", () => {
  const champion = new Creature(4, 2);
  assertChampionContract(champion, { input: 4, output: 2 });
});

Deno.test("assertChampionContract - accepts an evolved-style creature with hidden neurons", () => {
  const champion = Creature.fromJSON(
    makeCreatureExport({ input: 3, output: 1, hidden: 4, seed: 7 }),
  );
  assertChampionContract(champion, { input: 3, output: 1 });
});

Deno.test("assertChampionContract - rejects a mismatched input count", () => {
  const champion = new Creature(4, 2);
  assertThrows(() => assertChampionContract(champion, { input: 5, output: 2 }));
});

Deno.test("assertChampionContract - rejects a mismatched output count", () => {
  const champion = new Creature(4, 2);
  assertThrows(() => assertChampionContract(champion, { input: 4, output: 3 }));
});

Deno.test("assertChampionContract - rejects a non-finite activation", () => {
  const champion = new Creature(2, 1);
  // Poison an output bias so activation yields NaN — the contract must fail loud.
  const outputNeuron = champion.neurons[champion.neurons.length - 1];
  outputNeuron.bias = Number.NaN;
  assertThrows(() => assertChampionContract(champion, { input: 2, output: 1 }));
});
