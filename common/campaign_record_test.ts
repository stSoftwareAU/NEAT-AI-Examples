/**
 * Unit tests for campaign_record.ts
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";

import {
  appendCampaignPhase,
  loadCampaignRecord,
  startCampaignRecord,
  wipeCampaignRecord,
} from "./campaign_record.ts";
import * as campaignRecord from "./campaign_record.ts";

Deno.test("writeCampaignRecord is not part of the public export surface", () => {
  // The persistence helper is module-private; only the campaign lifecycle
  // functions are exported. Asserting its absence (rather than importing it)
  // enforces the narrowing and guards against re-widening the surface.
  assertEquals(
    Object.hasOwn(campaignRecord, "writeCampaignRecord"),
    false,
  );
});

Deno.test("startCampaignRecord then appendCampaignPhase tracks wall-clock and best score", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "campaign_" });
  try {
    await startCampaignRecord("mnist_classification", tmp);
    await appendCampaignPhase("mnist_classification", {
      wallClockMs: 60_000,
      testAccuracy: 0.12,
      validationAccuracy: 0.13,
    }, tmp);
    await appendCampaignPhase("mnist_classification", {
      wallClockMs: 90_000,
      testAccuracy: 0.21,
      validationAccuracy: 0.22,
    }, tmp);

    const record = await loadCampaignRecord("mnist_classification", tmp);
    assertEquals(record?.phaseCount, 2);
    assertEquals(record?.totalWallClockMs, 150_000);
    assertEquals(record?.bestHoldoutScore, 0.21);
    assertEquals(record?.bestValidationScore, 0.22);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("startCampaignRecord writes to <baseDir>/data/<slug>/campaign_record.json", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "campaign_" });
  try {
    await startCampaignRecord("xor_classification", tmp);
    // The path is resolved by the module-private campaignRecordPath helper;
    // assert the side effect lands at the expected location.
    const expected = join(tmp, "data", "xor_classification", "campaign_record.json");
    const stat = await Deno.stat(expected);
    assertEquals(stat.isFile, true);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("wipeCampaignRecord removes the JSON file", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "campaign_" });
  try {
    await startCampaignRecord("xor_classification", tmp);
    await wipeCampaignRecord("xor_classification", tmp);
    assertEquals(await loadCampaignRecord("xor_classification", tmp), undefined);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
