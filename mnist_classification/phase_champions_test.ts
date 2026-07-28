/**
 * Unit tests for MNIST phase-champion archiving (sampler-loop parity).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";

import {
  creatureExportsEqual,
  elitismForArchivedChampions,
  loadOtherSampleRateChampions,
  loadPhaseChampion,
  loadPriorStructureChampions,
  loadSampleRateChampion,
  maybeUpdateSampleRateChampion,
  mergePopulationSeedExports,
  phaseChampionPath,
  priorStructurePhaseNames,
  repeatSuffixFromPhaseName,
  sampleRateChampionPath,
  sampleRateKey,
  savePhaseChampion,
  shouldAdvanceLineageChampion,
  structurePhaseNamesForRepeat,
} from "./phase_champions.ts";

Deno.test("repeatSuffixFromPhaseName parses optional repeat suffix", () => {
  assertEquals(repeatSuffixFromPhaseName("structure-1"), "");
  assertEquals(repeatSuffixFromPhaseName("structure-2-r2"), "-r2");
  assertEquals(repeatSuffixFromPhaseName("polish-r3"), "-r3");
});

Deno.test("sampleRateKey maps training fractions to stable filenames", () => {
  assertEquals(sampleRateKey(1), "1");
  assertEquals(sampleRateKey(0.01), "0.01");
  assertEquals(sampleRateKey(0.05), "0.05");
  assertEquals(sampleRateKey(0.15), "0.15");
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

Deno.test("shouldAdvanceLineageChampion rejects hold-out regression", () => {
  assert(shouldAdvanceLineageChampion({ testAccuracy: 0.5 }, { testAccuracy: 0.51 }));
  assert(shouldAdvanceLineageChampion({ testAccuracy: 0.5 }, { testAccuracy: 0.5 }));
  assertFalse(shouldAdvanceLineageChampion({ testAccuracy: 0.53 }, { testAccuracy: 0.51 }));
});

Deno.test("mergePopulationSeedExports deduplicates identical exports", () => {
  const exportA = { input: 784, output: 10, neurons: [], synapses: [] };
  const exportB = {
    input: 784,
    output: 10,
    neurons: [{ uuid: "n1", type: "hidden" as const, bias: 0 }],
    synapses: [],
  };
  assert(creatureExportsEqual(exportA, { ...exportA }));
  assertEquals(mergePopulationSeedExports([exportA, exportB], [exportA]).length, 2);
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

Deno.test("maybeUpdateSampleRateChampion keeps the best score per sample rate", async () => {
  const trainingSampleRate = 0.991;
  const exportA = { input: 784, output: 10, neurons: [], synapses: [] };
  const exportB = {
    input: 784,
    output: 10,
    neurons: [{ uuid: "n1", type: "hidden" as const, bias: 0 }],
    synapses: [],
  };
  try {
    try {
      await Deno.remove(sampleRateChampionPath(trainingSampleRate));
    } catch {
      // Best-effort cleanup from a prior run.
    }
    assert(
      await maybeUpdateSampleRateChampion({
        trainingSampleRate,
        phaseName: "structure-1pct",
        creatureExport: exportA,
        evolveScore: 0.4,
        testAccuracy: 0.2,
        validationAccuracy: 0.21,
      }),
    );
    assertFalse(
      await maybeUpdateSampleRateChampion({
        trainingSampleRate,
        phaseName: "structure-1pct",
        creatureExport: exportB,
        evolveScore: 0.35,
        testAccuracy: 0.25,
        validationAccuracy: 0.26,
      }),
    );
    assert(
      await maybeUpdateSampleRateChampion({
        trainingSampleRate,
        phaseName: "structure-1pct",
        creatureExport: exportB,
        evolveScore: 0.45,
        testAccuracy: 0.25,
        validationAccuracy: 0.26,
      }),
    );

    const record = await loadSampleRateChampion(trainingSampleRate);
    assertEquals(record?.evolveScore, 0.45);
    assertEquals(record?.export.neurons.length, 1);
  } finally {
    try {
      await Deno.remove(sampleRateChampionPath(trainingSampleRate));
    } catch {
      // Best-effort cleanup.
    }
  }
});

Deno.test("loadOtherSampleRateChampions returns every archived rate except the current one", async () => {
  const currentRate = 0.992;
  const otherRateA = 0.993;
  const otherRateB = 0.994;
  const exportA = { input: 784, output: 10, neurons: [], synapses: [] };
  const exportB = {
    input: 784,
    output: 10,
    neurons: [{ uuid: "n1", type: "hidden" as const, bias: 0 }],
    synapses: [],
  };
  try {
    await maybeUpdateSampleRateChampion({
      trainingSampleRate: otherRateA,
      phaseName: "structure-1",
      creatureExport: exportA,
      evolveScore: 0.4,
      testAccuracy: 0.2,
      validationAccuracy: 0.21,
    });
    await maybeUpdateSampleRateChampion({
      trainingSampleRate: otherRateB,
      phaseName: "polish",
      creatureExport: exportB,
      evolveScore: 0.52,
      testAccuracy: 0.53,
      validationAccuracy: 0.54,
    });

    const seeds = await loadOtherSampleRateChampions(currentRate);
    assert(seeds.some((seed) => creatureExportsEqual(seed, exportA)));
    assert(seeds.some((seed) => creatureExportsEqual(seed, exportB)));
  } finally {
    for (const rate of [otherRateA, otherRateB]) {
      try {
        await Deno.remove(sampleRateChampionPath(rate));
      } catch {
        // Best-effort cleanup.
      }
    }
  }
});
