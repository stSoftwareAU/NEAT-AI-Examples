/**
 * Unit tests for the shared dataset cache helper.
 *
 * These are "what" tests — they verify the observable behaviour of
 * `fetchDataset` (file contents, request counts, error shape) without
 * inspecting the implementation.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";

import { fetchDataset } from "./data_cache.ts";

interface TestServer {
  port: number;
  readonly count: number;
  stop(): Promise<void>;
}

function startServer(handler: (req: Request) => Response | Promise<Response>): TestServer {
  const ac = new AbortController();
  let count = 0;
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      count++;
      return handler(req);
    },
  );
  return {
    port: (server.addr as Deno.NetAddr).port,
    get count() {
      return count;
    },
    async stop() {
      ac.abort();
      await server.finished;
    },
  };
}

Deno.test("fetchDataset downloads a file and writes the expected bytes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const expected = new TextEncoder().encode("hello, world");
  const server = startServer(() => new Response(expected));
  const dest = join(tmp, "nested", "hello.bin");

  try {
    const result = await fetchDataset({
      url: `http://localhost:${server.port}/hello.bin`,
      path: dest,
    });

    assertEquals(result, dest, "should return the destination path");
    assertEquals(existsSync(dest), true, "file should exist on disk");
    const got = await Deno.readFile(dest);
    assertEquals(got, expected, "file contents should match the served bytes");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset uses the on-disk cache on the second call", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("cache me");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "cached.bin");

  try {
    await fetchDataset({ url: `http://localhost:${server.port}/x`, path: dest });
    await fetchDataset({ url: `http://localhost:${server.port}/x`, path: dest });

    assertEquals(server.count, 1, "second call must not re-download");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset rejects on digest mismatch and removes the partial file", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("payload that will not match");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "bad.bin");
  const wrongDigest = "0".repeat(64);

  try {
    await assertRejects(
      () =>
        fetchDataset({
          url: `http://localhost:${server.port}/x`,
          path: dest,
          sha256: wrongDigest,
        }),
      Error,
      "digest",
    );
    assertEquals(existsSync(dest), false, "partial file should be removed on mismatch");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset falls back to a mirror when the first URL 404s", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("from the second mirror");
  const failing = startServer(() => new Response("not found", { status: 404 }));
  const working = startServer(() => new Response(payload));
  const dest = join(tmp, "mirror.bin");

  try {
    await fetchDataset({
      url: [
        `http://localhost:${failing.port}/x`,
        `http://localhost:${working.port}/x`,
      ],
      path: dest,
    });

    const got = await Deno.readFile(dest);
    assertEquals(got, payload, "final file should match the working mirror");
    assertEquals(failing.count, 1, "first mirror should be tried once");
    assertEquals(working.count, 1, "second mirror should be tried once");
  } finally {
    await failing.stop();
    await working.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset writes atomically — final path never sees partial bytes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const dest = join(tmp, "atomic.bin");
  const partPath = `${dest}.part`;

  // The server holds the response open until the test releases it,
  // letting us inspect the on-disk state mid-flight.
  let releaseFirstChunk!: () => void;
  const firstChunkSent = new Promise<void>((resolve) => {
    releaseFirstChunk = resolve;
  });
  let releaseSecondChunk!: () => void;
  const secondChunkAllowed = new Promise<void>((resolve) => {
    releaseSecondChunk = resolve;
  });

  const server = startServer(() => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first-chunk"));
        releaseFirstChunk();
        await secondChunkAllowed;
        controller.enqueue(new TextEncoder().encode("-final"));
        controller.close();
      },
    });
    return new Response(stream);
  });

  const fetchPromise = fetchDataset({
    url: `http://localhost:${server.port}/atomic`,
    path: dest,
  });
  // Ensure we observe the fetchPromise regardless of teardown order.
  fetchPromise.catch(() => {});

  try {
    // Wait for the first chunk to be enqueued and (likely) flushed to disk.
    await firstChunkSent;
    // Give the runtime a moment to pump the first chunk through pipeTo.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const destExistsMidFlight = existsSync(dest);
    const partExistsMidFlight = existsSync(partPath);

    releaseSecondChunk();
    await fetchPromise;

    assertEquals(
      destExistsMidFlight,
      false,
      "final destination must not exist while download is in progress",
    );
    assertEquals(
      partExistsMidFlight,
      true,
      "scratch .part file must hold the in-flight bytes",
    );

    assertEquals(existsSync(dest), true, "final destination should exist after success");
    assertEquals(existsSync(partPath), false, "scratch .part file should be cleaned up");
    const got = await Deno.readFile(dest);
    assertEquals(got, new TextEncoder().encode("first-chunk-final"));
  } finally {
    releaseSecondChunk();
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset does not leave a .part file behind on success", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("clean success");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "clean.bin");
  const partPath = `${dest}.part`;

  try {
    await fetchDataset({
      url: `http://localhost:${server.port}/x`,
      path: dest,
    });
    assertEquals(existsSync(dest), true, "final file should exist on success");
    assertEquals(existsSync(partPath), false, "no .part scratch file should remain");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset cleans up .part on digest mismatch", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("doesn't match the digest");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "mismatch.bin");
  const partPath = `${dest}.part`;
  const wrongDigest = "0".repeat(64);

  try {
    await assertRejects(
      () =>
        fetchDataset({
          url: `http://localhost:${server.port}/x`,
          path: dest,
          sha256: wrongDigest,
        }),
      Error,
      "digest",
    );
    assertEquals(existsSync(dest), false, "final file must not exist on digest mismatch");
    assertEquals(existsSync(partPath), false, "scratch .part file must be removed");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("fetchDataset honours a matching digest as a cache hit", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "data_cache_test_" });
  const payload = new TextEncoder().encode("digest-match");
  const hash = await crypto.subtle.digest("SHA-256", payload);
  const expectedDigest = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const server = startServer(() => new Response(payload));
  const dest = join(tmp, "digest.bin");

  try {
    await fetchDataset({
      url: `http://localhost:${server.port}/x`,
      path: dest,
      sha256: expectedDigest,
    });
    await fetchDataset({
      url: `http://localhost:${server.port}/x`,
      path: dest,
      sha256: expectedDigest,
    });

    assertEquals(server.count, 1, "second call should not re-download when digest matches");
  } finally {
    await server.stop();
    await Deno.remove(tmp, { recursive: true });
  }
});
