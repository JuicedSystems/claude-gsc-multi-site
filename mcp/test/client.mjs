// Tiny MCP stdio client used by the tests.
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function startServer(env) {
  const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  const child = spawn(process.execPath, [server], { env: { ...process.env, ...env } });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id == null) notifications.push(msg);
      else {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  });
  const request = (method, params = {}) =>
    new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  async function init() {
    const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    notify("notifications/initialized");
    return r;
  }
  /** Call a tool; returns { isError, text, json }. */
  async function call(name, args = {}) {
    const r = await request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`protocol error: ${r.error.message}`);
    const text = r.result.content[0].text;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* plain-text error */
    }
    return { isError: Boolean(r.result.isError), text, json };
  }
  return { child, request, notify, init, call, notifications, stderr, stop: () => child.kill() };
}
