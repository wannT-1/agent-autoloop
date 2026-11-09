// Failure modes: stdout contains non-protocol text; unknown tools execute arbitrary endpoints; malformed arguments reach
// the hub; an HTTP failure becomes a successful tool result; notifications get responses; source keys act as owner keys;
// a client is told a version number left behind by a release; a slow tool call holds up a ping or another call, or is
// dropped when the input ends while it's in hand; a U+2028 or U+2029 in a request, which JSON leaves as it is, cuts the
// line, so the request never gets an answer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createServer, type RequestListener } from "node:http";
import { versionName } from "../host/version.ts";
import { setup } from "./helpers.ts";
const home = setup("mcp");

/** The MCP server for real, against a stand-in hub, past its handshake. */
async function connect(hub: RequestListener) {
  const server = createServer(hub);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      owner: "owner-key",
      source: { name: "app", key: "source-key" },
    }),
  );
  const child = spawn(process.execPath, ["bin/agent-autoloop.ts", "mcp"], {
    cwd: join(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  // Watched from the start: it can be gone by the time a test looks.
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  const answers = () =>
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const answered = async (id: number) => {
    const end = Date.now() + 5_000;
    for (;;) {
      const answer = answers().find((answer) => answer.id === id);
      if (answer) return answer;
      if (Date.now() > end) assert.fail(`nothing came back for ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const close = async () => {
    child.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  send({ method: "notifications/initialized" });
  await answered(1);
  return { child, closed, send, answers, answered, close };
}

test("MCP stdio initializes and exposes only the typed hub operations", async () => {
  const calls: any[] = [];
  const server = createServer((req, res) => {
    calls.push([req.url, req.headers.authorization]);
    res.statusCode = req.url?.includes("999") ? 404 : 200;
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      owner: "owner-key",
      source: { name: "app", key: "source-key" },
    }),
  );
  const child = spawn(process.execPath, ["bin/agent-autoloop.ts", "mcp"], {
    cwd: join(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let err = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (err += b));
  const messages = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "why", arguments: { run: -1 } } },
    { id: 5, method: "tools/call", params: { name: "why", arguments: { run: 999 } } },
    { id: 6, method: "tools/call", params: { name: "request", arguments: { path: "/etc/passwd" } } },
    { id: 7, method: "tools/call", params: { name: "emit", arguments: { id: "a", type: "one" } } },
    { id: 8, method: "tools/call", params: { name: "pause", arguments: { rule: "巡检", reason: "上游在修" } } },
    { id: 9, method: "tools/call", params: { name: "resume", arguments: { rule: "巡检" } } },
    { id: 10, method: "tools/call", params: { name: "run", arguments: { rule: "巡检", reason: "看一眼" } } },
    { id: 11, method: "tools/call", params: { name: "retry", arguments: { run: 7 } } },
  ];
  child.stdin.end(messages.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
  await once(child, "close");
  server.close();
  assert.equal(child.exitCode, 0, err);
  const responses = output
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(responses.length, 11);
  assert.equal(
    responses[0].result.serverInfo.version,
    versionName(),
    "it says which version it is, not a number left behind",
  );
  const get = (id: number) => responses.find((r) => r.id === id);
  assert.equal(get(1).result.protocolVersion, "2025-11-25");
  for (const name of ["answer", "pause", "resume", "run", "retry"])
    assert.ok(get(2).result.tools.some((t: any) => t.name === name));
  assert.equal(get(3).result.isError, undefined);
  assert.equal(get(4).error.code, -32602);
  assert.equal(get(5).result.isError, true);
  assert.equal(get(6).error.code, -32602);
  // Calls run side by side, so they can reach the hub in any order.
  assert.deepEqual(calls.toSorted(), [
    ["/v1/events", "Bearer source-key"],
    ["/v1/rules/%E5%B7%A1%E6%A3%80/pause", "Bearer owner-key"],
    ["/v1/rules/%E5%B7%A1%E6%A3%80/resume", "Bearer owner-key"],
    ["/v1/rules/%E5%B7%A1%E6%A3%80/run", "Bearer owner-key"],
    ["/v1/runs/7/retry", "Bearer owner-key"],
    ["/v1/runs/999/why", "Bearer owner-key"],
    ["/v1/state", "Bearer owner-key"],
  ]);
});

test("U+2028 and U+2029 in a request are part of the line", async () => {
  let told = "";
  const mcp = await connect(async (req, res) => {
    for await (const chunk of req) told += chunk;
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const text = "第一行 第二行 第三行";
    mcp.send({ id: 2, method: "tools/call", params: { name: "tell", arguments: { key: "k", text } } });
    assert.equal((await mcp.answered(2)).result.isError, undefined);
    assert.deepEqual(JSON.parse(told), { key: "k", text });
    assert.ok(!mcp.answers().some((answer) => answer.error), "and no pieces of it were taken for requests");
  } finally {
    await mcp.close();
  }
});

test("a slow tool call holds up neither a ping nor another call, and is still answered after the input ends", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const mcp = await connect(async (req, res) => {
    if (req.url === "/v1/state") await held;
    res.end(JSON.stringify({ asked: req.url }));
  });
  try {
    mcp.send({ id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
    mcp.send({ id: 3, method: "ping" });
    assert.deepEqual((await mcp.answered(3)).result, {});
    mcp.send({ id: 4, method: "tools/call", params: { name: "why", arguments: { run: 1 } } });
    assert.match((await mcp.answered(4)).result.content[0].text, /runs\/1\/why/);
    assert.ok(!mcp.answers().some((answer) => answer.id === 2), "it's still with the hub");
    mcp.child.stdin.end();
    release();
    assert.match((await mcp.answered(2)).result.content[0].text, /v1\/state/);
    await mcp.closed;
    assert.equal(mcp.child.exitCode, 0);
  } finally {
    release();
    await mcp.close();
  }
});
