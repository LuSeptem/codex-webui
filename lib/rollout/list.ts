/**
 * 会话列表扫描。
 *
 * 递归扫描 ~/.codex/sessions/ 与 archived_sessions/，对每个 rollout 文件：
 * - 读取首行 session_meta 提取元数据
 * - 读取前 N 行找首条用户消息作 preview
 * - 结合文件名时间戳与 mtime 组装 ThreadItem
 *
 * 按修改时间排序，按需读取并缓存元数据和预览；支持 cwd 与关键词过滤。
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ThreadItem, SessionMeta } from "@/types/api";
import {
  sessionsRoot,
  archivedSessionsRoot,
  isRolloutFile,
  isCompressed,
  parseSessionIdFromFilename,
  parseTimestampFromFilename,
} from "./paths";
import { readFirstLine, readLinesUntil } from "./reader";
import type { RolloutLine } from "./types";
import { loadSessionIndex } from "./session-index";

export interface ListOptions {
  /** 按 cwd 过滤（仅返回该目录下的会话） */
  cwd?: string;
  /** 关键词搜索（匹配 preview） */
  q?: string;
  /** 返回上限 */
  limit?: number;
}

interface RolloutFile {
  path: string;
  id: string;
  mtimeMs: number;
  size: number;
}
interface CachedHead {
  meta: SessionMeta;
  preview?: Promise<string | null>;
}
const headCache = new Map<string, { stamp: string; value: Promise<CachedHead | null> }>();

/** Sort file metadata first; open only as many matching sessions as requested. */
export async function listSessions(opts: ListOptions = {}): Promise<ThreadItem[]> {
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.min(10000, Math.floor(opts.limit!))) : 200;
  if (!limit) return [];
  const files = new Map<string, RolloutFile>();
  for (const root of [sessionsRoot(), archivedSessionsRoot()]) walkDir(root, files);
  const candidates = [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const present = new Set(candidates.map((file) => file.path));
  for (const key of headCache.keys()) if (!present.has(key)) headCache.delete(key);
  const index = await loadSessionIndex();
  const items: ThreadItem[] = [];
  // A small batch shares filesystem latency without opening every archive.
  for (let offset = 0; offset < candidates.length && items.length < limit; offset += 8) {
    const batch = await Promise.all(candidates.slice(offset, offset + 8)
      .map((file) => buildThreadItem(file, index, opts)));
    items.push(...batch.filter((item): item is ThreadItem => item !== null));
  }
  return items.slice(0, limit);
}

function walkDir(dir: string, files: Map<string, RolloutFile>): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkDir(full, files); continue; }
    if (!entry.isFile() || !isRolloutFile(entry.name)) continue;
    const id = parseSessionIdFromFilename(entry.name);
    if (!id) continue;
    const existing = files.get(id);
    if (existing && (!isCompressed(existing.path) || isCompressed(full))) continue;
    try {
      const stat = statSync(full);
      files.set(id, { path: full, id, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { /* file may have moved during the scan */ }
  }
}

async function buildThreadItem(
  file: RolloutFile,
  index: Map<string, string>,
  opts: ListOptions,
): Promise<ThreadItem | null> {
  const stamp = file.mtimeMs + ":" + file.size;
  let cached = headCache.get(file.path);
  if (!cached || cached.stamp !== stamp) {
    const value = readFirstLine(file.path).then((line): CachedHead | null =>
      line?.type === "session_meta" ? { meta: line.payload as SessionMeta } : null).catch(() => null);
    cached = { stamp, value };
    headCache.set(file.path, cached);
  }
  const head = await cached.value;
  if (!head || isSubagentSource(head.meta.source)) return null;
  const meta = head.meta;
  const cwd = meta.cwd || "";
  if (opts.cwd && cwd.toLowerCase() !== path.resolve(opts.cwd).toLowerCase()) return null;
  const indexedTitle = index.get(file.id);
  if (!indexedTitle) head.preview ??= extractPreview(file.path).catch(() => null);
  const preview = indexedTitle ?? (await head.preview) ?? "(empty session)";
  const q = opts.q?.toLowerCase();
  if (q && !preview.toLowerCase().includes(q) && !cwd.toLowerCase().includes(q)) return null;
  const updatedAt = new Date(file.mtimeMs).toISOString();
  return {
    id: file.id, preview, cwd,
    createdAt: meta.timestamp || parseTimestampFromFilename(path.basename(file.path)) || updatedAt,
    updatedAt,
    source: typeof meta.source === "string" ? meta.source : undefined,
    cliVersion: meta.cli_version,
    modelProvider: meta.model_provider,
    gitBranch: meta.git_branch,
    path: file.path,
    compressed: isCompressed(file.path),
  };
}

/**
 * 判断 source 是否为子代理会话。
 *
 * 正常会话 source 为字符串："exec" / "cli" / "vscode" 等。
 * 子代理会话 source 为对象：{"subagent":{"other":"guardian"}} 或 {"subagent":{"thread_spawn":{...}}}。
 */
function isSubagentSource(source: unknown): boolean {
  if (!source) return false;
  if (typeof source === "string") return false;
  if (typeof source === "object" && source !== null) {
    return "subagent" in source;
  }
  return false;
}

/** 系统注入消息前缀：这些内容不是用户真实输入，跳过 */
const SYSTEM_INJECTION_PREFIXES = [
  "<recommended_plugins>",
  "# AGENTS.md",
  "# agents.md",
  "<INSTRUCTIONS>",
  "<!-- fastctx",
  "<environment_context>",
  "<user_environment>",
  "The following is the Codex agent history",
  "You are an automated reviewer",
  "<agent_history>",
];

/** 判断文本是否为系统注入（AGENTS.md / recommended_plugins / environment 等） */
function isSystemInjection(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  return SYSTEM_INJECTION_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * 从系统注入文本中提取可读标题。
 *
 * - "# AGENTS.md instructions for <path>" → 项目名
 * - "The following is the Codex agent history..." → "代码审查"
 * - "<recommended_plugins>..." → null（跳过）
 * - 其他 → null
 */
function extractTitleFromInjection(text: string): string | null {
  const t = text.trimStart();

  // AGENTS.md 注入：提取项目路径最后一段作为标题
  const agentsMatch = t.match(/^#\s+AGENTS\.md\s+instructions\s+for\s+(.+)/i);
  if (agentsMatch) {
    const rawPath = agentsMatch[1].split(/\s+<|$/)[0].trim();
    const parts = rawPath.split(/[\\/]/);
    const projectName = parts[parts.length - 1] || parts[parts.length - 2];
    return projectName ? `${projectName}` : null;
  }

  // 审查/reviewer 会话
  if (t.startsWith("The following is the Codex agent history")) {
    return "代码审查";
  }
  if (t.startsWith("You are an automated reviewer")) {
    return "自动审查";
  }

  return null;
}

/** 提取首条真实用户消息作为预览文本（跳过 AGENTS.md / recommended_plugins 等系统注入） */
async function extractPreview(filePath: string): Promise<string | null> {
  // Stop at the first real prompt instead of decoding another 150 lines.
  const lines = await readLinesUntil(filePath, (line) => {
    const p = line.payload as { type?: string; role?: string; message?: string; text?: string; content?: Array<{ text?: string }> };
    const text = line.type === "event_msg" && p.type === "user_message"
      ? p.message || p.text || ""
      : line.type === "response_item" && p.type === "message" && p.role === "user"
        ? p.content?.map((part) => part.text || "").join("\n") || "" : "";
    return !!text && !isSystemInjection(text);
  }, 150);

  const userTexts: string[] = [];
  for (const line of lines) {
    if (line.type === "event_msg") {
      const p = line.payload as { type?: string; message?: string; text?: string };
      if (p.type === "user_message") {
        const text = p.message || p.text || "";
        if (text) userTexts.push(text);
      }
    }
    if (line.type === "response_item") {
      const p = line.payload as {
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
      if (p.type === "message" && p.role === "user") {
        const text = p.content
          ?.filter((c) => c.type === "input_text" || c.type === "text")
          .map((c) => c.text || "")
          .join("\n");
        if (text) userTexts.push(text);
      }
    }
  }

  // 优先返回第一条非系统注入的用户消息
  for (const text of userTexts) {
    if (!isSystemInjection(text)) {
      return truncate(text);
    }
  }

  // 全部都是系统注入：尝试从注入文本中提取可读标题
  for (const text of userTexts) {
    const title = extractTitleFromInjection(text);
    if (title) return title;
  }

  // 无法提取任何有用信息
  return null;
}

function truncate(s: string, max = 120): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 获取会话元数据（不含 preview） */
export async function getSessionMeta(sessionId: string): Promise<{
  meta: SessionMeta;
  path: string;
} | null> {
  const { findRolloutFile } = await import("./paths");
  const filePath = findRolloutFile(sessionId);
  if (!filePath) return null;

  const firstLine = await readFirstLine(filePath);
  if (!firstLine || firstLine.type !== "session_meta") return null;

  return { meta: firstLine.payload as SessionMeta, path: filePath };
}

export type { RolloutLine };
