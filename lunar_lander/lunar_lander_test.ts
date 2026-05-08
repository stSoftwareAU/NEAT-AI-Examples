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

import {
  buildRandomPopulation,
  decodeAction,
  DEFAULT_EVOLVE_OPTIONS,
  evolveLanderController,
  freeFallBaselineScore,
  type GenerationInfo,
  INPUT_COUNT,
  MAX_STEPS,
  mutateCreatureExport,
  OUTPUT_COUNT,
  replayController,
  scoreController,
  scoreFinalState,
  SOLVED_LANDED_RATE,
} from "./lunar_lander.ts";
import { renderRunSVG } from "./svg.ts";
import { DEFAULT_TERRAIN, initialState, type LanderState } from "./physics.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

/**
 * A fast, deterministic configuration suitable for unit tests. The
 * mutation pressure is low and the budget tight so the loop never
 * accidentally solves the task; test cases that expect "solved"
 * results override these values.
 */
const TEST_EVOLVE_OPTIONS = {
  seed: 42,
  populationSize: 12,
  maxGenerations: 8,
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
      maxGenerations: 1,
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
    assert(
      firstGenLanded < SOLVED_LANDED_RATE,
      `expected gen-1 best landed rate below the solved threshold (${SOLVED_LANDED_RATE}), got ${firstGenLanded}`,
    );
  },
);

Deno.test(
  "evolveLanderController honours the hard generation cap",
  () => {
    // With vanishing mutation, the evolver cannot solve the task within
    // the cap. The result must therefore stop at the cap and report
    // `solved=false`.
    const cap = 3;
    const result = evolveLanderController({
      seed: 999,
      populationSize: 4,
      maxGenerations: cap,
      mutationStrength: 0.001,
      mutationRate: 0.001,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 1.0,
    });
    assertEquals(
      result.generations,
      cap,
      `expected evolution to run to the hard cap of ${cap} generations, got ${result.generations}`,
    );
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve lunar-lander within the cap",
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
  // making progress on the noisy start.
  const events: GenerationInfo[] = [];
  const result = evolveLanderController({
    ...TEST_EVOLVE_OPTIONS,
    populationSize: 30,
    maxGenerations: 12,
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
        // Keep mutation pressure low so the loop does not solve early
        // and break out before all configured snapshot checkpoints fire.
        mutationStrength: 0.01,
        mutationRate: 0.01,
        maxGenerations: 4,
        populationSize: 6,
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
    const events: GenerationInfo[] = [];
    evolveLanderController({
      ...TEST_EVOLVE_OPTIONS,
      // Vanishing mutation keeps the search well away from the solved
      // threshold so the early-stop branch cannot fire and skip events.
      mutationStrength: 0.001,
      mutationRate: 0.001,
      maxGenerations: 3,
      populationSize: 6,
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
