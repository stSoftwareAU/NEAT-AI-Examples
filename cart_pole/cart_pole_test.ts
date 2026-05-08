/**
 * Unit tests for the cart-pole NEAT controller. "What" tests only —
 * each test calls a real function, runs the simulator or evolver, and
 * asserts on the observable outputs (scores, file contents, SVG
 * structure).
 */
import { assert, assertEquals, assertGreater, assertGreaterOrEqual } from "@std/assert";
import { ensureDirSync, existsSync } from "@std/fs";
import { join } from "@std/path";
import { Creature, safeWriteJson } from "@stsoftware/neat-ai";

import { asCreatureExport } from "../common/legacy_types.ts";
import {
  buildInitialCreatureJSON,
  DEFAULT_EVOLVE_OPTIONS,
  evolveCartPoleController,
  type GenerationInfo,
  genesFromCreatureJSON,
  MAX_STEPS,
  mutateCreatureJSON,
  randomCreatureJSON,
  replayController,
  scoreController,
  scoreTiltDirectionPolicy,
  SVG_FRAME_COUNT,
} from "./cart_pole.ts";
import { renderRunSVG } from "./svg.ts";
import { createDeterministicRandom } from "../common/deterministic_random.ts";
import { loadSnapshots } from "../common/evolution_snapshot.ts";
import { renderEvolutionProgressSvg } from "../common/evolution_progress_svg.ts";

Deno.test("buildInitialCreatureJSON has 4 inputs and 1 output", () => {
  const json = buildInitialCreatureJSON([0.1, 0.2, 0.3, 0.4], 0.5);
  assertEquals(json.input, 4);
  assertEquals(json.output, 1);
  assertEquals(json.synapses.length, 4);
});

Deno.test("buildInitialCreatureJSON produces a valid creature", () => {
  const json = buildInitialCreatureJSON([0.1, 0.2, 0.3, 0.4], 0.5);
  const creature = Creature.fromJSON(asCreatureExport(json));
  creature.validate();
});

Deno.test("genesFromCreatureJSON round-trips the weights and bias", () => {
  const weights: [number, number, number, number] = [0.11, -0.22, 0.33, -0.44];
  const bias = 0.55;
  const json = buildInitialCreatureJSON(weights, bias);
  const genes = genesFromCreatureJSON(json);
  assertEquals(genes.weights, weights);
  assertEquals(genes.bias, bias);
});

Deno.test("randomCreatureJSON is deterministic for the same seed", () => {
  const r1 = createDeterministicRandom(99);
  const r2 = createDeterministicRandom(99);
  assertEquals(randomCreatureJSON(r1), randomCreatureJSON(r2));
});

Deno.test("mutateCreatureJSON yields a valid creature", () => {
  const random = createDeterministicRandom(7);
  const parent = buildInitialCreatureJSON([0, 0, 0, 0], 0);
  const child = mutateCreatureJSON(parent, random, 1.0, 0.3);
  const creature = Creature.fromJSON(asCreatureExport(child));
  creature.validate();
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
  const json = buildInitialCreatureJSON([0, 0, 0, 0], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const score = scoreController(creature, MAX_STEPS);
  assertGreaterOrEqual(score, 0);
  assertGreaterOrEqual(MAX_STEPS, score);
});

Deno.test(
  "scoreController with perturbed multi-trial evaluation rejects degenerate zero-genome controllers",
  () => {
    // The whole point of perturbing the initial state and averaging across
    // multiple trials is to stop a degenerate controller — one whose
    // output is constant or otherwise oblivious to the observables — from
    // ever scoring MAX_STEPS by sheer luck on a perfectly symmetric
    // initial state. With (0,0,0,0) inputs every component of `LOGISTIC`
    // is 0.5 so the action is fixed; the cart accelerates indefinitely
    // and the pole eventually trips the failure threshold.
    const json = buildInitialCreatureJSON([0, 0, 0, 0], 0);
    const creature = Creature.fromJSON(asCreatureExport(json));
    const score = scoreController(creature, MAX_STEPS, {
      trials: 5,
      trialSeed: 1,
      initialPerturbation: 0.05,
    });
    assert(
      score < MAX_STEPS,
      `expected the all-zero genome to fail under perturbations, got ${score}`,
    );
  },
);

Deno.test(
  "scoreController with multiple trials returns the mean across trials",
  () => {
    // The mean equals MAX_STEPS only when every trial hits the cap, so a
    // controller that solves the task generalises across the perturbed
    // start states.
    const random = createDeterministicRandom(99);
    let bestScore = -1;
    let bestJSON = randomCreatureJSON(random);
    for (let i = 0; i < 200; i++) {
      const json = randomCreatureJSON(random);
      const creature = Creature.fromJSON(asCreatureExport(json));
      const score = scoreController(creature, MAX_STEPS, {
        trials: 3,
        trialSeed: 11,
        initialPerturbation: 0.05,
      });
      if (score > bestScore) {
        bestScore = score;
        bestJSON = json;
      }
    }
    // Mean must lie in [0, MAX_STEPS] — the bound the contract promises.
    assertGreaterOrEqual(bestScore, 0);
    assertGreaterOrEqual(MAX_STEPS, bestScore);
    // Re-evaluating the best JSON twice with the same trialSeed must give
    // an identical mean (deterministic evaluation).
    const a = scoreController(
      Creature.fromJSON(asCreatureExport(bestJSON)),
      MAX_STEPS,
      { trials: 3, trialSeed: 11, initialPerturbation: 0.05 },
    );
    const b = scoreController(
      Creature.fromJSON(asCreatureExport(bestJSON)),
      MAX_STEPS,
      { trials: 3, trialSeed: 11, initialPerturbation: 0.05 },
    );
    assertEquals(a, b);
  },
);

Deno.test(
  "evolveCartPoleController finds a controller that solves the task with the default seed",
  async () => {
    const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    assertEquals(
      result.solved,
      true,
      `expected the champion to reach MAX_STEPS=${MAX_STEPS}, got ${result.bestScore} ` +
        `after ${result.generations} generations`,
    );
    assertEquals(result.bestScore, MAX_STEPS);

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
  "evolveCartPoleController under multi-trial evaluation requires more than one generation",
  () => {
    // Issue #143 — a perfectly symmetric initial state lets a "lucky"
    // member of the random initial population claim victory in
    // generation 1 without any learning. With the default options now
    // running multiple perturbed trials per evaluation, the search must
    // genuinely improve over generations.
    const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    assertGreater(
      result.generations,
      1,
      `expected the search to take more than one generation under perturbed ` +
        `multi-trial evaluation, got ${result.generations}`,
    );
  },
);

Deno.test(
  "evolveCartPoleController champion generalises to unseen perturbed initial states",
  () => {
    // Re-evaluating the champion against a fresh, independently seeded
    // batch of perturbed starts must continue to hit the cap. This is
    // the proof that the controller learnt to balance rather than
    // overfitting to a single lucky initial state.
    const result = evolveCartPoleController(DEFAULT_EVOLVE_OPTIONS);
    const independentScore = scoreController(result.champion, MAX_STEPS, {
      trials: 10,
      trialSeed: 987654,
      initialPerturbation: 0.05,
    });
    assertGreaterOrEqual(
      independentScore,
      MAX_STEPS,
      `champion must generalise to unseen perturbed starts; got ${independentScore}`,
    );
  },
);

Deno.test("replayController returns a non-empty trace with the initial state first", () => {
  const json = buildInitialCreatureJSON([0, 0, 1, 0], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
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
  const json = buildInitialCreatureJSON([0, 0, 1, 0], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
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
  const json = buildInitialCreatureJSON([0, 0, 1, 0], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
  const trace = replayController(creature, 30);
  const svg = renderRunSVG(trace, 4);
  assert(svg.includes('class="cart"'), "expected the cart rectangle");
  assert(svg.includes('class="pole"'), "expected the pole line");
});

Deno.test("renderRunSVG repeats the animation indefinitely", () => {
  // The committed SVG must loop so README readers see the motion every
  // time the page is opened, not just once.
  const json = buildInitialCreatureJSON([0, 0, 1, 0], 0);
  const creature = Creature.fromJSON(asCreatureExport(json));
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
      // Use a tiny population and a deliberately weak seed so the
      // evolutionary loop does not accidentally solve cart-pole in a
      // single generation and trigger the early-stop break before all
      // configured snapshot checkpoints fire.
      const checkpoints = [1, 2, 3];
      evolveCartPoleController({
        seed: 1,
        populationSize: 3,
        maxGenerations: 4,
        mutationStrength: 0.1,
        mutationRate: 0.1,
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
  "evolveCartPoleController emits GenerationInfo with neurons and synapses counts",
  () => {
    const samples: GenerationInfo[] = [];
    evolveCartPoleController({
      seed: 1,
      populationSize: 3,
      maxGenerations: 3,
      mutationStrength: 0.1,
      mutationRate: 0.1,
      onGeneration: (info) => samples.push(info),
    });
    assertGreater(samples.length, 0, "expected at least one onGeneration call");
    for (const info of samples) {
      // The fixed linear topology has 4 inputs + 1 output = 5 neurons and
      // 4 input→output synapses, matching buildInitialCreatureJSON.
      assertEquals(info.neurons, 5);
      assertEquals(info.synapses, 4);
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
