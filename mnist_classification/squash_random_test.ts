import { assertEquals } from "@std/assert";

import { randomWeightedSquash, WEIGHTED_SQUASHES } from "./squash_random.ts";

Deno.test("randomWeightedSquash returns a name from the weighted pool", () => {
  const squash = randomWeightedSquash(() => 0);
  const names = WEIGHTED_SQUASHES.map(([name]) => name);
  assertEquals(names.includes(squash), true);
});
