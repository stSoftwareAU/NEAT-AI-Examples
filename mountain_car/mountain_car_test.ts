/**
 * Unit tests for the Mountain-Car NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 *
 * Issue #154 replaced the fixed-architecture, bounded-random seed
 * creature with a uniform-random NEAT population built from
 * `createSeededPopulation(...)`. The legacy `buildInitialCreatureJSON`,
 * `randomCreatureJSON`, `genesFromCreatureJSON`, and `mutateCreatureJSON`
 * helpers are gone, so the tests that exercised them are gone too.
 * Their replacements are tested below.
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import {
  buildRandomPopulation,
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  evolveMountainCarController,
  type GenerationInfo,
  INPUT_COUNT,
  MAX_STEPS,
  mutateCreatureExport,
  OUTPUT_COUNT,
  replayController,
  scoreController,
  scoreSwingUpPolicy,
  SOLVED_THRESHOLD,
  SUCCESS_BONUS,
} from "./mountain_car.ts";
import { renderRunSVG } from "./svg.ts";
import { GOAL_POSITION } from "./physics.ts";
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
    const out = creature.activate(Float32Array.from([0, 0]));
    assertEquals(out.length, OUTPUT_COUNT);
    for (let i = 0; i < OUTPUT_COUNT; i++) {
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
  // neurons. Hidden structure must emerge from mutation, not be
  // supplied by the example.
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

Deno.test("decodeAction picks the argmax over the three outputs", () => {
  // Index 0 highest → push left.
  assertEquals(decodeAction([0.9, 0.1, 0.2]), -1);
  // Index 1 highest → coast.
  assertEquals(decodeAction([0.1, 0.9, 0.2]), 0);
  // Index 2 highest → push right.
  assertEquals(decodeAction([0.1, 0.2, 0.9]), 1);
});

Deno.test("scoreSwingUpPolicy solves the task with a score above the failure baseline", () => {
  const result = scoreSwingUpPolicy(MAX_STEPS);
  assertEquals(result.solved, true, "swing-up policy should solve the task");
  assertGreater(result.score, 0, "successful run must score above the failure baseline");
  assertGreaterOrEqual(SUCCESS_BONUS, result.score);
});

Deno.test("scoreController returns a finite mean score and a summit fraction", () => {
  const pop = buildRandomPopulation(2, 1);
  const creature = Creature.fromJSON(pop[0]);
  const result = scoreController(creature, MAX_STEPS);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assertGreaterOrEqual(result.summitRate, 0);
  assertGreaterOrEqual(1, result.summitRate);
});

Deno.test(
  "scoreController with multiple trials returns the mean across trials",
  () => {
    // Sanity: same trialSeed is deterministic, summitRate ∈ [0, 1].
    const pop = buildRandomPopulation(99, 1);
    const json: CreatureExport = pop[0];
    const a = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 4,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    const b = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 4,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    assertEquals(a.score, b.score);
    assertEquals(a.summitRate, b.summitRate);
    assertEquals(a.trials, 4);
    assertGreaterOrEqual(a.summitRate, 0);
    assertGreaterOrEqual(1, a.summitRate);
  },
);

Deno.test(
  "evolveMountainCarController generation-1 population is noise on average",
  () => {
    // Gen 1 is uniform-random NEAT noise — controllers built from
    // direct input → output connections with random weights almost
    // never reach the goal flag, so the population mean per-trial
    // score sits at the failure baseline (≈ FAILURE_FLAT_PENALTY plus
    // a small partial-credit term) — far below any successful score.
    let firstGenMean = Infinity;
    let firstGenBestSummit = Infinity;
    evolveMountainCarController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === Infinity) {
          firstGenMean = info.meanScore;
          firstGenBestSummit = info.bestSummitRate;
        }
      },
    });
    // A successful run scores at least SUCCESS_BONUS minus a step
    // penalty bounded by SUCCESS_BONUS, i.e. a successful score is
    // strictly positive. A noisy population dominated by failures
    // therefore has a non-positive mean — well below half the
    // successful-run floor.
    assert(
      firstGenMean < SUCCESS_BONUS / 4,
      `expected gen-1 population mean to be well below SUCCESS_BONUS/4 ` +
        `(${SUCCESS_BONUS / 4}), got ${firstGenMean}`,
    );
    // It is theoretically possible for a lucky random NEAT genome to
    // already swing the car up, but its summit rate cannot already be
    // at the threshold — that would defeat the noise narrative.
    assert(
      firstGenBestSummit < SOLVED_THRESHOLD,
      `expected gen-1 best summit rate to be below the solve threshold ` +
        `${SOLVED_THRESHOLD}, got ${firstGenBestSummit}`,
    );
  },
);

Deno.test(
  "evolveMountainCarController honours the hard generation cap",
  () => {
    // With a tiny strength and tiny rate, the evolver cannot solve the
    // task within the cap. The result must therefore stop at the cap
    // and report `solved=false`.
    const cap = 3;
    const result = evolveMountainCarController({
      seed: 999,
      populationSize: 4,
      maxGenerations: cap,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.05,
    });
    assertEquals(
      result.generations,
      cap,
      `expected evolution to run to the hard cap of ${cap} generations, got ${result.generations}`,
    );
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve mountain-car within the cap",
    );
    assert(
      result.summitRate < SOLVED_THRESHOLD,
      `expected summit rate below threshold, got ${result.summitRate}`,
    );
  },
);

Deno.test(
  "evolveMountainCarController finds a champion that meets SOLVED_THRESHOLD with the default seed",
  async () => {
    const result = evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion's summit rate to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
        `got ${result.summitRate} after ${result.generations} generations ` +
        `(score=${result.bestScore})`,
    );
    assertGreaterOrEqual(result.summitRate, SOLVED_THRESHOLD);

    // Champion must serialise cleanly for downstream consumption.
    const tmp = await Deno.makeTempDir({ prefix: "mountain_car_test_" });
    try {
      const path = join(tmp, "champion.json");
      await safeWriteJson(path, result.champion.exportJSON());
      assertEquals(existsSync(path), true);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "evolveMountainCarController emits GenerationInfo with sensible neuron and synapse counts",
  () => {
    const samples: GenerationInfo[] = [];
    evolveMountainCarController({
      seed: 1,
      populationSize: 3,
      maxGenerations: 3,
      mutationStrength: 0.05,
      mutationRate: 0.05,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.05,
      onGeneration: (info) => samples.push(info),
    });
    assertGreater(samples.length, 0, "expected at least one onGeneration call");
    for (const info of samples) {
      // Without structural mutation the topology stays at the library's
      // minimal seed: 2 inputs + 3 outputs = 5 neurons and 2 * 3 synapses.
      assertEquals(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertEquals(info.synapses, INPUT_COUNT * OUTPUT_COUNT);
      assertGreaterOrEqual(info.bestSummitRate, 0);
      assertGreaterOrEqual(1, info.bestSummitRate);
    }
  },
);

Deno.test(
  "evolveMountainCarController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  () => {
    const tmp = Deno.makeTempDirSync({ prefix: "mountain_car_snapshots_test_" });
    try {
      // Tiny population + weak mutation so the loop does not solve in a
      // single generation and trigger early-stop before all checkpoints
      // fire.
      const checkpoints = [1, 2, 3];
      evolveMountainCarController({
        seed: 1,
        populationSize: 3,
        maxGenerations: 4,
        mutationStrength: 0.05,
        mutationRate: 0.05,
        addNeuronRate: 0,
        trials: 2,
        trialSeed: 1,
        initialPerturbation: 0.05,
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
        title: "Mountain Car — Evolution Progress",
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

Deno.test("replayController returns a non-empty trace starting at the initial state", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(trace[0].x, -0.5);
  assertEquals(trace[0].v, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  const pop = buildRandomPopulation(6, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  // Three on the car (cx, cy, fill) plus one on the progress bar.
  assertGreaterOrEqual(animateMatches.length, 4);
});

Deno.test("renderRunSVG draws the goal flag", () => {
  const pop = buildRandomPopulation(8, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="goal"'), "expected the goal flag group");
  assert(svg.includes('class="hill"'), "expected the hill profile path");
  assert(svg.includes('class="car"'), "expected the animated car");
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  const pop = buildRandomPopulation(9, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
});

Deno.test("renderRunSVG colour change appears once the trace crosses the flag line", () => {
  // Synthesise a trace that ends past the flag — we just want to
  // confirm the renderer emits the success colour somewhere in the
  // fill-keyframe list when the trace crosses the threshold.
  const trace = [
    { x: -0.5, v: 0 },
    { x: 0.0, v: 0.05 },
    { x: GOAL_POSITION, v: 0.06 },
    { x: 0.55, v: 0.06 },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes("#2ecc71"), "expected the success-green keyframe in the fill animation");
});

Deno.test(
  "running mountain_car.ts via run.sh-style execution emits champion.json and SVG",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "mountain_car_smoke_" });
    try {
      ensureDirSync(join(tmp, "screenshots"));
      const result = evolveMountainCarController(DEFAULT_EVOLVE_OPTIONS);
      const trace = replayController(result.champion);
      const svg = renderRunSVG(trace);
      const svgPath = join(tmp, "screenshots", "mountain_car.svg");
      await Deno.writeTextFile(svgPath, svg);
      const written = await Deno.readTextFile(svgPath);
      assert(written.startsWith("<svg"));
      const championPath = join(tmp, "champion.json");
      await safeWriteJson(championPath, result.champion.exportJSON());
      assertEquals(existsSync(championPath), true);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
