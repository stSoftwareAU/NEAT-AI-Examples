/**
 * Unit tests for campaign_record.ts
 */

import { assertEquals } from "@std/assert";

import {
  appendCampaignPhase,
  loadCampaignRecord,
  startCampaignRecord,
  wipeCampaignRecord,
} from "./campaign_record.ts";

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
