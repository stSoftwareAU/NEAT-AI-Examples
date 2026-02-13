/**
 * Unit tests for the shared deterministic random module.
 *
 * These are "what" tests — they verify the PRNG produces correct
 * values (range, determinism, diversity) without checking the
 * algorithm internals.
 */

import { assertEquals, assertGreater } from "@std/assert";

import { createDeterministicRandom } from "./deterministic_random.ts";

Deno.test("createDeterministicRandom produces values between 0 and 1", () => {
  const rng = createDeterministicRandom(42);
  for (let i = 0; i < 100; i++) {
    const value = rng();
    assertGreater(value, -Number.EPSILON, "value should be >= 0");
    assertGreater(1 + Number.EPSILON, value, "value should be < 1");
  }
});

Deno.test("createDeterministicRandom is deterministic for the same seed", () => {
  const rng1 = createDeterministicRandom(42);
  const rng2 = createDeterministicRandom(42);

  for (let i = 0; i < 50; i++) {
    assertEquals(rng1(), rng2(), `mismatch at iteration ${i}`);
  }
});

Deno.test("createDeterministicRandom differs for different seeds", () => {
  const rng1 = createDeterministicRandom(42);
  const rng2 = createDeterministicRandom(99);

  let allSame = true;
  for (let i = 0; i < 20; i++) {
    if (rng1() !== rng2()) {
      allSame = false;
      break;
    }
  }
  assertEquals(allSame, false, "different seeds should produce different sequences");
});
