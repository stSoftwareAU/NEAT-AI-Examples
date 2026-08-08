/**
 * Unit tests for the shared feed-forward network helpers (issue #775).
 */
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { Creature } from "@stsoftware/neat-ai";

import {
  activate,
  type FeedForwardNetwork,
  forward,
  heldOutScore,
  networkFromCreature,
} from "./feed_forward_network.ts";
import { buildLargeCreature } from "./large_creature.ts";

/**
 * Four-neuron cascade: input 0 → hidden 1 → hidden 2 → output 3, plus a
 * direct input → hidden 2 shortcut. The hidden→hidden edge is the case a
 * single-pass pre-aggregation gets wrong.
 */
function cascadeNetwork(): FeedForwardNetwork {
  return {
    inputCount: 1,
    outputCount: 1,
    neurons: [
      { index: 0, type: "input", squash: "IDENTITY", bias: 0 },
      { index: 1, type: "hidden", squash: "TANH", bias: 0.1 },
      { index: 2, type: "hidden", squash: "TANH", bias: -0.2 },
      { index: 3, type: "output", squash: "IDENTITY", bias: 0.05 },
    ],
    synapses: [
      { from: 0, to: 1, weight: 0.7 },
      { from: 1, to: 2, weight: 1.3 },
      { from: 0, to: 2, weight: 0.4 },
      { from: 2, to: 3, weight: 0.9 },
    ],
  };
}

Deno.test("activate - evaluates each supported squash", () => {
  assertEquals(activate("IDENTITY", 0.42), 0.42);
  assertAlmostEquals(activate("TANH", 0.5), Math.tanh(0.5), 1e-12);
  assertAlmostEquals(activate("LOGISTIC", 2), 1 / (1 + Math.exp(-2)), 1e-12);
  // Numerically stable on the negative branch.
  assertAlmostEquals(activate("LOGISTIC", -2), 1 / (1 + Math.exp(2)), 1e-12);
  assert(Number.isFinite(activate("LOGISTIC", -1000)));
});

Deno.test("forward - hidden→hidden cascade uses the upstream hidden activation", () => {
  const network = cascadeNetwork();
  const x = 0.6;
  const acts = forward(network, new Float32Array([x]));

  const a1 = Math.tanh(0.1 + 0.7 * x);
  const a2 = Math.tanh(-0.2 + 1.3 * a1 + 0.4 * x);
  const a3 = 0.05 + 0.9 * a2;

  assertAlmostEquals(acts[1], a1, 1e-6);
  assertAlmostEquals(acts[2], a2, 1e-6);
  assertAlmostEquals(acts[3], a3, 1e-6);

  // A single-pass pre-aggregation would read a1 as zero; assert the
  // result genuinely differs from that wrong answer.
  const wrongA2 = Math.tanh(-0.2 + 0.4 * x);
  assert(
    Math.abs(acts[2] - wrongA2) > 1e-3,
    `cascade activation ${acts[2]} matches the pre-aggregated (wrong) value ${wrongA2}`,
  );
});

Deno.test("forward - inputs pass through their own squash", () => {
  const network: FeedForwardNetwork = {
    inputCount: 1,
    outputCount: 1,
    neurons: [
      { index: 0, type: "input", squash: "TANH", bias: 0 },
      { index: 1, type: "output", squash: "IDENTITY", bias: 0 },
    ],
    synapses: [{ from: 0, to: 1, weight: 1 }],
  };
  const acts = forward(network, [0.8]);
  assertAlmostEquals(acts[0], Math.tanh(0.8), 1e-6);
  assertAlmostEquals(acts[1], Math.tanh(0.8), 1e-6);
});

Deno.test("forward - rejects a mismatched input length", () => {
  assertThrows(
    () => forward(cascadeNetwork(), new Float32Array([0.1, 0.2])),
    Error,
    "expected 1 inputs",
  );
});

Deno.test("heldOutScore - scores a perfect fit at zero", () => {
  const network = cascadeNetwork();
  const inputs = new Float32Array([0.25]);
  const acts = forward(network, inputs);
  const dataset = [{ inputs, targets: new Float32Array([acts[3]]) }];

  assertAlmostEquals(heldOutScore(network, dataset), 0, 1e-12);
});

Deno.test("heldOutScore - penalises a mismatch and stays sign-flipped", () => {
  const network = cascadeNetwork();
  const inputs = new Float32Array([0.25]);
  const acts = forward(network, inputs);
  const dataset = [{ inputs, targets: new Float32Array([acts[3] + 0.5]) }];

  // -MSE over a single record with a 0.5 error.
  assertAlmostEquals(heldOutScore(network, dataset), -0.25, 1e-6);
  assert(heldOutScore(network, dataset) < 0);
});

Deno.test("heldOutScore - an empty dataset scores zero", () => {
  assertAlmostEquals(heldOutScore(cascadeNetwork(), []), 0, 1e-12);
});

Deno.test("networkFromCreature - mirrors the Creature topology", () => {
  const creature = buildLargeCreature({
    inputs: 3,
    hidden: 4,
    outputs: 2,
    density: 0.6,
    seed: 775775,
  });
  const network = networkFromCreature(creature, { label: "test demo" });

  assertEquals(network.inputCount, creature.input);
  assertEquals(network.outputCount, creature.output);
  assertEquals(network.neurons.length, creature.neurons.length);
  assertEquals(network.synapses.length, creature.synapses.length);
  assertEquals(network.neurons[0].type, "input");
  assertEquals(network.neurons[network.neurons.length - 1].type, "output");
  assertEquals(network.neurons[creature.input].type, "hidden");
  // NEAT-AI parks an `Infinity` sentinel on input biases; only the
  // non-input biases feed the forward pass.
  for (const n of network.neurons.slice(creature.input)) {
    assert(Number.isFinite(n.bias), `bias of neuron ${n.index} is not finite`);
  }

  const acts = forward(network, new Float32Array([0.1, -0.2, 0.3]));
  assertEquals(acts.length, network.neurons.length);
  for (const a of acts) assert(Number.isFinite(a));
});

Deno.test("networkFromCreature - throws on an unsupported squash by default", () => {
  const creature = new Creature(2, 1);
  creature.neurons[creature.neurons.length - 1].squash = "RELU";
  assertThrows(
    () => networkFromCreature(creature, { label: "test demo" }),
    Error,
    "Unsupported squash function for test demo: RELU",
  );
});

Deno.test("networkFromCreature - remaps an unsupported squash to TANH when asked", () => {
  const creature = new Creature(2, 1);
  const outIdx = creature.neurons.length - 1;
  creature.neurons[outIdx].squash = "RELU";
  const network = networkFromCreature(creature, {
    label: "test demo",
    onUnknownSquash: "tanh",
  });
  assertEquals(network.neurons[outIdx].squash, "TANH");

  const acts = forward(network, new Float32Array([0.4, -0.4]));
  for (const a of acts) assert(Number.isFinite(a));
});
