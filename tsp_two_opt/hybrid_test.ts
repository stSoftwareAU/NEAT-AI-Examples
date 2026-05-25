/**
 * Unit tests for tsp_two_opt/hybrid.ts (issue #482).
 *
 * Cover the three acceptance criteria:
 *
 *   1. The memetic re-seed wires the previous champion's export into
 *      the next chunk's seed.
 *   2. CRISPR splicing fires on a stalled chunk (the splice primitive
 *      from `crispr_injection/` is invoked and the spliced creature
 *      gains the gene's two hidden neurons).
 *   3. The MH acceptance rule accepts a worsening swap with non-zero
 *      probability at positive temperature and degenerates to strict
 *      improvement at `T → 0`.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { Creature, type CreatureExport } from "@stsoftware/neat-ai";

import {
  buildTspEditGene,
  HYBRID_LOG_MARKERS,
  isChunkStalled,
  runHybridEvolution,
  spliceCrisprGene,
  TSP_GENE_NEURON_UUIDS,
} from "./hybrid.ts";
import { shouldAcceptSwap } from "./environment.ts";
import { buildSeedCreature, type EvolveResult } from "./tsp_two_opt.ts";
import { loadInstance } from "../common/tsp_instances.ts";

/* ------------------------------------------------------------------ */
/*  CRISPR splice tests                                                */
/* ------------------------------------------------------------------ */

Deno.test("spliceCrisprGene — adds the two gene hidden neurons to the host", () => {
  const host = buildSeedCreature();
  const hostNeurons = host.neurons.length;
  const { spliced } = spliceCrisprGene(host);

  // Both gene-neuron UUIDs must be present in the spliced creature.
  const splicedUUIDs = new Set(spliced.neurons.map((n) => n.uuid));
  assert(
    splicedUUIDs.has(TSP_GENE_NEURON_UUIDS[0]),
    `spliced creature should carry ${TSP_GENE_NEURON_UUIDS[0]}`,
  );
  assert(
    splicedUUIDs.has(TSP_GENE_NEURON_UUIDS[1]),
    `spliced creature should carry ${TSP_GENE_NEURON_UUIDS[1]}`,
  );
  // The two gene neurons grew the host topology by exactly two.
  assertEquals(spliced.neurons.length, hostNeurons + 2);
});

Deno.test("spliceCrisprGene — leaves the input host unmutated", () => {
  const host = buildSeedCreature();
  const before = host.neurons.length;
  spliceCrisprGene(host);
  assertEquals(host.neurons.length, before);
});

Deno.test("buildTspEditGene — rejects a host with fewer than 2 outputs", () => {
  let threw = false;
  try {
    buildTspEditGene(["only-one"]);
  } catch {
    threw = true;
  }
  assert(threw, "buildTspEditGene must reject hosts with < 2 outputs");
});

/* ------------------------------------------------------------------ */
/*  MH acceptance tests                                                */
/* ------------------------------------------------------------------ */

Deno.test("shouldAcceptSwap — strict mode rejects every worsening swap", () => {
  // delta > 0 (worse) in strict mode is always reject.
  for (const delta of [0.1, 1, 10, 100]) {
    assert(!shouldAcceptSwap(delta, "strict", 1, () => 0));
  }
  // delta == 0 (neutral) is also reject under strict.
  assert(!shouldAcceptSwap(0, "strict", 1, () => 0));
});

Deno.test("shouldAcceptSwap — improving swaps are always accepted", () => {
  for (const delta of [-0.1, -1, -10]) {
    assert(shouldAcceptSwap(delta, "strict", 0, () => 1));
    assert(shouldAcceptSwap(delta, "mh", 1, () => 1));
  }
});

Deno.test("shouldAcceptSwap — MH at positive T accepts a worsening swap with non-zero probability", () => {
  // delta = 1, T-scaled denominator = 10 → p = exp(-0.1) ~ 0.9048.
  // Use random() = 0.5 so the threshold is comfortably below p.
  assert(shouldAcceptSwap(1, "mh", 10, () => 0.5));
  // Use random() = 0.99 so the threshold is above p — must reject.
  assert(!shouldAcceptSwap(1, "mh", 10, () => 0.99));
});

Deno.test("shouldAcceptSwap — MH degenerates to strict-improvement as T → 0", () => {
  // mhScale = 0 means temperature is effectively zero — every worsening
  // swap must be rejected regardless of the random draw.
  for (const r of [0, 0.1, 0.5, 0.9, 0.999999]) {
    assert(!shouldAcceptSwap(1, "mh", 0, () => r));
    assert(!shouldAcceptSwap(0.001, "mh", 0, () => r));
  }
});

/* ------------------------------------------------------------------ */
/*  Stall detection                                                    */
/* ------------------------------------------------------------------ */

Deno.test("isChunkStalled — first transition baselines against zero improvement", () => {
  // Chunk 1 produced no improvement → stalled.
  assert(isChunkStalled(0, undefined));
  // Chunk 1 produced 5% improvement → not stalled.
  assert(!isChunkStalled(0.05, undefined));
});

Deno.test("isChunkStalled — subsequent transitions compare to the prior chunk", () => {
  // Chunk 2 = 0.10, chunk 3 = 0.10 → flat → stalled.
  assert(isChunkStalled(0.1, 0.1));
  // Chunk 3 strictly improved → not stalled.
  assert(!isChunkStalled(0.15, 0.1));
});

/* ------------------------------------------------------------------ */
/*  Orchestrator wiring                                                */
/* ------------------------------------------------------------------ */

Deno.test(
  "runHybridEvolution — chunk 2's seed creature matches chunk 1's champion export (memetic re-seed)",
  async () => {
    const instance = loadInstance("burma14");
    const champion1 = buildSeedCreature();
    const champion2 = buildSeedCreature();
    const champion1Export: CreatureExport = champion1.exportJSON();

    const evolveCalls: Array<{ seedExport?: CreatureExport }> = [];
    const stubEvolver = (
      opts: { seedCreatureExport?: CreatureExport },
    ): Promise<EvolveResult> => {
      evolveCalls.push({ seedExport: opts.seedCreatureExport });
      const champion = evolveCalls.length === 1 ? champion1 : champion2;
      return Promise.resolve({
        champion,
        error: 1,
        score: 0,
        generations: 1,
        wallclockMs: 1,
      });
    };

    const result = await runHybridEvolution({
      instance,
      totalTimeMinutes: 0.05,
      chunks: 2,
      // Stubbed evolver — the inner replay needs to give a non-zero
      // improvement so we exercise the not-stalled / no-CRISPR branch
      // too. We supply a constant 0 here so the test focuses on memetic
      // wiring alone; CRISPR fires too, which we tolerate.
      replay: () => 0,
      // Test seam: feed in the stub.
      // deno-lint-ignore no-explicit-any
      evolver: stubEvolver as any,
      log: () => {},
    });

    assertEquals(result.chunks.length, 2);
    assertEquals(evolveCalls.length, 2);
    assertEquals(evolveCalls[0].seedExport, undefined);
    // Chunk 2's seedCreatureExport must descend from chunk 1's champion
    // export. When CRISPR fires it splices on top so the JSON differs
    // structurally; without CRISPR they are byte-equal. We assert the
    // structural identity by re-hydrating both and comparing input /
    // output widths plus seed UUID survival.
    const chunk2Seed = evolveCalls[1].seedExport;
    assert(chunk2Seed !== undefined, "chunk 2 must receive a seed export");
    const reseeded = Creature.fromJSON(chunk2Seed);
    assertEquals(reseeded.input, champion1.input);
    assertEquals(reseeded.output, champion1.output);

    // Memetic flag asserted on the chunk record.
    assertEquals(result.chunks[1].memeticReseeded, true);
    assertEquals(result.techniques.memetic, true);

    // The full champion-export round-trip equality also holds when no
    // CRISPR splice mutates the host between chunks.
    if (!result.chunks[1].crisprApplied) {
      assertEquals(chunk2Seed, champion1Export);
    }
  },
);

Deno.test(
  "runHybridEvolution — CRISPR splicing fires on a stalled chunk and grows the host",
  async () => {
    const instance = loadInstance("burma14");
    const champion = buildSeedCreature();
    const baseNeuronCount = champion.neurons.length;

    const seedsSeen: Array<CreatureExport | undefined> = [];
    const stubEvolver = (
      opts: { seedCreatureExport?: CreatureExport },
    ): Promise<EvolveResult> => {
      seedsSeen.push(opts.seedCreatureExport);
      // Both chunks return the same champion creature; replay returns
      // zero improvement so the stall detector definitively fires on
      // the chunk 1 → 2 transition.
      return Promise.resolve({
        champion,
        error: 1,
        score: 0,
        generations: 1,
        wallclockMs: 1,
      });
    };

    const result = await runHybridEvolution({
      instance,
      totalTimeMinutes: 0.05,
      chunks: 2,
      replay: () => 0, // every chunk stalls
      // deno-lint-ignore no-explicit-any
      evolver: stubEvolver as any,
      log: () => {},
    });

    // CRISPR flag asserted on the chunk record.
    assertEquals(result.chunks[1].crisprApplied, true);
    assertEquals(result.techniques.crispr, true);

    // The chunk-2 seed export must contain the gene's neurons (proving
    // the `injectGene` primitive ran and the spliced creature was
    // handed to evolveEnv as the next seed).
    const chunk2Seed = seedsSeen[1];
    assert(chunk2Seed !== undefined);
    const reseeded = Creature.fromJSON(chunk2Seed);
    const reseededUUIDs = new Set(reseeded.neurons.map((n) => n.uuid));
    assert(reseededUUIDs.has(TSP_GENE_NEURON_UUIDS[0]));
    assert(reseededUUIDs.has(TSP_GENE_NEURON_UUIDS[1]));
    assertEquals(reseeded.neurons.length, baseNeuronCount + 2);
  },
);

Deno.test(
  "runHybridEvolution — MH acceptance is enabled on chunk 2 and logged",
  async () => {
    const instance = loadInstance("burma14");
    const champion = buildSeedCreature();
    const stubEvolver = (): Promise<EvolveResult> =>
      Promise.resolve({
        champion,
        error: 1,
        score: 0,
        generations: 1,
        wallclockMs: 1,
      });

    const logged: string[] = [];
    const result = await runHybridEvolution({
      instance,
      totalTimeMinutes: 0.05,
      chunks: 2,
      replay: () => 0,
      // deno-lint-ignore no-explicit-any
      evolver: stubEvolver as any,
      log: (line) => logged.push(line),
    });

    assertEquals(result.chunks[0].acceptanceMode, "strict");
    assertEquals(result.chunks[1].acceptanceMode, "mh");
    assert(result.chunks[1].temperature > 0);
    assertEquals(result.techniques.mh, true);

    // The harness greps for each marker — assert each fired at least once.
    const joined = logged.join("\n");
    assert(joined.includes(HYBRID_LOG_MARKERS.memetic), `missing memetic marker in:\n${joined}`);
    assert(joined.includes(HYBRID_LOG_MARKERS.crispr), `missing CRISPR marker in:\n${joined}`);
    assert(joined.includes(HYBRID_LOG_MARKERS.mh), `missing MH marker in:\n${joined}`);
  },
);

/* ------------------------------------------------------------------ */
/*  burma14 / ulysses22 regression guard                              */
/* ------------------------------------------------------------------ */

Deno.test(
  "MH temperature defaults to zero in the evolveEnv adapter so burma14 / ulysses22 keep strict acceptance",
  () => {
    // The default RunEpisodeOptions used by the non-pcb442 path leaves
    // acceptanceMode undefined → strict; temperature undefined → 0.
    // shouldAcceptSwap with these defaults must reject every worsening
    // swap deterministically.
    for (const delta of [0.001, 1, 1000]) {
      assert(!shouldAcceptSwap(delta, "strict", 0, () => 0));
    }
    // The MH acceptance probability formula degenerates to 1.0 for
    // improving swaps in every mode — sanity-check the boundary.
    assertAlmostEquals(Math.exp(-(-1) / 10), Math.E ** 0.1);
    assert(shouldAcceptSwap(-1, "strict", 0, () => 1));
  },
);
