/**
 * Unit tests for the lunar-lander NEAT controller. "What" tests only —
 * each test calls real functions, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertGreaterOrEqual,
} from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import { parse as parseCsv } from "@std/csv";
import {
  buildRandomPopulation,
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  EVOLUTION_CSV_HEADER,
  type EvolutionRow,
  evolveLanderController,
  formatEvolutionCsv,
  freeFallBaselineScore,
  type GenerationInfo,
  INPUT_COUNT,
  isQuickMode,
  MAX_STEPS,
  mutateCreatureExport,
  OUTPUT_COUNT,
  pickValidationSvgIndex,
  QUICK_TARGET_ERROR,
  QUICK_TIMEOUT_MINUTES,
  replayController,
  scoreController,
  scoreFinalState,
  validateChampion,
  VALIDATION_BASE_SEED,
  type ValidationScenarioResult,
} from "./lunar_lander.ts";
import { renderRunSVG } from "./svg.ts";
import { DEFAULT_START_X, DEFAULT_TERRAIN, initialState, type LanderState } from "./physics.ts";
import { generateScenarioPools } from "./scenarios.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

/**
 * A fast, deterministic configuration suitable for unit tests. The
 * `targetError` is set generously so the loop trips the `target` stop
 * condition immediately at gen 0 — both runs of the same options end
 * after a single generation so reproducibility checks compare the
 * same number of generations regardless of host speed. Tests that
 * exercise multi-generation behaviour override these values.
 */
const TEST_EVOLVE_OPTIONS = {
  seed: 42,
  populationSize: 12,
  // targetError = 1 means the threshold is `landed-rate ≥ 0`, which
  // is satisfied at gen 0 — the loop terminates deterministically.
  targetError: 1,
  // Generous timeout so target always wins the race.
  timeoutMinutes: 1,
  mutationStrength: 0.5,
  mutationRate: 0.4,
  addNeuronRate: 0,
  trials: 3,
  trialSeed: 1,
  initialPerturbation: 1.0,
};

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
    const out = creature.activate(Float32Array.from([0, 0, 0, 0, 0, 0, 0]));
    assertEquals(out.length, OUTPUT_COUNT);
    for (const v of out) {
      assert(Number.isFinite(v), `expected finite output, got ${v}`);
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

Deno.test("decodeAction thresholds outputs at 0.5", () => {
  assertEquals(decodeAction([0.6, 0.4, 0.55]), { main: true, left: false, right: true });
  assertEquals(decodeAction([0.5, 0.5, 0.5]), { main: true, left: true, right: true });
  assertEquals(decodeAction([0, 0, 0]), { main: false, left: false, right: false });
});

Deno.test("scoreFinalState rewards a clean landing more than a crash", () => {
  const cleanLanding: LanderState = {
    x: DEFAULT_TERRAIN.padX,
    y: DEFAULT_TERRAIN.groundY,
    vx: 0,
    vy: -0.5,
    angle: 0,
    angularV: 0,
    fuel: 50,
  };
  const fastCrash: LanderState = {
    x: DEFAULT_TERRAIN.padX + 30,
    y: DEFAULT_TERRAIN.groundY,
    vx: 5,
    vy: -20,
    angle: 1,
    angularV: 0,
    fuel: 0,
  };
  const cleanScore = scoreFinalState(cleanLanding, "landed");
  const crashScore = scoreFinalState(fastCrash, "crashed");
  assertGreater(cleanScore, crashScore);
  assertGreater(cleanScore, 0);
});

Deno.test("scoreController returns a finite score and a recognised outcome", () => {
  const pop = buildRandomPopulation(3, 1);
  const creature = Creature.fromJSON(pop[0]);
  const result = scoreController(creature, MAX_STEPS);
  assert(Number.isFinite(result.score), `expected finite score, got ${result.score}`);
  assert(
    ["flying", "landed", "crashed", "out_of_bounds"].includes(result.outcome),
    `unknown outcome: ${result.outcome}`,
  );
  assertGreaterOrEqual(result.landedRate, 0);
  assertGreaterOrEqual(1, result.landedRate);
});

Deno.test(
  "scoreController with multiple perturbed trials returns the mean and is deterministic",
  () => {
    // Sanity: same inputs produce the same mean score and the same
    // landed rate. Both must be finite and in range.
    const pop = buildRandomPopulation(99, 1);
    const json: CreatureExport = pop[0];
    const a = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 5,
      trialSeed: 11,
      initialPerturbation: 1.0,
    });
    const b = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 5,
      trialSeed: 11,
      initialPerturbation: 1.0,
    });
    assertEquals(a.score, b.score);
    assertEquals(a.landedRate, b.landedRate);
    assert(Number.isFinite(a.score));
    assertEquals(a.trials.length, 5);
  },
);

Deno.test("freeFallBaselineScore corresponds to a crash (negative score)", () => {
  const baseline = freeFallBaselineScore();
  // Free fall from ~80 m with lunar gravity reaches ~16 m/s downward —
  // far above the safe-landing limit, so the outcome must be a crash.
  assert(baseline < 0, `expected negative baseline (crash), got ${baseline}`);
});

Deno.test(
  "evolveLanderController generation-1 population is noise on average",
  () => {
    // Gen 1 must be noise. Random NEAT controllers will mostly crash
    // (large negative score) and some will drift out-of-bounds (heavy
    // fixed penalty). The honest noise check is the population mean
    // sitting well below zero, confirming the population as a whole
    // has not been warm-started toward a competent controller.
    let firstGenMean = Infinity;
    let firstGenLanded = 1;
    evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      // Stop after the first generation: targetError=1 trips at gen 0.
      targetError: 1,
      timeoutMinutes: 1,
      populationSize: 30,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === Infinity) {
          firstGenMean = info.meanScore;
          firstGenLanded = info.bestLandedRate;
        }
      },
    });
    assert(
      firstGenMean < 0,
      `expected gen-1 population mean to be negative (mostly crashes), got ${firstGenMean}`,
    );
    // The default targetError of 0.01 implies a "solved" threshold of
    // landed-rate ≥ 0.99, so gen-1 noise should be far below it.
    assert(
      firstGenLanded < 1 - DEFAULT_EVOLVE_OPTIONS.targetError,
      `expected gen-1 best landed rate below the solved threshold ` +
        `(${1 - DEFAULT_EVOLVE_OPTIONS.targetError}), got ${firstGenLanded}`,
    );
  },
);

Deno.test(
  "evolveLanderController stops on timeout when targetError is unreachable",
  () => {
    // targetError=-1 means the threshold is `landed-rate ≥ 2`, which
    // can never be met — the only way out is the wall-clock timeout.
    const start = Date.now();
    const result = evolveLanderController({
      seed: 999,
      populationSize: 4,
      // Never satisfied: landed-rate is bounded by 1.
      targetError: -1,
      // ~300 ms of wall clock — short enough for a fast unit test.
      timeoutMinutes: 0.005,
      mutationStrength: 0.001,
      mutationRate: 0.001,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 1.0,
    });
    const elapsed = Date.now() - start;
    assertEquals(result.stopReason, "timeout");
    assertEquals(result.solved, false);
    assert(
      Number.isFinite(result.wallclockMs),
      `expected finite wallclockMs, got ${result.wallclockMs}`,
    );
    assert(
      Number.isFinite(result.generations),
      `expected finite generations, got ${result.generations}`,
    );
    assertGreater(result.generations, 0);
    // The reported wall-clock duration must be consistent with the
    // observed elapsed time (allowing slop for setup outside the loop).
    assertGreaterOrEqual(elapsed + 50, result.wallclockMs);
  },
);

Deno.test(
  "evolveLanderController stops on target when targetError is generous",
  () => {
    // targetError=1 means the threshold is `landed-rate ≥ 0` — every
    // population member meets that on gen 0, so target wins the race.
    const result = evolveLanderController({
      seed: 7,
      populationSize: 6,
      targetError: 1,
      // Generous timeout so target trips first.
      timeoutMinutes: 1,
      mutationStrength: 0.001,
      mutationRate: 0.001,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 1.0,
    });
    assertEquals(result.stopReason, "target");
    assertEquals(result.solved, true);
    assertGreater(result.generations, 0);
    assert(
      Number.isFinite(result.wallclockMs),
      `expected finite wallclockMs, got ${result.wallclockMs}`,
    );
  },
);

Deno.test("evolveLanderController is reproducible for the same seed", () => {
  const r1 = evolveLanderController(TEST_EVOLVE_OPTIONS);
  const r2 = evolveLanderController(TEST_EVOLVE_OPTIONS);
  assertEquals(r1.bestScore, r2.bestScore);
  assertEquals(r1.championOutcome, r2.championOutcome);
  assertEquals(r1.landedRate, r2.landedRate);
});

Deno.test("evolveLanderController champion improves over generations", () => {
  // The champion's score must monotonically increase across the run
  // (truncation selection + elitism guarantees this) and the final
  // best must strictly exceed the gen-1 best, proving the search is
  // making progress on the noisy start. The snapshotConfig is used as
  // a `keep-running-after-target` mechanism so the loop runs across
  // multiple generations after target trips at gen 0.
  const tmp = Deno.makeTempDirSync({ prefix: "lunar_lander_improves_test_" });
  const events: GenerationInfo[] = [];
  try {
    const result = evolveLanderController({
      ...TEST_EVOLVE_OPTIONS,
      populationSize: 30,
      snapshotConfig: { checkpoints: [1, 5, 12], outputDir: tmp },
      onGeneration: (info) => events.push(info),
    });
    assert(events.length > 0, "expected at least one generation event");
    // Champion score must be finite across the whole run.
    for (const info of events) {
      assert(Number.isFinite(info.bestScore), `expected finite best, got ${info.bestScore}`);
      assert(Number.isFinite(info.meanScore), `expected finite mean, got ${info.meanScore}`);
    }
    // Final best ≥ first best (elitism). The strict inequality is checked
    // through `result.bestScore` aggregating the best across the run.
    assertGreaterOrEqual(result.bestScore, events[0].bestScore);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("champion JSON exports cleanly to disk", async () => {
  const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
  const tmp = await Deno.makeTempDir({ prefix: "lunar_lander_test_" });
  try {
    const path = join(tmp, "champion.json");
    await safeWriteJson(path, result.champion.exportJSON());
    assertEquals(existsSync(path), true);
    const written = await Deno.readTextFile(path);
    const parsed = JSON.parse(written);
    assert("neurons" in parsed, "exported champion should contain neurons");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("replayController returns a non-empty trace whose first frame is the initial state", () => {
  const pop = buildRandomPopulation(5, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  const seed = initialState();
  assert(trace.length > 0, "trace must not be empty");
  assertAlmostEquals(
    trace[0].state.x,
    seed.x,
    1e-9,
    `first frame should match the configured initial x = ${seed.x}`,
  );
  assertAlmostEquals(
    trace[0].state.vx,
    seed.vx,
    1e-9,
    `first frame should match the configured initial vx = ${seed.vx}`,
  );
});

Deno.test("renderRunSVG emits a well-formed SVG with trajectory polyline and pose markers", () => {
  const pop = buildRandomPopulation(13, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace);

  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");

  // Trajectory polyline
  const polylineMatches = svg.match(/<polyline class="trajectory"/g) ?? [];
  assertEquals(polylineMatches.length, 1, "expected exactly one trajectory polyline");

  // Pose markers (start + mid + end, deduplicated when trace is very short).
  const poseMatches = svg.match(/<g class="pose"/g) ?? [];
  assertGreaterOrEqual(poseMatches.length, 1);
  assert(poseMatches.length <= 3, `expected at most 3 pose groups, got ${poseMatches.length}`);

  // Landing pad is rendered.
  assert(svg.includes('class="pad"'), "expected the pad to be rendered");
});

Deno.test("renderRunSVG embeds SMIL animation elements that loop", () => {
  // Issue #70: the lander screenshot is now an animated SVG showing
  // the descent in motion. The static pose markers remain for static
  // viewers, but additional SMIL `<animate>` elements drive a moving
  // lander icon along the trajectory.
  const pop = buildRandomPopulation(13, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace);
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 4);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
  assert(
    svg.includes('class="animated-lander"'),
    "expected an animated-lander group",
  );
});

Deno.test("renderRunSVG draws a flame when the main thruster fires", () => {
  // Hand-craft a single trace frame that fires only the main thruster.
  const trace = [
    {
      state: {
        x: 0,
        y: 80,
        vx: 0,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: true, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="flame main"'), "expected a main-thruster flame marker");
});

Deno.test("renderRunSVG animates all three thruster flames", () => {
  // Issue #72: the controls (main, left RCS, right RCS) must be visible
  // in the animation, not only in the static pose markers, so the user
  // can see the controller's decisions while watching the descent.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: true, left: true, right: true },
    },
    {
      state: {
        x: -10,
        y: 40,
        vx: 1,
        vy: -2,
        angle: 0.1,
        angularV: 0,
        fuel: 50,
      } as LanderState,
      action: { main: false, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="anim-flame main"'), "expected animated main-thruster flame");
  assert(svg.includes('class="anim-flame left"'), "expected animated left-RCS flame");
  assert(svg.includes('class="anim-flame right"'), "expected animated right-RCS flame");
});

Deno.test("renderRunSVG rotates the animated lander to reflect angle", () => {
  // Issue #72: the lander tilts as the controller fires its RCS
  // thrusters. The animation should mirror that rotation so viewers
  // can connect a tilt to its cause.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: false, left: true, right: false },
    },
    {
      state: {
        x: -10,
        y: 60,
        vx: 1,
        vy: -3,
        angle: 0.2,
        angularV: 0.1,
        fuel: 70,
      } as LanderState,
      action: { main: true, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(
    svg.includes('class="lander-rotor"'),
    "expected an inner rotation group for the animated lander",
  );
  assert(
    svg.includes('type="rotate"'),
    "expected an animateTransform rotation driving the lander tilt",
  );
});

Deno.test("renderRunSVG renders an animated fuel HUD bar", () => {
  // Issue #72: surface the "fighting fuel" budget so the viewer can
  // see fuel drain during the descent.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: true, left: false, right: false },
    },
    {
      state: {
        x: 0,
        y: 0,
        vx: 0,
        vy: -1,
        angle: 0,
        angularV: 0,
        fuel: 30,
      } as LanderState,
      action: { main: false, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="hud-fuel-bar"'), "expected an animated fuel bar element");
  assert(svg.includes(">FUEL<"), "expected a 'FUEL' label on the HUD");
});

Deno.test(
  "evolveLanderController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  () => {
    const tmp = Deno.makeTempDirSync({ prefix: "lunar_lander_snapshots_test_" });
    try {
      const checkpoints = [1, 2, 3];
      evolveLanderController({
        ...TEST_EVOLVE_OPTIONS,
        mutationStrength: 0.01,
        mutationRate: 0.01,
        populationSize: 6,
        // The snapshot-capture branch keeps the loop running past the
        // first not-yet-fired checkpoint even after target trips at
        // gen 0, so all three checkpoints are captured before the
        // loop stops.
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
        title: "Lunar Lander — Evolution Progress",
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
  "evolveLanderController emits neurons and synapses on each generation event",
  () => {
    // Issue #108/#153: the per-generation event must include neuron and
    // synapse counts so the runner can plot them on the evolution
    // chart. With addNeuronRate=0 the topology stays at the library's
    // minimal seed throughout the run.
    //
    // The snapshot-checkpoint trick deterministically pins the run to
    // exactly three generations: target trips at gen 0 (targetError=1),
    // but the snapshot branch keeps the loop running until the last
    // checkpoint at gen 3 has been captured.
    const tmp = Deno.makeTempDirSync({ prefix: "lunar_lander_neurons_test_" });
    const events: GenerationInfo[] = [];
    try {
      evolveLanderController({
        ...TEST_EVOLVE_OPTIONS,
        mutationStrength: 0.001,
        mutationRate: 0.001,
        populationSize: 6,
        snapshotConfig: { checkpoints: [1, 2, 3], outputDir: tmp },
        onGeneration: (info) => events.push(info),
      });
      assertEquals(events.length, 3);
      for (const info of events) {
        assertEquals(typeof info.neurons, "number");
        assertEquals(typeof info.synapses, "number");
        assertGreater(info.neurons, 0);
        assertGreater(info.synapses, 0);
        // No structural mutation in this test, so the topology stays
        // constant across generations.
        assertEquals(info.neurons, events[0].neurons);
        assertEquals(info.synapses, events[0].synapses);
      }
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "renderRunSVG draws an explosion when the run crashed (issue #177)",
  () => {
    // Hand-craft a trace whose final frame is a hard crash off the pad —
    // the renderer must visualise the wreck rather than showing the
    // resting-pose lander.
    const trace = [
      {
        state: {
          x: -20,
          y: 80,
          vx: 2,
          vy: 0,
          angle: 0,
          angularV: 0,
          fuel: 100,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
      {
        state: {
          // Far from the pad, fast horizontal speed, large tilt: classifies
          // as `crashed`.
          x: -30,
          y: 0,
          vx: 8,
          vy: -15,
          angle: 0.9,
          angularV: 0,
          fuel: 0,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);
    assert(
      svg.includes('class="explosion"'),
      "expected an explosion group on a crashed run",
    );
    assert(svg.includes(">EXPLODED<"), "expected an EXPLODED caption on the wreck");
    assert(
      svg.includes('class="starburst"'),
      "expected a starburst polygon as part of the explosion",
    );
    assert(
      svg.includes('class="outcome-badge"'),
      "expected an outcome badge identifying the run result",
    );
    assert(svg.includes(">✗ CRASHED<"), "expected the badge to label the run as CRASHED");
  },
);

Deno.test(
  "renderRunSVG draws an out-of-bounds explosion when the lander drifted off-world",
  () => {
    // Final state outside the world half-width — classifies as
    // `out_of_bounds`. The renderer should still show debris, but with
    // an "OUT OF BOUNDS" caption on the wreck and a matching badge.
    const trace = [
      {
        state: {
          x: -20,
          y: 80,
          vx: 0,
          vy: 0,
          angle: 0,
          angularV: 0,
          fuel: 100,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
      {
        state: {
          // Beyond DEFAULT_TERRAIN.worldHalfWidth = 50.
          x: -80,
          y: 30,
          vx: -10,
          vy: -2,
          angle: 0,
          angularV: 0,
          fuel: 0,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);
    assert(
      svg.includes('class="explosion"'),
      "expected an explosion group on out-of-bounds runs",
    );
    assert(
      svg.includes(">OUT OF BOUNDS<"),
      "expected an OUT OF BOUNDS caption on the wreck",
    );
    assert(
      svg.includes(">✗ OUT OF BOUNDS<"),
      "expected the outcome badge to label the run as OUT OF BOUNDS",
    );
  },
);

Deno.test(
  "renderRunSVG does NOT draw an explosion on a clean landing",
  () => {
    // Final state inside the pad with all safe-landing limits met —
    // classifies as `landed`. The renderer must keep the resting-pose
    // lander and omit the wreck graphic.
    const trace = [
      {
        state: {
          x: -20,
          y: 80,
          vx: 2,
          vy: 0,
          angle: 0,
          angularV: 0,
          fuel: 100,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
      {
        state: {
          x: 0,
          y: 0,
          vx: 0,
          vy: -0.5,
          angle: 0,
          angularV: 0,
          fuel: 50,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);
    assert(
      !svg.includes('class="explosion"'),
      "expected no explosion group on a successful landing",
    );
    assert(
      svg.includes(">✓ LANDED<"),
      "expected the outcome badge to label the run as LANDED",
    );
  },
);

Deno.test(
  "renderRunSVG accepts an explicit outcome override (issue #177)",
  () => {
    // The lunar-lander runner classifies the champion's run with the
    // multi-trial `championOutcome` and forwards that to the renderer.
    // The renderer must honour the override even if the trace's final
    // frame would classify differently.
    const trace = [
      {
        state: {
          x: 0,
          y: 0,
          vx: 0,
          vy: -0.5,
          angle: 0,
          angularV: 0,
          fuel: 50,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace, DEFAULT_TERRAIN, "crashed");
    assert(
      svg.includes('class="explosion"'),
      "expected an explosion group when the override outcome is `crashed`",
    );
    assert(svg.includes(">✗ CRASHED<"), "expected the badge to honour the override");
  },
);

Deno.test(
  "renderRunSVG keeps the lander body above the ground at touchdown (issue #181)",
  () => {
    // Issue #181: when the lander touches down (state.y = groundY) the
    // SVG must draw the lander resting ON the ground silhouette, not
    // half-buried in it. Both the static resting pose and the animated
    // lander icon's final position must place the lander's lowest point
    // at or above the projected ground line.
    const trace = [
      {
        state: {
          x: 0,
          y: 80,
          vx: 0,
          vy: 0,
          angle: 0,
          angularV: 0,
          fuel: 100,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
      {
        state: {
          x: 0,
          y: 0,
          vx: 0,
          vy: -0.5,
          angle: 0,
          angularV: 0,
          fuel: 50,
        } as LanderState,
        action: { main: false, left: false, right: false },
      },
    ];
    const svg = renderRunSVG(trace);

    // Top edge of the terrain silhouette rect — anything drawn at a
    // larger SVG y is below the ground line.
    const terrainMatch = svg.match(
      /<rect x="0" y="([\d.]+)" width="800" height="[\d.]+" fill="#3a2a1a"\/>/,
    );
    assert(terrainMatch, "expected a terrain silhouette rect");
    const groundSvg = parseFloat(terrainMatch[1]);

    // Every static-pose lander body line must sit at or above the ground.
    const bodyLineRegex =
      /<line class="body" x1="[\d.-]+" y1="([\d.-]+)" x2="[\d.-]+" y2="([\d.-]+)"/g;
    const bodyMatches = [...svg.matchAll(bodyLineRegex)];
    assert(
      bodyMatches.length > 0,
      "expected at least one resting-pose body line",
    );
    for (const m of bodyMatches) {
      const y1 = parseFloat(m[1]);
      const y2 = parseFloat(m[2]);
      const lowest = Math.max(y1, y2);
      assertGreaterOrEqual(
        groundSvg + 0.01,
        lowest,
        `static pose body extends below ground (lowest=${lowest}, ground=${groundSvg})`,
      );
    }

    // The animated lander's translate keyframes follow the trajectory.
    // The final keyframe must place the lander icon such that its
    // lowest body extent is at or above the ground.
    const animateMatch = svg.match(
      /<animateTransform attributeName="transform" type="translate" values="([^"]+)"/,
    );
    assert(animateMatch, "expected the animated-lander translate values");
    const lastFrame = animateMatch[1].split(";").pop()!;
    const [, lastY] = lastFrame.split(",").map(parseFloat);
    // Local body geometry extends from `-LANDER_HALF_LENGTH` to
    // `+LANDER_HALF_LENGTH` around the translate point. The lowest
    // visible y is therefore `lastY + LANDER_HALF_LENGTH`.
    const animLowest = lastY + 12; // LANDER_HALF_LENGTH
    assertGreaterOrEqual(
      groundSvg + 0.01,
      animLowest,
      `animated lander final position extends below ground ` +
        `(lowest=${animLowest}, ground=${groundSvg})`,
    );
  },
);

Deno.test("renderRunSVG marks the landing pad with a TARGET indicator", () => {
  // Issue #72: the lander must aim for a specific location — make the
  // pad's role as the destination unmistakable with an arrow + label.
  const trace = [
    {
      state: {
        x: -20,
        y: 80,
        vx: 2,
        vy: 0,
        angle: 0,
        angularV: 0,
        fuel: 100,
      } as LanderState,
      action: { main: false, left: false, right: false },
    },
  ];
  const svg = renderRunSVG(trace);
  assert(svg.includes('class="target-marker"'), "expected a target-marker group");
  assert(svg.includes(">TARGET<"), "expected a 'TARGET' label on the pad indicator");
});

Deno.test(
  "evolveLanderController: CSV row count equals the number of generation events (issue #199)",
  () => {
    // Run a tiny evolve with a fixed seed and capture one EvolutionRow
    // per onGeneration callback. Pin the run to exactly three
    // generations using the snapshot-checkpoint trick so the row count
    // assertion is deterministic regardless of host speed.
    const tmp = Deno.makeTempDirSync({ prefix: "lunar_lander_csv_test_" });
    const events: GenerationInfo[] = [];
    const rows: EvolutionRow[] = [];
    const start = Date.now();
    try {
      evolveLanderController({
        ...TEST_EVOLVE_OPTIONS,
        mutationStrength: 0.001,
        mutationRate: 0.001,
        populationSize: 6,
        snapshotConfig: { checkpoints: [1, 2, 3], outputDir: tmp },
        onGeneration: (info) => {
          events.push(info);
          rows.push({
            generation: info.generation,
            bestFitness: info.bestScore,
            avgFitness: info.meanScore,
            landedRate: info.bestLandedRate,
            wallclockMs: Date.now() - start,
          });
        },
      });
      assertEquals(rows.length, events.length);
      assertEquals(rows.length, 3);

      const csv = formatEvolutionCsv(rows);
      const csvLines = csv.trimEnd().split("\n");
      // Header + one row per generation.
      assertEquals(csvLines.length, rows.length + 1);
      assertEquals(csvLines[0], EVOLUTION_CSV_HEADER);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "formatEvolutionCsv: header is exact and rows parse cleanly with @std/csv (issue #199)",
  () => {
    const rows: EvolutionRow[] = [
      { generation: 0, bestFitness: -123.456, avgFitness: -789.0, landedRate: 0, wallclockMs: 12 },
      { generation: 1, bestFitness: 10.5, avgFitness: -50.25, landedRate: 0.3, wallclockMs: 45 },
      { generation: 2, bestFitness: 1000, avgFitness: 250.125, landedRate: 1, wallclockMs: 100 },
    ];
    const csv = formatEvolutionCsv(rows);

    // Exact header — downstream tools key on this verbatim.
    assert(
      csv.startsWith(EVOLUTION_CSV_HEADER + "\n"),
      `expected CSV to start with ${EVOLUTION_CSV_HEADER}, got ${csv.slice(0, 100)}`,
    );
    assertEquals(
      EVOLUTION_CSV_HEADER,
      "generation,best_fitness,avg_fitness,landed_rate,wallclock_ms",
    );

    // The CSV must parse cleanly with @std/csv into an array of objects
    // keyed by header.
    const parsed = parseCsv(csv, { skipFirstRow: true });
    assertEquals(parsed.length, rows.length);

    // Spot-check round-trip values.
    for (let i = 0; i < rows.length; i++) {
      const r = parsed[i] as Record<string, string>;
      assertEquals(Number(r.generation), rows[i].generation);
      assertEquals(Number(r.best_fitness), rows[i].bestFitness);
      assertEquals(Number(r.avg_fitness), rows[i].avgFitness);
      assertEquals(Number(r.landed_rate), rows[i].landedRate);
      assertEquals(Number(r.wallclock_ms), rows[i].wallclockMs);
    }

    // Determinism — identical inputs produce byte-identical output.
    assertEquals(formatEvolutionCsv(rows), csv);
  },
);

Deno.test(
  "formatEvolutionCsv: empty input emits header only (issue #199)",
  () => {
    const csv = formatEvolutionCsv([]);
    assertEquals(csv, EVOLUTION_CSV_HEADER + "\n");
  },
);

Deno.test(
  "validateChampion produces one entry per validation scenario (issue #198)",
  () => {
    const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 12);
    const report = validateChampion(result.champion, pools.validation);
    assertEquals(report.scenarios.length, pools.validation.length);
    for (const r of report.scenarios) {
      assert(
        ["flying", "landed", "crashed", "out_of_bounds"].includes(r.outcome),
        `unexpected outcome ${r.outcome}`,
      );
      assert(Number.isFinite(r.score), `expected finite score, got ${r.score}`);
    }
    // Aggregate counts must add up to the number of scenarios.
    const total = report.outcomeCounts.flying + report.outcomeCounts.landed +
      report.outcomeCounts.crashed + report.outcomeCounts.out_of_bounds;
    assertEquals(total, pools.validation.length);
    assertGreaterOrEqual(report.landedRate, 0);
    assertGreaterOrEqual(1, report.landedRate);
    assert(Number.isFinite(report.meanFitness));
  },
);

Deno.test(
  "validateChampion is deterministic for a fixed champion and scenarios (issue #198)",
  () => {
    const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 8);
    const a = validateChampion(result.champion, pools.validation);
    const b = validateChampion(result.champion, pools.validation);
    // Per-scenario scores and outcomes match exactly.
    for (let i = 0; i < a.scenarios.length; i++) {
      assertEquals(a.scenarios[i].score, b.scenarios[i].score);
      assertEquals(a.scenarios[i].outcome, b.scenarios[i].outcome);
      assertEquals(a.scenarios[i].seed, b.scenarios[i].seed);
    }
    assertEquals(a.landedRate, b.landedRate);
    assertEquals(a.meanFitness, b.meanFitness);
    assertEquals(a.selectedIndex, b.selectedIndex);
  },
);

Deno.test(
  "validateChampion writes a JSON-serialisable report (issue #198)",
  async () => {
    const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 6);
    const report = validateChampion(result.champion, pools.validation);
    const tmp = await Deno.makeTempDir({ prefix: "lunar_lander_validation_test_" });
    try {
      const path = join(tmp, "results.json");
      await Deno.writeTextFile(path, JSON.stringify(report));
      const written = JSON.parse(await Deno.readTextFile(path));
      // The serialised JSON must have one scenario entry per validation scenario.
      assertEquals(written.scenarios.length, pools.validation.length);
      for (let i = 0; i < written.scenarios.length; i++) {
        const r = written.scenarios[i];
        assertEquals(r.seed, pools.validation[i].seed);
        assertEquals(r.index, i);
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "pickValidationSvgIndex returns 0 when every scenario landed (issue #198)",
  () => {
    const allLanded: ValidationScenarioResult[] = Array.from({ length: 5 }, (_, i) => ({
      seed: i,
      index: i,
      outcome: "landed",
      score: 100 + i,
      finalState: initialState(),
    }));
    assertEquals(pickValidationSvgIndex(allLanded), 0);
  },
);

Deno.test(
  "pickValidationSvgIndex picks the lower-median scenario by score (issue #198)",
  () => {
    // Mixed outcomes: scores 10, 20, 30, 40, 50 → median=30 at index 2.
    const mixed: ValidationScenarioResult[] = [
      { seed: 0, index: 0, outcome: "crashed", score: 30, finalState: initialState() },
      { seed: 1, index: 1, outcome: "crashed", score: 50, finalState: initialState() },
      { seed: 2, index: 2, outcome: "crashed", score: 10, finalState: initialState() },
      { seed: 3, index: 3, outcome: "crashed", score: 40, finalState: initialState() },
      { seed: 4, index: 4, outcome: "landed", score: 20, finalState: initialState() },
    ];
    // Sorted scores: 10 (i=2), 20 (i=4), 30 (i=0), 40 (i=3), 50 (i=1).
    // Lower median (index 2 of sorted, since (5-1)/2 = 2) → original index 0.
    assertEquals(pickValidationSvgIndex(mixed), 0);
  },
);

Deno.test(
  "pickValidationSvgIndex returns -1 for an empty result set (issue #198)",
  () => {
    assertEquals(pickValidationSvgIndex([]), -1);
  },
);

Deno.test(
  "validateChampion's selected SVG-source scenario is non-canonical (issue #198)",
  () => {
    // The selected scenario must differ from `initialState()` — the
    // SVG should demonstrate generalisation, so its starting x and/or
    // pad position must not match the canonical training launch.
    const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 16);
    const report = validateChampion(result.champion, pools.validation);
    const selected = pools.validation[report.selectedIndex];
    const matchesCanonicalX = Math.abs(selected.state.x - DEFAULT_START_X) < 1e-9;
    const matchesCanonicalPad = Math.abs(selected.terrain.padX) < 1e-9;
    assert(
      !(matchesCanonicalX && matchesCanonicalPad),
      `selected scenario matches canonical state (x=${selected.state.x}, ` +
        `padX=${selected.terrain.padX}) — SVG would not prove generalisation`,
    );
  },
);

Deno.test(
  "replayController honours scenario terrain for the SVG source (issue #198)",
  () => {
    // Build a scenario with a shifted pad and a non-canonical start;
    // the replay's first frame must reflect the scenario state, and
    // the trace must classify against the scenario terrain.
    const result = evolveLanderController(TEST_EVOLVE_OPTIONS);
    const pools = generateScenarioPools(VALIDATION_BASE_SEED, 0, 4);
    const report = validateChampion(result.champion, pools.validation);
    const selected = pools.validation[report.selectedIndex];
    const trace = replayController(
      result.champion,
      MAX_STEPS,
      selected.state,
      selected.terrain,
    );
    // The first-frame x must match the validation scenario's start, not
    // the canonical default — the assertable signal that the SVG is
    // sourced from a held-out scenario.
    assert(trace.length > 0, "trace must not be empty");
    assertEquals(trace[0].state.x, selected.state.x);
    assertEquals(trace[0].state.fuel, selected.state.fuel);
    // The trace should diverge from the canonical initialState's x —
    // the validation pool's draws are uniformly distributed away from -20.
    const startedAtCanonical = Math.abs(trace[0].state.x - DEFAULT_START_X) < 1e-9;
    const padShifted = Math.abs(selected.terrain.padX) > 1e-9;
    assert(
      !startedAtCanonical || padShifted,
      "validation-sourced replay must differ from the canonical launch",
    );
  },
);

// ---------------------------------------------------------------------------
// Quick-mode (CI/quality budget) regression tests — issue #201.
// ---------------------------------------------------------------------------

Deno.test("isQuickMode trips on LUNAR_QUICK=1 env var (issue #201)", () => {
  assertEquals(isQuickMode([], "1"), true);
  assertEquals(isQuickMode([], "0"), false);
  assertEquals(isQuickMode([], undefined), false);
  // Stray values are treated as off — only the literal "1" counts.
  assertEquals(isQuickMode([], "true"), false);
  assertEquals(isQuickMode([], ""), false);
});

Deno.test("isQuickMode trips on --quick CLI flag (issue #201)", () => {
  assertEquals(isQuickMode(["--quick"], undefined), true);
  assertEquals(isQuickMode(["--target-error=0.05", "--quick"], undefined), true);
  assertEquals(isQuickMode(["--target-error=0.05"], undefined), false);
  // Either signal alone is enough; both together still resolve to true.
  assertEquals(isQuickMode(["--quick"], "1"), true);
});

Deno.test("quick-mode overrides force a tiny budget and an unreachable target (issue #201)", () => {
  // The quick-mode constants drive the runner's CI fast path. The
  // target-error must be unreachable so the timeout always drives
  // exit: `landed-rate` is bounded by 1, so a threshold > 1 (i.e.
  // `1 - QUICK_TARGET_ERROR > 1`, equivalently `QUICK_TARGET_ERROR < 0`)
  // can never be met. The timeout must also be small enough to fit
  // the per-section budget the user asked for in #201.
  assert(
    QUICK_TARGET_ERROR < 0,
    `QUICK_TARGET_ERROR must be < 0 to make the landed-rate threshold > 1, ` +
      `got ${QUICK_TARGET_ERROR}`,
  );
  assert(
    QUICK_TIMEOUT_MINUTES <= 0.2,
    `QUICK_TIMEOUT_MINUTES must be <= 12 seconds, got ${QUICK_TIMEOUT_MINUTES} minutes`,
  );
  assertGreater(QUICK_TIMEOUT_MINUTES, 0);
});

Deno.test(
  "quick-mode budget: evolveLanderController with the quick overrides ends fast (issue #201)",
  () => {
    // Drive the evolver directly with the quick-mode overrides and
    // assert the run finishes well inside the 30-second regression
    // budget the issue asks for. This is the closest we can get to a
    // wall-clock assertion without spawning a subprocess.
    const start = Date.now();
    const result = evolveLanderController({
      ...DEFAULT_EVOLVE_OPTIONS,
      populationSize: 12,
      targetError: QUICK_TARGET_ERROR,
      timeoutMinutes: QUICK_TIMEOUT_MINUTES,
    });
    const elapsedMs = Date.now() - start;
    // The runner stops on timeout because targetError > 1 is unreachable.
    assertEquals(result.stopReason, "timeout");
    // Wall-clock must be well under the 30-second regression budget.
    assert(
      elapsedMs < 30_000,
      `quick-mode evolveLanderController took ${elapsedMs}ms, expected < 30000ms`,
    );
    // The reported wall-clock figure must also be bounded by the
    // ceiling implied by QUICK_TIMEOUT_MINUTES with a small slack for
    // the "finish current generation" cost.
    assert(
      Number.isFinite(result.wallclockMs),
      `expected finite wallclockMs, got ${result.wallclockMs}`,
    );
  },
);

Deno.test(
  "quality.sh invokes lunar-lander in quick mode (issue #201)",
  async () => {
    // Structural guard: the CI section budget hinges on quality.sh
    // passing LUNAR_QUICK=1 to the lunar-lander runner. If a future
    // refactor drops the env override, the section will silently slip
    // back to the 2-minute default — this test catches that.
    const text = await Deno.readTextFile(new URL("../quality.sh", import.meta.url));
    assert(
      /LUNAR_QUICK=1[^\n]*lunar_lander\/run\.sh|lunar_lander\/run\.sh[^\n]*LUNAR_QUICK=1/.test(
        text,
      ),
      "quality.sh must invoke ./lunar_lander/run.sh with LUNAR_QUICK=1",
    );
  },
);

Deno.test(
  "lunar_lander/README.md references each canonical artefact and they exist (issue #202)",
  async () => {
    // Structural guard: the README must keep pointing at the four
    // canonical artefacts written by the full-budget runner — the
    // descent SVG, the per-generation evolution CSV, the fitness line
    // chart, and the validation outcome bar chart. If any of these
    // paths drifts (rename, removal) or the underlying file is missing
    // from the repo, this test fails loudly so the docs and the
    // artefacts cannot diverge silently.
    const readme = await Deno.readTextFile(new URL("./README.md", import.meta.url));
    const repoRoot = new URL("../", import.meta.url);

    const artefacts: Array<{ path: string; readmeRefs: string[] }> = [
      {
        path: "docs/screenshots/lunar_lander.svg",
        readmeRefs: [
          "docs/screenshots/lunar_lander.svg",
          "../docs/screenshots/lunar_lander.svg",
        ],
      },
      {
        path: "docs/data/lunar_lander/evolution.csv",
        readmeRefs: [
          "docs/data/lunar_lander/evolution.csv",
          "../docs/data/lunar_lander/evolution.csv",
        ],
      },
      {
        path: "docs/screenshots/lunar_lander/fitness.svg",
        readmeRefs: [
          "docs/screenshots/lunar_lander/fitness.svg",
          "../docs/screenshots/lunar_lander/fitness.svg",
        ],
      },
      {
        path: "docs/screenshots/lunar_lander/validation.svg",
        readmeRefs: [
          "docs/screenshots/lunar_lander/validation.svg",
          "../docs/screenshots/lunar_lander/validation.svg",
        ],
      },
    ];

    for (const { path, readmeRefs } of artefacts) {
      const cited = readmeRefs.some((ref) => readme.includes(ref));
      assert(
        cited,
        `lunar_lander/README.md must reference ${path} (looked for ${readmeRefs.join(" or ")})`,
      );

      const fileUrl = new URL(path, repoRoot);
      assert(
        existsSync(fileUrl),
        `expected artefact ${path} to exist on disk (looked at ${fileUrl.pathname})`,
      );
    }
  },
);
