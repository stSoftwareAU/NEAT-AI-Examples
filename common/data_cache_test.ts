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
