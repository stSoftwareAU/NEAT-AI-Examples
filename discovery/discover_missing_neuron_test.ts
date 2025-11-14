import { assert, assertEquals } from "@std/assert";
import {
  Creature,
  type CreatureExport,
  CreatureUtil,
} from "../../NEAT-AI/mod.ts";
import {
  chooseTargetNeuron,
  createDeterministicRandom,
  generateTargetSelectionSamples,
  SYNTHETIC_CONFIG,
  TARGET_SELECTION_SAMPLE_SIZE,
} from "./discover_missing_neuron.ts";

const ASSET_PATH = new URL("../assets/fittest_creature.json", import.meta.url);
const EXPECTED_TARGET_UUID = "82a5b66c-f725-4562-9c4e-bfbfb5550b0a";

Deno.test({
  name: "chooseTargetNeuron selects the highest impact hidden neuron",
  permissions: { read: [ASSET_PATH] },
  fn: async () => {
    const raw = await Deno.readTextFile(ASSET_PATH);
    const creatureJSON = JSON.parse(raw) as CreatureExport;
    const referenceCreature = Creature.fromJSON(creatureJSON);
    referenceCreature.validate();
    CreatureUtil.makeUUID(referenceCreature);

    const random = createDeterministicRandom(SYNTHETIC_CONFIG.seed);
    const samples = generateTargetSelectionSamples(
      referenceCreature,
      TARGET_SELECTION_SAMPLE_SIZE,
      random,
    );

    const { uuid, meanSquaredError } = chooseTargetNeuron(
      referenceCreature.exportJSON(),
      samples,
    );

    assertEquals(
      uuid,
      EXPECTED_TARGET_UUID,
      "Target selection should be deterministic for the known fittest creature.",
    );
    assert(
      meanSquaredError > 0.01,
      "Removing the selected neuron should noticeably degrade performance.",
    );
  },
});
