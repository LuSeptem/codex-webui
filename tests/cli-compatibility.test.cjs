const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const ts = require("typescript");

const project = path.resolve(__dirname, "..");
require.extensions[".ts"] = (loaded, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  loaded._compile(output, filename);
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  return resolve.call(this, request.startsWith("@/") ? path.join(project, request.slice(2)) : request, parent, ...rest);
};
const { replayRollout } = require("../lib/rollout/replay.ts");
const { mapAppServerItem } = require("../lib/codex/app-server-events.ts");
const { parseDiff } = require("../lib/utils/diff.ts");
const reader = require("../lib/rollout/reader.ts");
const { listSessions } = require("../lib/rollout/list.ts");

function fixture() {
  const home = path.join(project, ".tmp", "compat-tests", randomUUID());
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  return home;
}
function writeSession(home, id, lines, mtime = Date.now(), compressed = false) {
  const filename = path.join(home, "sessions", "rollout-2026-11-03T12-00-00-" + id + ".jsonl" + (compressed ? ".zst" : ""));
  const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  fs.writeFileSync(filename, text);
  fs.utimesSync(filename, mtime / 1000, mtime / 1000);
  return filename;
}
function meta(id, cwd = project, source = "cli") {
  return { type: "session_meta", payload: { id, session_id: id, cwd, source, timestamp: "2026-11-03T12:00:00Z" } };
}
function prompt(text) { return { type: "event_msg", payload: { type: "user_message", message: text } }; }
function event(type, values = {}) { return { type: "event_msg", payload: { type, ...values } }; }
async function replay(lines) {
  const home = fixture(), id = randomUUID();
  const file = writeSession(home, id, [meta(id), ...lines]);
  const events = [];
  for await (const event of replayRollout(file)) events.push(event);
  return events.filter((event) => event.type === "item.completed").map((event) => event.item);
}

test("current command completion restores output and exit code without duplicating code-mode fallback", async () => {
  const items = await replay([
    event("task_started"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'const r = await tools.exec_command({cmd:"echo compat",shell:"powershell"}); text(r.output);' } },
    event("item_completed", { item: { type: "CommandExecution", id: "exec-1", command: ["pwsh", "-Command", "echo compat"], parsed_cmd: [{ cmd: "echo compat" }], cwd: project, status: "completed", aggregated_output: "compat\n", exit_code: 0 } }),
    event("task_complete"),
  ]);
  const commands = items.filter((item) => item.type === "command_execution");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].aggregated_output, "compat\n");
  assert.equal(commands[0].exit_code, 0);
  assert.equal(commands[0].status, "completed");
  assert.ok(commands[0].command.includes('"echo compat"'));
});

test("legacy shell_command and exec_command logs still show commands without structured completions", async () => {
  const items = await replay([
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'await tools.shell_command({command:"echo legacy"})' } },
    event("agent_message", { message: "legacy done" }),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: 'await tools.exec_command({ cmd: "echo current" })' } },
    event("task_complete"),
  ]);
  assert.deepEqual(items.filter((item) => item.type === "command_execution").map((item) => item.command), ["echo legacy", "echo current"]);
});

test("live additions/deletions use structured kinds and accurate diff line counts", () => {
  const additions = mapAppServerItem({ type: "fileChange", id: "patch", changes: [
    { path: "new.txt", kind: { type: "add" }, diff: "first\nsecond\n" },
    { path: "old.txt", kind: { type: "delete" }, diff: "old\n" },
  ] });
  assert.equal(additions[0].change, "create");
  const added = parseDiff(additions[0].patch, additions[0].path);
  assert.equal(added.added, 2);
  assert.equal(added.removed, 0);
  assert.deepEqual(added.lines.filter((line) => line.type === "add").map((line) => line.newLine), [1, 2]);
  assert.equal(additions[1].change, "delete");
  assert.equal(parseDiff(additions[1].patch, "old.txt").removed, 1);
});

test("live updates retain unified diff and moved paths; old string kinds remain supported", () => {
  const patch = "--- old.txt\n+++ new.txt\n@@ -1 +1 @@\n-old\n+new";
  const items = mapAppServerItem({ type: "fileChange", id: "patch", changes: [
    { path: "old.txt", kind: { type: "update", movePath: "new.txt" }, diff: patch },
    { path: "legacy.txt", kind: "add", diff: "legacy" },
  ] });
  assert.equal(items[0].change, "rename");
  assert.equal(items[0].oldPath, "old.txt");
  assert.equal(items[0].path, "new.txt");
  assert.equal(items[0].patch, patch);
  assert.equal(items[1].change, "create");
  assert.equal(parseDiff(items[1].patch, "legacy.txt").added, 1);
  assert.equal(parseDiff(items[1].patch, "legacy.txt").lines.at(-1).type, "meta");
});

test("structured file changes and legacy patch events replay through the same normalization", async () => {
  const items = await replay([
    event("item_completed", { item: { type: "FileChange", id: "file-1", changes: { "new.txt": { type: "add", content: "new\n" } } } }),
    event("patch_apply_end", { success: true, changes: { "legacy.txt": { type: "add", content: "legacy\n" } } }),
  ]);
  const changes = items.filter((item) => item.type === "file_change");
  assert.equal(changes.length, 2);
  for (const item of changes) {
    assert.equal(item.change, "create");
    assert.equal(parseDiff(item.patch, item.path).added, 1);
  }
});

test("small history requests only parse a recent batch and reuse unchanged metadata/previews", async () => {
  const home = fixture(), now = Date.now();
  process.env.CODEX_HOME = home;
  const ids = Array.from({ length: 40 }, () => randomUUID());
  for (let i = 0; i < ids.length; i++) writeSession(home, ids[i], [meta(ids[i]), prompt("question " + i), ...Array(200).fill(event("agent_message", { message: "large tail" }))], now - i * 1000);
  const originalHead = reader.readFirstLine, originalPreview = reader.readLinesUntil;
  let heads = 0, previews = 0, longestRead = 0;
  reader.readFirstLine = (...args) => { heads++; return originalHead(...args); };
  reader.readLinesUntil = async (...args) => {
    previews++;
    const lines = await originalPreview(...args);
    longestRead = Math.max(longestRead, lines.length);
    return lines;
  };
  try {
    const first = await listSessions({ limit: 3 });
    assert.deepEqual(first.map((item) => item.id), ids.slice(0, 3));
    assert.ok(heads <= 8, "must not open all forty histories");
    assert.equal(longestRead, 2, "preview stops after the first real prompt");
    const counts = [heads, previews];
    await listSessions({ limit: 3 });
    assert.deepEqual([heads, previews], counts);
    const file = writeSession(home, ids[0], [meta(ids[0]), prompt("changed question")], now + 1000);
    assert.ok(fs.existsSync(file));
    assert.equal((await listSessions({ limit: 1 }))[0].preview, "changed question");
    assert.equal(heads, counts[0] + 1, "changed files invalidate cached heads");
  } finally {
    reader.readFirstLine = originalHead;
    reader.readLinesUntil = originalPreview;
  }
});

test("history filters run before limiting and renamed titles refresh independently of rollout cache", async () => {
  const home = fixture(), now = Date.now(), ids = [randomUUID(), randomUUID(), randomUUID()];
  process.env.CODEX_HOME = home;
  writeSession(home, ids[0], [meta(ids[0], project, { subagent: {} }), prompt("hidden")], now);
  writeSession(home, ids[1], [meta(ids[1], path.join(project, "other")), prompt("other project")], now - 1000);
  writeSession(home, ids[2], [meta(ids[2]), prompt("wanted")], now - 2000);
  assert.equal((await listSessions({ cwd: project, limit: 1 }))[0].id, ids[2]);
  assert.equal((await listSessions({ q: "wanted", limit: 1 }))[0].id, ids[2]);
  const index = path.join(home, "session_index.jsonl");
  fs.writeFileSync(index, JSON.stringify({ id: ids[2], thread_name: "renamed" }) + "\n");
  assert.equal((await listSessions({ q: "renamed", limit: 1 }))[0].preview, "renamed");
});

test("compressed head reads close their source stream and malformed archives do not crash the list", async () => {
  const home = fixture(), id = randomUUID();
  process.env.CODEX_HOME = home;
  const file = path.join(home, "sessions", "rollout-2026-11-03T12-00-00-" + id + ".jsonl.zst");
  const sample = Buffer.from("KLUv/SCM3QIAogUSFqC1Od3m299Nsq1AzdMv+Q+3LeaKDVdCZgdGhxUOJerCfp9RvqD4mWX4sJDZ498KLwFaelCT0mMpgBiWqC2fMRL6/ZYakdUkBQBR4ECL1BWyZZWUljW1Bw==", "base64");
  const zlib = require("node:zlib");
  const archive = zlib.zstdCompressSync
    ? zlib.zstdCompressSync(Buffer.from('{"type":"session_meta","payload":{"id":"compressed"}}\n{"type":"event_msg","payload":{"type":"user_message","message":"compressed preview"}}\n' + Array.from({ length: 8192 }, () => randomUUID()).join("\n")))
    : sample;
  fs.writeFileSync(file, archive);
  const original = fs.createReadStream, streams = [];
  fs.createReadStream = (...args) => { const stream = original(...args); streams.push(stream); return stream; };
  try {
    assert.equal((await reader.readFirstLine(file)).type, "session_meta");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(streams.every((stream) => stream.destroyed));
    if (archive.length > 16 * 1024) {
      assert.ok(streams.every((stream) => stream.bytesRead < archive.length), "head reads must not decompress the archive tail");
    }
  } finally { fs.createReadStream = original; }
  fs.writeFileSync(path.join(home, "sessions", "rollout-2026-11-03T12-00-00-" + randomUUID() + ".jsonl.zst"), Buffer.from("invalid archive"));
  assert.equal((await listSessions({ limit: 10 })).length, 1);
});
