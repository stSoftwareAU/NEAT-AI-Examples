/**
 * Unit tests for the cart-pole NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, type CreatureExport, safeWriteJson } from "@stsoftware/neat-ai";

import {
  buildRandomPopulation,
  DEFAULT_EVOLVE_OPTIONS,
  evolveCartPoleController,
  type GenerationInfo,
  INPUT_COUNT,
  MAX_STEPS,
  mutateCreatureExport,
  OUTPUT_COUNT,
  replayController,
  scoreController,
  scoreTiltDirectionPolicy,
  SOLVED_THRESHOLD,
  SVG_FRAME_COUNT,
} from "./cart_pole.ts";
import { renderRunSVG } from "./svg.ts";
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
    // Activating must return one finite scalar.
    creature.clearState();
    const out = creature.activate(Float32Array.from([0, 0, 0, 0]));
    assertEquals(out.length, OUTPUT_COUNT);
    assert(Number.isFinite(out[0]), `expected finite output, got ${out[0]}`);
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

Deno.test("scoreTiltDirectionPolicy beats a 'do nothing' baseline", () => {
  // The hand-crafted policy isn't perfect, but it should clearly out-survive
  // 50 steps — the simulator is solvable with simple feedback.
  const score = scoreTiltDirectionPolicy(MAX_STEPS);
  assertGreater(
    score,
    50,
    `tilt-direction policy should survive >50 steps, got ${score}`,
  );
});

Deno.test("scoreController returns a value between 0 and MAX_STEPS", () => {
  const pop = buildRandomPopulation(2, 1);
  const creature = Creature.fromJSON(pop[0]);
  const score = scoreController(creature, MAX_STEPS);
  assertGreaterOrEqual(score, 0);
  assertGreaterOrEqual(MAX_STEPS, score);
});

Deno.test(
  "scoreController with multiple trials returns the mean across trials",
  () => {
    // Sanity: the mean lies in [0, MAX_STEPS] and is deterministic for
    // identical inputs (same trialSeed).
    const pop = buildRandomPopulation(99, 1);
    const json: CreatureExport = pop[0];
    const a = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 3,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    const b = scoreController(Creature.fromJSON(json), MAX_STEPS, {
      trials: 3,
      trialSeed: 11,
      initialPerturbation: 0.05,
    });
    assertEquals(a, b);
    assertGreaterOrEqual(a, 0);
    assertGreaterOrEqual(MAX_STEPS, a);
  },
);

Deno.test(
  "evolveCartPoleController generation-1 population is noise on average",
  () => {
    // Gen 1 must be noise. Cart-pole is famously solvable by some lucky
    // linear policies, so the *best* of a 30-strong uniform-random NEAT
    // population sometimes already hits the cap. The honest noise check
    // is therefore the **population mean**, which must sit far below
    // the SOLVED_THRESHOLD — confirming the population as a whole has
    // not been warm-started toward a competent controller.
    let firstGenMean = -Infinity;
    evolveCartPoleController({
      ...DEFAULT_EVOLVE_OPTIONS,
      maxGenerations: 1,
      onGeneration: (info) => {
        if (info.generation === 0 && firstGenMean === -Infinity) {
          firstGenMean = info.meanScore;
        }
      },
    });
    assert(
      firstGenMean < SOLVED_THRESHOLD / 2,
      `expected gen-1 population mean to be well below half the threshold ` +
        `(${SOLVED_THRESHOLD / 2}), got ${firstGenMean}`,
    );
  },
);

Deno.test(
  "evolveCartPoleController honours the hard generation cap",
  () => {
    // With a tiny strength + tiny rate, the evolver cannot solve the
    // task within the cap. The result must therefore stop at the cap
    // and report `solved=false`.
    const cap = 3;
    // seed=999 with pop=4 produces an initial population whose best
    // member scores well below SOLVED_THRESHOLD, so the early-stop
    // branch in `evolveCartPoleController` cannot fire and the loop
    // must run all the way to `maxGenerations`.
    const result = evolveCartPoleController({
      seed: 999,
      populationSize: 4,
      maxGenerations: cap,
      mutationStrength: 0.01,
      mutationRate: 0.01,
      addNeuronRate: 0,
      trials: 2,
      trialSeed: 1,
      initialPerturbation: 0.2,
    });
    assertEquals(
      result.generations,
      cap,
      `expected evolution to run to the hard cap of ${cap} generations, got ${result.generations}`,
    );
    assertEquals(
      result.solved,
      false,
      "with vanishing mutation the search must not solve cart-pole within the cap",
    );
  },
);

Deno.test(
  "evolveCartPoleController finds a controller above SOLVED_THRESHOLD with the default seed",
  async () => {
    const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion's mean score to reach SOLVED_THRESHOLD=${SOLVED_THRESHOLD}, ` +
        `got ${result.bestScore} after ${result.generations} generations`,
    );
    assertGreaterOrEqual(result.bestScore, SOLVED_THRESHOLD);

    // Champion must serialise cleanly for downstream consumption.
    const tmp = await Deno.makeTempDir({ prefix: "cart_pole_test_" });
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
  "evolveCartPoleController champion generalises to unseen perturbed initial states",
  () => {
    // Re-evaluating the champion against a fresh, independently seeded
    // batch of perturbed starts must continue to score above the
    // threshold. This is the proof that the controller learnt to
    // balance rather than overfitting to the training launches.
    const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    const independentScore = scoreController(result.champion, MAX_STEPS, {
      trials: 10,
      trialSeed: 987654,
      initialPerturbation: 0.05,
    });
    assertGreaterOrEqual(
      independentScore,
      SOLVED_THRESHOLD,
      `champion must generalise to unseen perturbed starts; got ${independentScore}`,
    );
  },
);

Deno.test("replayController returns a non-empty trace with the initial state first", () => {
  const pop = buildRandomPopulation(4, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  assert(trace.length > 0, "trace must not be empty");
  assertEquals(trace[0].x, 0);
  assertEquals(trace[0].theta, 0);
});

Deno.test("renderRunSVG emits an <svg> root with SMIL animation elements", () => {
  // Issue #70: the screenshot is now a single animated frame driven by
  // SMIL `<animate>` elements rather than a static multi-frame strip.
  // We verify the SVG carries animation primitives and that the cart's
  // x-position keyframe list contains the requested number of samples.
  const pop = buildRandomPopulation(6, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 50);
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  assert(svg.startsWith("<svg"), "must start with <svg>");
  assert(svg.includes("</svg>"), "must contain </svg>");
  const animateMatches = svg.match(/<animate /g) ?? [];
  assertGreaterOrEqual(animateMatches.length, 4);
  // Cart `x` animation must enumerate one keyframe per requested sample.
  const cartXAnim = svg.match(/<animate attributeName="x" values="([^"]+)"/);
  assert(cartXAnim, "expected the cart's x animation");
  const valueCount = cartXAnim![1].split(";").length;
  assertEquals(valueCount, Math.min(SVG_FRAME_COUNT, trace.length));
});

Deno.test("renderRunSVG output renders both cart and pole primitives", () => {
  const pop = buildRandomPopulation(8, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace, 4);
  assert(svg.includes('class="cart"'), "expected the cart rectangle");
  assert(svg.includes('class="pole"'), "expected the pole line");
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  // The committed SVG must loop so README readers see the motion every
  // time the page is opened, not just once.
  const pop = buildRandomPopulation(9, 1);
  const creature = Creature.fromJSON(pop[0]);
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
  assert(
    svg.includes('repeatCount="indefinite"'),
    "expected SMIL repeatCount='indefinite' so the animation loops",
  );
});

Deno.test(
  "evolveCartPoleController writes evolution snapshots and the strip SVG embeds one panel per snapshot",
  () => {
    const tmp = Deno.makeTempDirSync({ prefix: "cart_pole_snapshots_test_" });
    try {
      // Use a tiny population and a deliberately weak seed/strength so
      // the evolutionary loop does not accidentally solve cart-pole in
      // a single generation and trigger the early-stop break before all
      // configured snapshot checkpoints fire.
      const checkpoints = [1, 2, 3];
      evolveCartPoleController({
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
        title: "Cart-Pole — Evolution Progress",
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
  "evolveCartPoleController emits GenerationInfo with sensible neuron and synapse counts",
  () => {
    const samples: GenerationInfo[] = [];
    evolveCartPoleController({
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
      // minimal seed: 4 inputs + 1 output = 5 neurons and 4 synapses.
      assertEquals(info.neurons, INPUT_COUNT + OUTPUT_COUNT);
      assertEquals(info.synapses, INPUT_COUNT);
      assertGreaterOrEqual(info.bestScore, 0);
      assertGreaterOrEqual(info.meanScore, 0);
    }
  },
);

Deno.test(
  "running cart_pole.ts via run.sh-style execution emits champion.json and SVG",
  async () => {
    // Smoke-test that the SVG rendering path writes a sensible file when
    // wired up the same way the runner does. We use a temp dir to
    // avoid polluting the workspace.
    const tmp = await Deno.makeTempDir({ prefix: "cart_pole_smoke_" });
    try {
      ensureDirSync(join(tmp, "screenshots"));
      const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
      const trace = replayController(result.champion);
      const svg = renderRunSVG(trace, SVG_FRAME_COUNT);
      const svgPath = join(tmp, "screenshots", "cart_pole.svg");
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
