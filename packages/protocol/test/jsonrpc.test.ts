import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { JsonRpcPeer, RpcError, ErrorCodes } from "../src/index.js";

function pair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcPeer(bToA, aToB, { name: "a" });
  const b = new JsonRpcPeer(aToB, bToA, { name: "b" });
  return { a, b };
}

test("request/response round trip", async () => {
  const { a, b } = pair();
  b.onRequest("add", ({ x, y }) => x + y);
  assert.equal(await a.request<number>("add", { x: 2, y: 3 }), 5);
});

test("errors carry code and message", async () => {
  const { a, b } = pair();
  b.onRequest("boom", () => {
    throw new RpcError(ErrorCodes.Conflict, "nope", { why: 1 });
  });
  await assert.rejects(a.request("boom"), (err: RpcError) => err.code === ErrorCodes.Conflict && err.message === "nope");
  await assert.rejects(a.request("missing"), (err: RpcError) => err.code === ErrorCodes.MethodNotFound);
});

test("notifications and bidirectional requests", async () => {
  const { a, b } = pair();
  const got: unknown[] = [];
  a.onNotification("tick", (p) => got.push(p));
  a.onRequest("ask", () => "answer");
  b.notify("tick", { n: 1 });
  assert.equal(await b.request("ask"), "answer");
  assert.deepEqual(got, [{ n: 1 }]);
});

test("non-JSON lines are ignored and messages split across chunks parse", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonRpcPeer(input, output);
  const errors: Error[] = [];
  peer.on("protocolError", (e) => errors.push(e));
  const seen: unknown[] = [];
  peer.onNotification("n", (p) => seen.push(p));
  input.write("some log line\n");
  const msg = JSON.stringify({ jsonrpc: "2.0", method: "n", params: 42 });
  input.write(msg.slice(0, 10));
  input.write(msg.slice(10) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [42]);
  assert.equal(errors.length, 1);
});

const silent = () => new JsonRpcPeer(new PassThrough(), new PassThrough(), { name: "a" });

test("pending requests reject when the connection closes", async () => {
  const a = silent();
  const p = a.request("never");
  a.close(new Error("gone"));
  await assert.rejects(p, /gone/);
});

test("timeouts", async () => {
  const a = silent();
  await assert.rejects(a.request("slow", undefined, { timeoutMs: 20 }), /timed out/);
});
