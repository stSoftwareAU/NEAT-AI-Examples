import { assertEquals } from "@std/assert";
import { join } from "@std/path";

import { makeCreatureExport } from "../common/creature_export_fixture.ts";
import { CLASS_COUNT, FEATURE_COUNT } from "./data.ts";
import {
  CREATURES_DIR,
  intelligentDesignOutputDir,
  loadPopulationPoolSeeds,
  loadSamplerLoopChampion,
  populationPoolDirs,
  priorLoopPhaseNames,
  SAMPLER_DIR,
  samplerLoopPath,
  saveSamplerLoopChampion,
  wipePopulationPool,
} from "./population_pool.ts";

// Real MNIST-shaped exports (issue #722): a fresh seed exactly as the campaign
// builds one, and an evolved-style champion carrying hidden neurons.
const exportA = makeCreatureExport({ input: FEATURE_COUNT, output: CLASS_COUNT });
const exportB = makeCreatureExport({
  input: FEATURE_COUNT,
  output: CLASS_COUNT,
  hidden: 3,
  seed: 722,
});

Deno.test("priorLoopPhaseNames lists earlier sampler loops", () => {
  assertEquals(priorLoopPhaseNames("loop-1"), []);
  assertEquals(priorLoopPhaseNames("loop-3"), ["loop-1", "loop-2"]);
  assertEquals(priorLoopPhaseNames("loop-4-r2"), ["loop-1-r2", "loop-2-r2", "loop-3-r2"]);
});

// The experiments directory is reached through populationPoolDirs().experiments
// — the only supported accessor now that the unused EXPERIMENTS_DIR alias is
// gone (issue #767).
Deno.test("experiments directory is created and wiped via populationPoolDirs", async () => {
  const root = await Deno.makeTempDir();
  try {
    const experiments = populationPoolDirs(root).experiments;
    assertEquals(experiments, join(root, "experiments"));

    const outputDir = intelligentDesignOutputDir("LOGISTIC", root);
    assertEquals(outputDir, join(experiments, "intelligent-design", "LOGISTIC"));
    assertEquals(Deno.statSync(outputDir).isDirectory, true);

    await wipePopulationPool(root);
    assertEquals(await pathExists(experiments), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("saveSamplerLoopChampion round-trips under .sampler", async () => {
  try {
    await saveSamplerLoopChampion(1, exportA);
    const loaded = await loadSamplerLoopChampion(1);
    // Whole-export fidelity, not just the input width — a round trip must
    // preserve every field a real creature exports. JSON persistence drops
    // explicitly-undefined optional fields, so compare the serialised forms.
    assertEquals(JSON.stringify(loaded), JSON.stringify(exportA));
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
    assertEquals(creaturesText, JSON.stringify(exportA));
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
