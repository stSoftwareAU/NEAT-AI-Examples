// Warms the caches the OSS Scanner image needs offline
// (https://github.com/anthropics/oss-scanner). Run from the repository root
// during the image build, while the network is still available.
//
// 1. Activates a creature once, so NEAT-AI downloads its WASM activation
//    bundle (and the dynamically imported glue module) into
//    NEAT_AI_WASM_CACHE_DIR and DENO_DIR.
// 2. Downloads the digest-pinned MNIST and S&P 500 datasets into the same
//    `.synthetic-*/data/` paths the examples read, so they skip the fetch.

import { Creature } from "@stsoftware/neat-ai";
import { fetchDataset } from "../common/data_cache.ts";
import * as mnist from "../mnist_classification/mnist_classification.ts";
import * as stock from "../stock_market/stock_market.ts";

const output = new Creature(2, 1).activate(Float32Array.of(0, 1));
console.log(`WASM activation ok: ${output[0]}`);

await Promise.all([
  fetchDataset({
    url: mnist.TRAIN_IMAGES_URL,
    path: mnist.TRAIN_IMAGES_PATH,
    sha256: mnist.TRAIN_IMAGES_SHA256,
  }),
  fetchDataset({
    url: mnist.TRAIN_LABELS_URL,
    path: mnist.TRAIN_LABELS_PATH,
    sha256: mnist.TRAIN_LABELS_SHA256,
  }),
  fetchDataset({
    url: mnist.TEST_IMAGES_URL,
    path: mnist.TEST_IMAGES_PATH,
    sha256: mnist.TEST_IMAGES_SHA256,
  }),
  fetchDataset({
    url: mnist.TEST_LABELS_URL,
    path: mnist.TEST_LABELS_PATH,
    sha256: mnist.TEST_LABELS_SHA256,
  }),
  fetchDataset({
    url: stock.DATASET_URL,
    path: stock.DATASET_PATH,
    sha256: stock.DATASET_SHA256,
  }),
]);
console.log("Datasets cached");
