// @vitest-environment node

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../../scripts/copyspeech.mjs", import.meta.url));

type Captured = { method?: string; path?: string; body: string };

let server: Server;
let port = 0;
let reply = "{}";
const requests: Captured[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      body: Buffer.concat(chunks).toString("utf8")
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(reply);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen(0, "127.0.0.1") has completed; this is a bound TCP server, not a pipe.
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  requests.length = 0;
  reply = "{}";
});

/** Run the CLI against the shared loopback stand-in for the control server. */
async function runCli(args: string[], nextReply = "{}") {
  reply = nextReply;
  const { stdout } = await run(process.execPath, [cli, ...args], {
    env: { ...process.env, COPYSPEECH_CONTROL_ADDR: `127.0.0.1:${port}` },
    timeout: 5000
  });
  return { stdout: stdout.trim(), requests: [...requests] };
}

async function speakRequest(...flags: string[]) {
  requests.length = 0;
  const { stdout, requests: captured } = await runCli(["speak", "hello", ...flags]);
  expect(stdout).toBe("ok");
  expect(captured).toHaveLength(1);
  expect(captured[0].method).toBe("POST");
  expect(captured[0].path).toBe("/speak");
  return JSON.parse(captured[0].body);
}

test("speak serializes post-process flags, --wait, and --request-id", async () => {
  expect(await speakRequest()).toEqual({ text: "hello" });
  expect(await speakRequest("--post-process")).toEqual({ text: "hello", post_process: true });
  expect(await speakRequest("--condense")).toEqual({ text: "hello", post_process: true });
  expect(await speakRequest("--request-id", "hermes-abc123", "--wait")).toEqual({
    text: "hello",
    wait: true,
    request_id: "hermes-abc123"
  });
});

test("dash-prefixed request ids stay valid while known flags are rejected as missing values", async () => {
  expect(await speakRequest("--request-id", "-reader")).toEqual({
    text: "hello",
    request_id: "-reader"
  });
  expect(await speakRequest("--request-id", "--reader")).toEqual({
    text: "hello",
    request_id: "--reader"
  });
  await expect(runCli(["speak", "hello", "--request-id", "-p", "voice"])).rejects.toThrow(
    "--request-id requires a value"
  );
});

test("stop sends a scoped body with --request-id and stays bodyless without it", async () => {
  const scoped = await runCli(["stop", "--request-id", "hermes-abc123"]);
  expect(scoped.requests).toHaveLength(1);
  expect(scoped.requests[0].method).toBe("POST");
  expect(scoped.requests[0].path).toBe("/stop");
  expect(JSON.parse(scoped.requests[0].body)).toEqual({ request_id: "hermes-abc123" });

  requests.length = 0;
  const global = await runCli(["stop"]);
  expect(global.requests).toHaveLength(1);
  expect(global.requests[0].path).toBe("/stop");
  expect(global.requests[0].body).toBe("");
});

test("missing or empty --request-id fails on speak and stop instead of falling back global", async () => {
  for (const args of [
    ["stop", "--request-id"],
    ["speak", "hello", "--request-id"],
    ["speak", "hello", "--request-id", "--wait"],
    ["speak", "hello", "--request-id", "", "--wait"]
  ]) {
    await expect(runCli(args)).rejects.toThrow("--request-id requires a value");
  }
});

test("a cancelled speak still writes the ack and reports cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "copyspeech-cli-"));
  try {
    const ack = join(dir, "ack.wav");
    const { stdout } = await runCli(
      ["speak", "hello", "--wait", "--request-id", "r1", "--ack", ack],
      JSON.stringify({ ok: true, cancelled: true })
    );
    expect(stdout).toBe("cancelled");
    const wav = await readFile(ack);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.length).toBe(364);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
