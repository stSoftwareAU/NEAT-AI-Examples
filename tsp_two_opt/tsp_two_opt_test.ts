/**
 * Unit tests for the CLI parsers in tsp_two_opt/tsp_two_opt.ts —
 * specifically the `--instance` extension to cover `pcb442` and the new
 * `--time-seconds=<N>` smoke-mode budget flag.
 */
import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_MULTI_RUN_TIMEOUT_MINUTES,
  parseInstanceFlag,
  parseTimeSecondsFlag,
  resolveTimeoutMinutes,
} from "./tsp_two_opt.ts";
import { parseMultiRunFlags } from "../common/multi_run_state.ts";

Deno.test("parseInstanceFlag — accepts pcb442", () => {
  assertEquals(parseInstanceFlag(["--instance=pcb442"]), "pcb442");
});

Deno.test("parseInstanceFlag — accepts burma14 (regression guard)", () => {
  assertEquals(parseInstanceFlag(["--instance=burma14"]), "burma14");
});

Deno.test("parseInstanceFlag — accepts ulysses22 (regression guard)", () => {
  assertEquals(parseInstanceFlag(["--instance=ulysses22"]), "ulysses22");
});

Deno.test("parseInstanceFlag — defaults to burma14 when flag is absent", () => {
  assertEquals(parseInstanceFlag([]), "burma14");
});

Deno.test("parseInstanceFlag — unknown instance throws and mentions pcb442", () => {
  const err = assertThrows(
    () => parseInstanceFlag(["--instance=unknown"]),
    Error,
  );
  // The error message must list pcb442 as a valid option.
  if (!err.message.includes("pcb442")) {
    throw new Error(
      `Expected error message to mention pcb442, got: ${err.message}`,
    );
  }
});

Deno.test("parseTimeSecondsFlag — returns undefined when flag absent", () => {
  assertEquals(parseTimeSecondsFlag([]), undefined);
});

Deno.test("parseTimeSecondsFlag — parses --time-seconds=60", () => {
  assertEquals(parseTimeSecondsFlag(["--time-seconds=60"]), 60);
});

Deno.test("parseTimeSecondsFlag — rejects non-positive values", () => {
  assertThrows(() => parseTimeSecondsFlag(["--time-seconds=0"]), Error);
  assertThrows(() => parseTimeSecondsFlag(["--time-seconds=-5"]), Error);
});

Deno.test("parseTimeSecondsFlag — rejects non-numeric values", () => {
  assertThrows(() => parseTimeSecondsFlag(["--time-seconds=abc"]), Error);
});

Deno.test(
  "resolveTimeoutMinutes — --time-seconds=60 yields timeoutMinutes=1.0",
  () => {
    const flags = parseMultiRunFlags(["--time-seconds=60"]);
    const minutes = resolveTimeoutMinutes(
      ["--time-seconds=60"],
      flags.timeoutMinutes,
    );
    assertAlmostEquals(minutes, 1.0, 1e-9);
  },
);

Deno.test(
  "resolveTimeoutMinutes — --time-seconds=30 yields timeoutMinutes=0.5",
  () => {
    const flags = parseMultiRunFlags(["--time-seconds=30"]);
    const minutes = resolveTimeoutMinutes(
      ["--time-seconds=30"],
      flags.timeoutMinutes,
    );
    assertAlmostEquals(minutes, 0.5, 1e-9);
  },
);

Deno.test(
  "resolveTimeoutMinutes — --time-seconds beats --timeout (smoke wins)",
  () => {
    const argv = ["--time-seconds=30", "--timeout=5"];
    const flags = parseMultiRunFlags(argv);
    // Sanity check: parseMultiRunFlags still picks up --timeout=5.
    assertEquals(flags.timeoutMinutes, 5);
    const minutes = resolveTimeoutMinutes(argv, flags.timeoutMinutes);
    // Smoke (30s == 0.5 min) overrides the human-run --timeout=5.
    assertAlmostEquals(minutes, 0.5, 1e-9);
  },
);

Deno.test(
  "resolveTimeoutMinutes — falls back to --timeout=<minutes> when --time-seconds absent",
  () => {
    const argv = ["--timeout=7"];
    const flags = parseMultiRunFlags(argv);
    const minutes = resolveTimeoutMinutes(argv, flags.timeoutMinutes);
    assertEquals(minutes, 7);
  },
);

Deno.test(
  "resolveTimeoutMinutes — uses DEFAULT_MULTI_RUN_TIMEOUT_MINUTES when neither flag supplied",
  () => {
    const flags = parseMultiRunFlags([]);
    const minutes = resolveTimeoutMinutes([], flags.timeoutMinutes);
    assertEquals(minutes, DEFAULT_MULTI_RUN_TIMEOUT_MINUTES);
  },
);
