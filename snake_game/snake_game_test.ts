/**
 * Unit tests for the Snake-game NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs.
 *
 * The controller now starts evolution from uniform-random NEAT noise
 * (issue #150). The previous hand-crafted layered topology has been
 * removed; hidden neurons emerge only from structural mutation.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreaterOrEqual,
  assertNotEquals,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { createDeterministicRandom } from "../common/deterministic_random.ts";
import {
  buildRandomPopulation,
  DEFAULT_EVAL_SEEDS,
  DEFAULT_EVOLVE_OPTIONS,
  evaluateController,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveSnakeController,
  formatEvolutionCsv,
  type GenerationInfo,
  mutateCreatureExport,
  pickBestReplaySeed,
  renderTopologyChartSvg,
  replayController,
  scoreController,
  SOLVED_THRESHOLD,
} from "./snake_game.ts";
import { renderRunSVG } from "./svg.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";

Deno.test("buildRandomPopulation produces uniform-random NEAT genomes", () => {
  // Topology must NOT be hand-specified — the library decides shape.
  // We assert only that the population has the requested size and that
  // every member is a valid Creature with the right input/output counts.
  const pop = buildRandomPopulation(42, 5);
  assertEquals(pop.length, 5);
  for (const json of pop) {
    assertEquals(json.input, INPUT_COUNT);
    assertEquals(json.output, OUTPUT_COUNT);
    const creature = Creature.fromJSON(json);
    creature.validate();
    creature.clearState();
    const out = creature.activate(new Float32Array(INPUT_COUNT));
    assertEquals(out.length, OUTPUT_COUNT);
    for (let i = 0; i < out.length; i++) {
      assert(Number.isFinite(out[i]), `expected finite output, got ${out[i]}`);
    }
  }
});

Deno.test("buildRandomPopulation is deterministic for the same seed", () => {
  const a = buildRandomPopulation(99, 4);
  const b = buildRandomPopulation(99, 4);
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assertEquals(JSON.stringify(a[i]), JSON.stringify(b[i]));
  }
});

Deno.test("buildRandomPopulation does not hand-specify hidden topology", () => {
  // Generation-1 noise: the library's minimal seed has zero hidden
  // neurons and direct input → output connections. Hidden structure
  // must emerge from mutation, not be supplied by the example.
  const pop = buildRandomPopulation(7, 3);
  for (const json of pop) {
    const hiddenNeurons = json.neurons.filter((n) => n.type === "hidden");
    assertEquals(
      hiddenNeurons.length,
      0,
      "no hidden neurons should be hand-specified in the initial population",
    );
  }
});

Deno.test("mutateCreatureExport yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const pop = buildRandomPopulation(1, 1);
  const child = mutateCreatureExport(pop[0], random, 1.0, 0.3);
  const creature = Creature.fromJSON(child);
  creature.validate();
});

Deno.test("mutateCreatureExport is deterministic for the same random stream", () => {
  const pop = buildRandomPopulation(5, 1);
  const a = mutateCreatureExport(pop[0], createDeterministicRandom(11), 0.8, 0.2);
  const b = mutateCreatureExport(pop[0], createDeterministicRandom(11), 0.8, 0.2);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("mutateCreatureExport with addNeuronRate=1 grows topology", () => {
  // Forcing addNeuronRate=1 must split exactly one synapse, adding
  // one hidden neuron and replacing one synapse with two.
  const pop = buildRandomPopulation(3, 1);
  const parent = pop[0];
  const random = createDeterministicRandom(13);
  const child = mutateCreatureExport(parent, random, 0, 0, {
    addNeuronRate: 1,
    hiddenCounter: { value: 0 },
  });
  const parentHidden = parent.neurons.filter((n) => n.type === "hidden").length;
  const childHidden = child.neurons.filter((n) => n.type === "hidden").length;
  assertEquals(childHidden - parentHidden, 1, "expected exactly one new hidden neuron");
  assertEquals(
    child.synapses.length - parent.synapses.length,
    1,
    "splitting one synapse adds one net synapse (-1 + 2)",
  );
  Creature.fromJSON(child).validate();
});

Deno.test("scoreController returns a finite score and fitness for a random creature", () => {
  const pop = buildRandomPopulation(2, 1);
  const creature = Creature.fromJSON(pop[0]);
  const result = scoreController(creature, 1234, 100);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assert(Number.isFinite(result.fitness), `expected finite fitness, got ${result.fitness}`);
  assertGreaterOrEqual(result.steps, 1);
});

Deno.test("evaluateController averages metrics across the seed set", () => {
  const pop = buildRandomPopulation(2, 1);
  const json: CreatureExport = pop[0];
  const seeds = [1, 2, 3];
  const result = evaluateController(Creature.fromJSON(json), seeds, 50);
  let total = 0;
  for (const s of seeds) total += scoreController(Creature.fromJSON(json), s, 50).score;
  assertAlmostEquals(result.score, total / seeds.length, 1e-9);
});

Deno.test("pickBestReplaySeed returns a seed from the supplied list", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const pick = pickBestReplaySeed(creature, [11, 22, 33], 50);
  assert([11, 22, 33].includes(pick.seed));
  assert(Number.isFinite(pick.score));
});

Deno.test(
  "evolveSnakeController gen-1 best-eaten is well below the solved threshold",
  () => {
    // Gen 1 must be noise — the very first generation comes straight
    // from `new Creature(input, output)` with random weights, so the
    // best controller in the population should be very far from
    // eating SOLVED_THRESHOLD food on average. Anything close to the
    // threshold on gen 1 would imply a warm start.
    //
    // Audit issue #222 replaced `maxGenerations` with the standard
    // NEAT-AI `targetError` + `timeoutMinutes` stop conditions. We pin
    // `maxGenerations: 1` so the loop exits after one generation
    // regardless of fitness — the cap is retained as a tests-only
    // safety override.
    let firstGenBestEaten = Infinity;
    evolveSnakeController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenBestEaten === Infinity) {
          firstGenBestEaten = info.bestEaten;
        }
      },
    });
    assert(
      firstGenBestEaten < SOLVED_THRESHOLD,
      `expected gen-1 best-eaten to sit below the solved threshold ` +
        `(${SOLVED_THRESHOLD}), got ${firstGenBestEaten}`,
    );
  },
);

Deno.test(
  "evolveSnakeController honours the timeoutMinutes wall-clock backstop",
  () => {
    // Audit issue #222 replaced the old `maxGenerations` cap with the
    // standard NEAT-AI `targetError` + `timeoutMinutes` stop conditions.
    // With a vanishingly small mutation rate, the evolver cannot solve
    // the task. We force the loop to exit via the wall-clock backstop
    // by setting an unreachable `targetError = -1` (target rate = 2,
    // bounded above by 1) and a tiny `timeoutMinutes` budget — the
    // returned `stopReason` must be `timeout` and `solved` false.
    const start = Date.now();
    const result = evolveSnakeController({
      seed: 999,
      populationSize: 4,
      targetError: -1,
      timeoutMinutes: 0.01, // ~600 ms
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
    });
    const elapsedMs = Date.now() - start;
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve snake within the timeout",
    );
    assertEquals(
      result.stopReason,
      "timeout",
      `expected stopReason 'timeout', got ${result.stopReason}`,
    );
    assert(
      elapsedMs < 30_000,
      `expected the run to finish well under 30 seconds, took ${elapsedMs} ms`,
    );
  },
);

Deno.test(
  "evolveSnakeController honours the optional maxGenerations safety cap",
  () => {
    // The optional `maxGenerations` field is retained as a tests-only
    // safety cap. With vanishing mutation and a tiny cap the loop must
    // exit at the cap and report `stopReason='cap'`.
    const cap = 3;
    const result = evolveSnakeController({
      seed: 999,
      populationSize: 4,
      targetError: -1,
      timeoutMinutes: 5,
      maxGenerations: cap,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
    });
    assertEquals(
      result.generations,
      cap,
      `expected evolution to run to the cap of ${cap} generations, got ${result.generations}`,
    );
    assertEquals(result.solved, false);
    assertEquals(result.stopReason, "cap");
  },
);

Deno.test(
  "evolveSnakeController champion reaches the SOLVED_THRESHOLD on its best replay seed",
  async () => {
    // The threshold is applied to the **best per-seed eaten count** —
    // the same number the SVG playthrough renders after
    // `pickBestReplaySeed`. This matches closed issue #137's
    // "champion ate at least three food on the replay episode"
    // target, but the bar means more here because evolution starts
    // from uniform-random NEAT noise.
    const result = evolveSnakeController(DEFAULT_EVOLVE_OPTIONS);
    assertGreaterOrEqual(
      result.championEaten,
      SOLVED_THRESHOLD,
      `expected the champion to eat at least ${SOLVED_THRESHOLD} food on its best ` +
        `replay seed, got ${result.championEaten} after ${result.generations} generations`,
    );
    assertEquals(
      result.solved,
      true,
      `expected the champion to be flagged solved (best=${result.championEaten}, ` +
        `avg=${result.championEatenAvg})`,
    );
    // Champion must serialise cleanly for downstream consumption.
    const tmp = await Deno.makeTempDir({ prefix: "snake_test_" });
    try {
      const path = join(tmp, "champion.json");
      await safeWriteJson(path, result.champion.exportJSON());
      assertEquals(existsSync(path), true);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test("evolveSnakeController is reproducible — fixed seed, identical champion", () => {
  // Pin the loop to a small generation cap so the test does not race
  // the wall-clock backstop. Determinism applies regardless of stop
  // condition.
  const a = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, maxGenerations: 30 });
  const b = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, maxGenerations: 30 });
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertEquals(aJson, bJson, "champions from the same seed must serialise identically");
  assertEquals(a.bestScore, b.bestScore);
  assertEquals(a.championEaten, b.championEaten);
  assertEquals(a.championReplaySeed, b.championReplaySeed);
});

Deno.test("evolveSnakeController with different seeds produces different champions", () => {
  const a = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 1, maxGenerations: 8 });
  const b = evolveSnakeController({ ...DEFAULT_EVOLVE_OPTIONS, seed: 2, maxGenerations: 8 });
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertNotEquals(aJson, bJson);
});

Deno.test("DEFAULT_EVAL_SEEDS contains at least three distinct seeds", () => {
  // Multi-episode evaluation is what stops the controller overfitting
  // to a single food sequence — guard the eval set so a future tweak
  // cannot quietly drop it back to one seed.
  const distinct = new Set(DEFAULT_EVAL_SEEDS);
  assertGreaterOrEqual(distinct.size, 3);
});

Deno.test(
  "evolveSnakeController emits neurons and synapses on each generation event",
  () => {
    // Issue #110: the per-generation event must include neuron and
    // synapse counts so the runner can plot them on the evolution
    // chart. With addNeuronRate=0 the topology stays at the library's
    // minimal seed: INPUT_COUNT + OUTPUT_COUNT neurons and
    // INPUT_COUNT * OUTPUT_COUNT direct synapses.
    const events: GenerationInfo[] = [];
    evolveSnakeController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 3,
      targetError: -1,
      populationSize: 6,
      addNeuronRate: 0,
      onGeneration: (info) => events.push(info),
    });
    assertGreaterOrEqual(events.length, 1);
    for (const info of events) {
      assertEquals(typeof info.neurons, "number");
      assertEquals(typeof info.synapses, "number");
      assertEquals(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertEquals(info.synapses, INPUT_COUNT * OUTPUT_COUNT);
    }
  },
);

Deno.test("evolveSnakeController emits checkpoint snapshot files when configured", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "snake_snap_" });
  try {
    const checkpoints = [1, 2, 3];
    evolveSnakeController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 4,
      targetError: -1,
      // Force a tiny, weak run so the early-stop branch cannot fire
      // before every checkpoint is captured.
      populationSize: 3,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
      snapshotConfig: { checkpoints, outputDir: tmp },
    });
    for (const gen of checkpoints) {
      assertEquals(existsSync(join(tmp, `snapshot-gen-${gen}.json`)), true);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("replayController returns a non-empty trace starting at the initial state", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 4242, 50);
  assert(trace.length > 0);
  assertEquals(trace[0].steps, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 4242, 30);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Many animate nodes — food x/y/opacity, score colour, progress bar,
  // and one trio per snake segment.
  assertGreaterOrEqual(animateMatches.length, 6);
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 4242, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('repeatCount="indefinite"'));
});

Deno.test("renderRunSVG draws the snake head and food cells", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 4242, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="snake-head"'), "expected the snake head element");
  assert(svg.includes('class="food"'), "expected the food element");
  assert(svg.includes('class="board"'), "expected the checker board background");
});

Deno.test("renderRunSVG rejects an empty trace", () => {
  let threw = false;
  try {
    renderRunSVG([]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test(
  "formatEvolutionCsv emits the audit-mandated header and one row per record",
  () => {
    // Audit issue #222: CSV header must be the canonical schema used
    // by every audited example.
    const rows: EvolutionRow[] = [
      { generation: 0, bestFitness: -75.5, meanFitness: -90.1, neuronCount: 12, synapseCount: 32 },
      { generation: 1, bestFitness: 42.0, meanFitness: -10.0, neuronCount: 13, synapseCount: 33 },
    ];
    const csv = formatEvolutionCsv(rows);
    const lines = csv.trim().split("\n");
    assertEquals(lines[0], EVOLUTION_CSV_HEADER);
    assertEquals(
      EVOLUTION_CSV_HEADER,
      "generation,best_fitness,mean_fitness,neuron_count,synapse_count",
    );
    assertEquals(lines.length, rows.length + 1);
    assertEquals(lines[1], "0,-75.5,-90.1,12,32");
    assertEquals(lines[2], "1,42,-10,13,33");
    // Determinism: identical inputs produce identical bytes.
    assertEquals(formatEvolutionCsv(rows), csv);
  },
);

Deno.test("renderTopologyChartSvg produces a well-formed SVG referencing both lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 0, bestFitness: -50, meanFitness: -90, neuronCount: 12, synapseCount: 32 },
    { generation: 5, bestFitness: 100, meanFitness: 10, neuronCount: 13, synapseCount: 34 },
    { generation: 10, bestFitness: 471, meanFitness: 200, neuronCount: 14, synapseCount: 36 },
  ];
  const svg = renderTopologyChartSvg(rows);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes("neuron-count"), "expected neuron-count polyline");
  assert(svg.includes("synapse-count"), "expected synapse-count polyline");
  assert(svg.includes("Snake — Topology Growth"));
});

Deno.test("renderTopologyChartSvg rejects empty input", () => {
  let threw = false;
  try {
    renderTopologyChartSvg([]);
  } catch (_err) {
    threw = true;
  }
  assertEquals(threw, true, "expected empty input to throw");
});
