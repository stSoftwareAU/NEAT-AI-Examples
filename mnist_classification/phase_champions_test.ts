/**
 * Unit tests for MNIST phase-champion archiving (GRQ sampler parity).
 */

import { assertEquals } from "@std/assert";

import {
  elitismForArchivedChampions,
  loadPhaseChampion,
  loadPriorStructureChampions,
  phaseChampionPath,
  priorStructurePhaseNames,
  repeatSuffixFromPhaseName,
  savePhaseChampion,
  structurePhaseNamesForRepeat,
} from "./phase_champions.ts";

Deno.test("repeatSuffixFromPhaseName parses optional repeat suffix", () => {
  assertEquals(repeatSuffixFromPhaseName("structure-1"), "");
  assertEquals(repeatSuffixFromPhaseName("structure-2-r2"), "-r2");
  assertEquals(repeatSuffixFromPhaseName("polish-r3"), "-r3");
});

Deno.test("priorStructurePhaseNames lists earlier structure rungs in the same repeat", () => {
  assertEquals(priorStructurePhaseNames("structure-1"), []);
  assertEquals(priorStructurePhaseNames("structure-2"), ["structure-1"]);
  assertEquals(
    priorStructurePhaseNames("structure-4-r2"),
    ["structure-1-r2", "structure-2-r2", "structure-3-r2"],
  );
  assertEquals(
    priorStructurePhaseNames("polish-r2"),
    structurePhaseNamesForRepeat("-r2"),
  );
});

Deno.test("elitismForArchivedChampions reserves slots for archived sample-level winners", () => {
  assertEquals(elitismForArchivedChampions(0), 1);
  assertEquals(elitismForArchivedChampions(1), 2);
  assertEquals(elitismForArchivedChampions(4), 5);
  assertEquals(elitismForArchivedChampions(20), 10);
});

Deno.test("savePhaseChampion round-trips and loadPriorStructureChampions finds earlier rungs", async () => {
  const exportA = { input: 784, output: 10, neurons: [], synapses: [] };
  const exportB = {
    input: 784,
    output: 10,
    neurons: [{ uuid: "n1", type: "hidden" as const, bias: 0 }],
    synapses: [],
  };
  try {
    await savePhaseChampion("structure-1", exportA);
    await savePhaseChampion("structure-2", exportB);

    const loaded = await loadPhaseChampion("structure-1");
    assertEquals(loaded?.input, 784);

    const prior = await loadPriorStructureChampions("structure-3");
    assertEquals(prior.length, 2);
    assertEquals(prior[0].input, 784);
    assertEquals(prior[1].neurons.length, 1);
  } finally {
    for (const name of ["structure-1", "structure-2"]) {
      try {
        await Deno.remove(phaseChampionPath(name));
      } catch {
        // Best-effort cleanup — directory may not exist yet.
      }
    }
  }
});
