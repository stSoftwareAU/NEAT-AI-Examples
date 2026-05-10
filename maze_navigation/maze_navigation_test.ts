/**
 * Unit tests for the maze-navigation NEAT controller. "What" tests
 * only — each test calls a real function, runs the simulator or
 * evolver, and asserts on the observable outputs.
 */
import { assert, assertEquals, assertGreaterOrEqual } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import {
  buildRandomPopulation,
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveMazeController,
  formatEvolutionCsv,
  type GenerationInfo,
  mutateCreatureExport,
  renderTopologyChartSvg,
  replayController,
  scoreController,
  SOLVED_THRESHOLD,
} from "./maze_navigation.ts";
import { renderRunSVG } from "./svg.ts";
import { INPUT_COUNT, OUTPUT_COUNT } from "./agent.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

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
    // Compare via JSON to ignore property ordering.
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
  // Resulting creature must still validate.
  Creature.fromJSON(child).validate();
});

Deno.test("scoreController returns a finite score for an arbitrary creature", () => {
  const pop = buildRandomPopulation(2, 1);
  const creature = Creature.fromJSON(pop[0]);
  const result = scoreController(creature, 50);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assertGreaterOrEqual(result.steps, 1);
});

Deno.test(
  "evolveMazeController generation-1 population is noise on average",
  () => {
    // Gen 1 must be noise. The maze L-corridor cannot be solved by a
    // uniform-random linear policy on the very first try — the
    // **population mean** sits well below SOLVED_THRESHOLD, confirming
    // the population as a whole has not been warm-started.
    let firstGenMean = -Infinity;
    let firstGenBestReached = true;
    // Audit issue #223 replaced `maxGenerations` with the standard
    // NEAT-AI `targetError` + `timeoutMinutes` stop conditions. We use
    // `iterations: 1` so the loop terminates immediately after gen 0.
    evolveMazeController({
      ...DEFAULT_EVOLVE_OPTIONS,
      iterations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === -Infinity) {
          firstGenMean = info.meanScore;
          firstGenBestReached = info.bestReached;
        }
      },
    });
    assert(
      firstGenMean < SOLVED_THRESHOLD,
      `expected gen-1 population mean to be well below the SOLVED_THRESHOLD ` +
        `(${SOLVED_THRESHOLD}), got ${firstGenMean}`,
    );
    // The default seed must not produce a gen-1 population whose best
    // member already reaches the goal — that would mean we got lucky
    // and the evolution narrative has nothing to show.
    assertEquals(
      firstGenBestReached,
      false,
      "gen-1 best member must not already reach the goal under the default seed",
    );
  },
);

Deno.test(
  "evolveMazeController honours the iterations generation cap",
  () => {
    // Audit issue #223 replaced the old `maxGenerations` cap with the
    // standard NEAT-AI `targetError` + `timeoutMinutes` stop conditions
    // plus an optional `iterations` deterministic cap. With a vanishing
    // mutation rate the evolver cannot solve the task within the cap,
    // so the result must stop at the cap and report `solved=false`.
    const cap = 3;
    const result = evolveMazeController({
      seed: 999,
      populationSize: 4,
      targetError: -1, // unreachable: target score = 2 > 1
      timeoutMinutes: 1,
      iterations: cap,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
    });
    assertEquals(
      result.generations,
      cap,
      `expected evolution to run to the iterations cap of ${cap} generations, got ${result.generations}`,
    );
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve the maze within the cap",
    );
    assertEquals(
      result.stopReason,
      "iterations",
      `expected stopReason 'iterations', got ${result.stopReason}`,
    );
  },
);

Deno.test(
  "evolveMazeController honours the timeoutMinutes wall-clock backstop",
  () => {
    // Audit issue #223: with an unreachable target and a vanishing
    // budget the loop must exit via the wall-clock backstop and report
    // `stopReason='timeout'`.
    const result = evolveMazeController({
      seed: 999,
      populationSize: 4,
      targetError: -1, // unreachable
      timeoutMinutes: 0.005, // ~300 ms
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
    });
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve the maze",
    );
    assertEquals(
      result.stopReason,
      "timeout",
      `expected stopReason 'timeout', got ${result.stopReason}`,
    );
  },
);

Deno.test("evolveMazeController champion reaches the goal under the default seed", async () => {
  const result = evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
  assertEquals(
    result.solved,
    true,
    `expected the champion's score to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
      `got ${result.bestScore} after ${result.generations} generations`,
  );
  assertEquals(
    result.championReached,
    true,
    `expected the champion to reach the goal, got finalDistance=${result.championFinalDistance}`,
  );
  assertGreaterOrEqual(result.bestScore, SOLVED_THRESHOLD);
  // Champion must serialise cleanly for downstream consumption.
  const tmp = await Deno.makeTempDir({ prefix: "maze_test_" });
  try {
    const path = join(tmp, "champion.json");
    await safeWriteJson(path, result.champion.exportJSON());
    assertEquals(existsSync(path), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("evolveMazeController is reproducible — fixed seed produces byte-identical champions", () => {
  const a = evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
  const b = evolveMazeController(DEFAULT_EVOLVE_OPTIONS);
  const aJson = JSON.stringify(a.champion.exportJSON());
  const bJson = JSON.stringify(b.champion.exportJSON());
  assertEquals(aJson, bJson, "champions from the same seed must serialise identically");
  assertEquals(a.bestScore, b.bestScore);
  assertEquals(a.championReached, b.championReached);
});

Deno.test("replayController returns a non-empty trace starting at the start cell", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  assert(trace.length > 0);
  assertEquals(trace[0].steps, 0);
  assertEquals(trace[0].position, trace[0].maze.start);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const pop = buildRandomPopulation(6, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Agent cx/cy, goal pulse opacity, progress bar width.
  assertGreaterOrEqual(animateMatches.length, 4);
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const pop = buildRandomPopulation(7, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('repeatCount="indefinite"'));
});

Deno.test("renderRunSVG draws the agent circle, footprint polyline, and goal pulse", () => {
  const pop = buildRandomPopulation(8, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="agent"'), "expected the agent circle");
  assert(svg.includes('class="footprint"'), "expected the footprint polyline");
  assert(svg.includes('class="goal-pulse"'), "expected the goal pulse overlay");
  assert(svg.includes('class="walls"'), "expected the walls group");
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
  "evolveMazeController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  () => {
    const tmp = Deno.makeTempDirSync({ prefix: "maze_snapshots_test_" });
    try {
      // Tiny population, weak mutation, low cap so the evolver does
      // not accidentally hit SOLVED_THRESHOLD before all configured
      // checkpoints fire.
      const checkpoints = [1, 2, 3];
      evolveMazeController({
        seed: 1,
        populationSize: 3,
        targetError: -1, // unreachable so the loop runs to the iterations cap
        timeoutMinutes: 1,
        iterations: 4,
        mutationStrength: 0.05,
        mutationRate: 0.05,
        addNeuronRate: 0,
        snapshotConfig: { checkpoints, outputDir: tmp },
      });

      for (const gen of checkpoints) {
        assertEquals(
          existsSync(join(tmp, `snapshot-gen-${gen}.json`)),
          true,
          `expected snapshot-gen-${gen}.json to exist`,
        );
      }

      const snapshots = loadSnapshots(tmp);
      assertEquals(snapshots.length, checkpoints.length);

      const svg = renderEvolutionProgressSvg(snapshots, {
        title: "Maze Navigation — Evolution Progress",
      });
      assert(svg.startsWith("<svg"), "must start with <svg>");
      assert(svg.length > 0, "SVG must be non-empty");
      const panels = svg.match(/<g class="panel"/g) ?? [];
      assertEquals(panels.length, checkpoints.length);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveMazeController emits GenerationInfo with sensible neuron and synapse counts",
  () => {
    const samples: GenerationInfo[] = [];
    evolveMazeController({
      seed: 1,
      populationSize: 3,
      targetError: -1, // unreachable so the loop runs to the iterations cap
      timeoutMinutes: 1,
      iterations: 3,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      addNeuronRate: 0,
      onGeneration: (info) => samples.push(info),
    });
    assert(samples.length > 0, "expected at least one onGeneration call");
    for (const info of samples) {
      // Without structural mutation the topology stays at the library's
      // minimal seed: INPUT_COUNT inputs + OUTPUT_COUNT outputs and
      // INPUT_COUNT * OUTPUT_COUNT direct synapses.
      assertEquals(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertEquals(info.synapses, INPUT_COUNT * OUTPUT_COUNT);
      assert(Number.isFinite(info.bestScore));
      assert(Number.isFinite(info.meanScore));
    }
  },
);

Deno.test(
  "formatEvolutionCsv emits the audit-mandated header and one row per record",
  () => {
    // Audit issue #223: CSV header must be the canonical schema used by
    // every audited example.
    const rows: EvolutionRow[] = [
      { generation: 0, bestFitness: 0.12, meanFitness: 0.05, neuronCount: 9, synapseCount: 20 },
      { generation: 1, bestFitness: 0.6, meanFitness: 0.3, neuronCount: 10, synapseCount: 21 },
    ];
    const csv = formatEvolutionCsv(rows);
    const lines = csv.trim().split("\n");
    assertEquals(lines[0], EVOLUTION_CSV_HEADER);
    assertEquals(
      EVOLUTION_CSV_HEADER,
      "generation,best_fitness,mean_fitness,neuron_count,synapse_count",
    );
    assertEquals(lines.length, rows.length + 1);
    assertEquals(lines[1], "0,0.12,0.05,9,20");
    assertEquals(lines[2], "1,0.6,0.3,10,21");
    // Determinism: identical inputs produce identical bytes.
    assertEquals(formatEvolutionCsv(rows), csv);
  },
);

Deno.test("renderTopologyChartSvg produces a well-formed SVG referencing both lines", () => {
  const rows: EvolutionRow[] = [
    { generation: 0, bestFitness: 0.1, meanFitness: 0.05, neuronCount: 9, synapseCount: 20 },
    { generation: 5, bestFitness: 0.4, meanFitness: 0.2, neuronCount: 10, synapseCount: 21 },
    { generation: 10, bestFitness: 0.9, meanFitness: 0.6, neuronCount: 12, synapseCount: 24 },
  ];
  const svg = renderTopologyChartSvg(rows);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  assert(svg.includes("neuron-count"), "expected neuron-count polyline");
  assert(svg.includes("synapse-count"), "expected synapse-count polyline");
  assert(svg.includes("Maze Navigation — Topology Growth"));
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

Deno.test("buildRandomPopulation members all serialise as CreatureExport", () => {
  const pop = buildRandomPopulation(2024, 3);
  for (const json of pop) {
    const exported: CreatureExport = json;
    // Round-trip via Creature must preserve the input/output count.
    const c = Creature.fromJSON(exported);
    const round = c.exportJSON();
    assertEquals(round.input, exported.input);
    assertEquals(round.output, exported.output);
  }
});
