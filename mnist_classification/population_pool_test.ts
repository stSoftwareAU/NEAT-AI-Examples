import { assertEquals } from "@std/assert";

import {
  CREATURES_DIR,
  loadPopulationPoolSeeds,
  loadSamplerLoopChampion,
  priorLoopPhaseNames,
  SAMPLER_DIR,
  samplerLoopPath,
  saveSamplerLoopChampion,
} from "./population_pool.ts";

const exportA = { input: 784, output: 10, neurons: [], synapses: [] };
const exportB = {
  input: 784,
  output: 10,
  neurons: [{ uuid: "n1", type: "hidden" as const, bias: 0 }],
  synapses: [],
};

Deno.test("priorLoopPhaseNames lists earlier GRQ sampler loops", () => {
  assertEquals(priorLoopPhaseNames("loop-1"), []);
  assertEquals(priorLoopPhaseNames("loop-3"), ["loop-1", "loop-2"]);
  assertEquals(priorLoopPhaseNames("loop-4-r2"), ["loop-1-r2", "loop-2-r2", "loop-3-r2"]);
});

Deno.test("saveSamplerLoopChampion round-trips under .sampler", async () => {
  try {
    await saveSamplerLoopChampion(1, exportA);
    const loaded = await loadSamplerLoopChampion(1);
    assertEquals(loaded?.input, 784);
    assertEquals(samplerLoopPath(1).includes(".sampler/loop-1.json"), true);
  } finally {
    try {
      await Deno.remove(samplerLoopPath(1));
    } catch {
      // Best-effort cleanup.
    }
  }
});

Deno.test("loadPopulationPoolSeeds refreshes .creatures from prior loops", async () => {
  try {
    await saveSamplerLoopChampion(1, exportA);
    const seeds = await loadPopulationPoolSeeds({
      phaseName: "loop-2",
      currentTrainingSampleRate: 0.05,
      lineageExport: exportB,
    });
    assertEquals(seeds.length >= 1, true);
    const creaturesText = await Deno.readTextFile(`${CREATURES_DIR}/sampler-1.json`);
    assertEquals(JSON.parse(creaturesText).input, 784);
  } finally {
    for (const path of [samplerLoopPath(1), `${CREATURES_DIR}/sampler-1.json`]) {
      try {
        await Deno.remove(path);
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      await Deno.remove(SAMPLER_DIR);
      await Deno.remove(CREATURES_DIR);
    } catch {
      // Best-effort cleanup.
    }
  }
});
