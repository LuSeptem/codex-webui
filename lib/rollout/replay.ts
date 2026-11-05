import { fileURLToPath } from "node:url";
import { mapFileChanges } from "@/lib/codex/file-change";
/**
 * rollout 文件回放：转换为与 exec 事件流一致的 SSE 事件。
 *
 * 映射规则（rollout 行 → exec 事件）：
 * - session_meta              → session.meta
 * - event_msg/task_started    → turn.started（携带 started_at）
 * - event_msg/task_complete   → turn.completed（usage 从缓存的 token_count 提取，携带时间戳）
 * - event_msg/token_count     → usage.updated（累计/最近用量、上下文窗口、额度）
 * - event_msg/user_message    → item.completed { item: { type: 'user_message', text } }
 * - event_msg/agent_message   → item.completed { item: { type: 'agent_message', text } }
 * - response_item/message(role=user)      → item.completed { item: { type: 'user_message', text } }
 * - response_item/message(role=assistant) → item.completed { item: { type: 'agent_message', text } }
 * - response_item/message(role=developer/system) → 跳过（系统指令）
 * - response_item/其他类型                → item.completed { item: payload }
 * - world_state / turn_context            → 跳过
 *
 * 这样前端 reducer 只需处理 session.meta / turn.started / turn.completed /
 * item.completed / usage.updated / error，实时与回放完全统一。
 */

import type { ResponseItem, Usage, AgentMessageItem, UserMessageItem, ReasoningItem, SessionMeta, CommandExecutionItem } from "@/types/api";
import { readRolloutLines } from "./reader";
import type { RolloutLine, ReplayEvent, EventMsgLine, ResponseItemLine } from "./types";
import { extractReasoningSummaryText } from "@/lib/utils/format";
import {
  emptyUsage,
  extractUsageSnapshotFromTokenCount,
  subtractUsage,
} from "@/lib/codex/usage-snapshot";
import {
  extractUserMessageAttachments,
  filterDisplayableImageUrls,
  formatUserMessageForDisplay,
} from "@/lib/codex/user-message";

/**
 * 回放 rollout 文件为事件流。
 * @param filePath rollout 文件绝对路径
 * @param signal AbortSignal，abort 时停止读取
 */
export async function* replayRollout(
  filePath: string,
  signal?: AbortSignal,
): AsyncIterable<ReplayEvent> {
  // 缓存当前 turn 的 usage（token_count 先于 task_complete 到达）
  let pendingUsage: Usage | null = null;
  let latestTotalUsage: Usage | null = null;
  let completedTotalUsage: Usage = emptyUsage();
  // 缓存当前 turn 的开始时间（task_started 设定，task_complete 时消费）
  let pendingStartedAt: number | undefined;
  let itemIdCounter = 0;

  // 生成稳定 id（rollout 中部分 item 无 id）
  const genId = (): string => `replay_${itemIdCounter++}`;

  // 去重：rollout 文件中 event_msg/agent_message 与 response_item/message(role=assistant)
  // 描述同一条消息，二者都会被映射为 item.completed(agent_message)。
  // 用 Set 跟踪已产出的 message key（type + normalized text），跳过重复。
  //
  // normalized text：压缩所有空白（含换行、制表符）为单空格并 trim。
  // 原因：event_msg 与 response_item 对同一消息的 text 可能有细微空白差异
  // （如尾部换行、多一个空格），精确匹配无法去重，导致同一消息显示两次。
  const seenMessageKeys = new Set<string>();
  const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim();

  // 推理文本去重：event_msg/agent_reasoning 与 response_item/reasoning 的 summary
  // 描述同一个推理。agent_reasoning 是 codex cli 显示明文思考过程的来源
  // （见 codex-rs/protocol/src/legacy_events.rs: ReasoningItem::as_legacy_events）。
  // 用 Set 跟踪已显示的推理文本，避免同一推理显示两次。
  const seenReasoningTexts = new Set<string>();

  // Legacy records lack structured completion events; defer their command fallback
  // until the next message so a matching completion can supply output and status.
  const pendingCommands: ReplayEvent[] = [];
  for await (const line of readRolloutLines(filePath)) {
    if (signal?.aborted) return;

    const payload = line.payload as Record<string, unknown>;
    if (line.type === "response_item" && payload.type === "custom_tool_call") {
      const fallback = mapCustomToolCall(payload as Parameters<typeof mapCustomToolCall>[0], genId, line.timestamp);
      if (fallback) pendingCommands.push(fallback);
      continue;
    }
    if (line.type === "event_msg" && payload.type === "item_completed") {
      const item = payload.item as Record<string, unknown> | undefined;
      if (item?.type === "CommandExecution") {
        const commands = [
          ...(Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map((value) => (value as { cmd?: unknown }).cmd) : []),
          ...(Array.isArray(item.command) ? item.command : [item.command]),
        ];
        for (let i = pendingCommands.length - 1; i >= 0; i--) {
          const fallback = pendingCommands[i];
          if (fallback.type === "item.completed" && fallback.item.type === "command_execution"
            && commands.includes(fallback.item.command)) pendingCommands.splice(i, 1);
        }
      }
    }
    const events = mapLineToEvents(line, genId, {
      getUsage: () => pendingUsage,
      setUsage: (u) => {
        pendingUsage = u;
      },
      getLatestTotalUsage: () => latestTotalUsage,
      setLatestTotalUsage: (usage) => {
        latestTotalUsage = usage;
      },
      getCompletedTotalUsage: () => completedTotalUsage,
      setCompletedTotalUsage: (usage) => {
        completedTotalUsage = usage;
      },
      getStartedAt: () => pendingStartedAt,
      setStartedAt: (ts) => {
        pendingStartedAt = ts;
      },
      clearTurn: () => {
        pendingUsage = null;
        pendingStartedAt = undefined;
        // 去重 Set 按 turn 清空：event_msg/agent_message 与 response_item/message
        // 只在同一 turn 内描述同一条消息，跨 turn 去重会错误丢弃用户重复输入
        // （如用户在多个 turn 都说"总结结果"，第二次会被误删）
        seenMessageKeys.clear();
        seenReasoningTexts.clear();
      },
      hasReasoningText: (text) => seenReasoningTexts.has(text),
      addReasoningText: (text) => seenReasoningTexts.add(text),
    });
    if (events.length === 0) continue;

    // 对 message 类型的 item.completed 做去重
    for (const event of events) {
      if (event.type === "turn.completed" ||
        (event.type === "item.completed" && event.item.type === "agent_message")) {
        yield* pendingCommands;
        pendingCommands.length = 0;
      }
      if (event.type === "item.completed") {
        const item = event.item;
        if (item.type === "agent_message" || item.type === "user_message") {
          const text = item.text ?? "";
          const key = `${item.type}::${normalizeText(text)}`;
          if (seenMessageKeys.has(key)) continue;
          seenMessageKeys.add(key);
        }
      }
      yield event;
    }
  }
  yield* pendingCommands;
}

/** 回放上下文：缓存读写回调 */
interface ReplayContext {
  getUsage: () => Usage | null;
  setUsage: (u: Usage | null) => void;
  getLatestTotalUsage: () => Usage | null;
  setLatestTotalUsage: (usage: Usage | null) => void;
  getCompletedTotalUsage: () => Usage;
  setCompletedTotalUsage: (usage: Usage) => void;
  getStartedAt: () => number | undefined;
  setStartedAt: (ts: number | undefined) => void;
  clearTurn: () => void;
  /** 推理文本是否已显示（用于 agent_reasoning 与 reasoning.summary 去重） */
  hasReasoningText: (text: string) => boolean;
  /** 记录已显示的推理文本 */
  addReasoningText: (text: string) => void;
}

/**
 * 将单行 rollout 映射为回放事件数组。
 */
function mapLineToEvents(
  line: RolloutLine,
  genId: () => string,
  ctx: ReplayContext,
): ReplayEvent[] {
  // rollout 行的 timestamp（ISO 字符串），传递给 item 事件
  const lineTimestamp = typeof line.timestamp === "string" ? line.timestamp : undefined;

  switch (line.type) {
    case "session_meta":
      return [{ type: "session.meta", meta: line.payload as SessionMeta }];

    case "event_msg":
      return mapEventMsg(line as EventMsgLine, genId, ctx, lineTimestamp);

    case "response_item":
      return [mapResponseItem(line as ResponseItemLine, genId, ctx, lineTimestamp)].filter(
        (e): e is ReplayEvent => e !== null,
      );

    default:
      // world_state / turn_context 等跳过
      return [];
  }
}

/** 映射 event_msg 行 */
function mapEventMsg(
  line: Extract<RolloutLine, { type: "event_msg" }>,
  genId: () => string,
  ctx: ReplayContext,
  lineTimestamp?: string,
): ReplayEvent[] {
  const p = line.payload as { type: string; [k: string]: unknown };
  const events: ReplayEvent[] = [];

  switch (p.type) {
    case "item_completed": {
      const item = p.item as Record<string, unknown> | undefined;
      if (item?.type === "CommandExecution") {
        let cwd = typeof item.cwd === "string" ? item.cwd : undefined;
        if (cwd?.startsWith("file:")) {
          try { cwd = fileURLToPath(cwd); } catch { /* retain the original URI */ }
        }
        const command = Array.isArray(item.command)
          ? item.command.map((arg) => /[\s"]/.test(String(arg)) ? JSON.stringify(arg) : String(arg)).join(" ")
          : String(item.command ?? "");
        events.push({
          type: "item.completed", timestamp: lineTimestamp,
          item: {
            id: typeof item.id === "string" ? item.id : genId(),
            type: "command_execution", command, cwd,
            aggregated_output: typeof item.aggregated_output === "string" ? item.aggregated_output : undefined,
            stdout: typeof item.stdout === "string" ? item.stdout : undefined,
            stderr: typeof item.stderr === "string" ? item.stderr : undefined,
            exit_code: typeof item.exit_code === "number" ? item.exit_code : null,
            status: item.status === "completed" ? "completed" : "in_progress",
          },
        });
      } else if (item?.type === "FileChange") {
        for (const change of mapFileChanges(typeof item.id === "string" ? item.id : genId(), item.changes)) {
          events.push({ type: "item.completed", item: change, timestamp: lineTimestamp });
        }
      }
      break;
    }
    case "task_started": {
      const startedAt = typeof p.started_at === "number" ? p.started_at : undefined;
      ctx.setStartedAt(startedAt);
      events.push({ type: "turn.started", startedAt });
      break;
    }

    case "task_complete": {
      const startedAt = typeof p.started_at === "number" ? p.started_at : ctx.getStartedAt();
      const completedAt = typeof p.completed_at === "number" ? p.completed_at : undefined;
      const durationMs = typeof p.duration_ms === "number" ? p.duration_ms : undefined;

      const latestTotal = ctx.getLatestTotalUsage();
      const turnUsage = latestTotal
        ? subtractUsage(latestTotal, ctx.getCompletedTotalUsage())
        : ctx.getUsage() ?? emptyUsage();
      events.push({
        type: "turn.completed",
        usage: turnUsage,
        startedAt,
        completedAt,
        durationMs,
      });
      if (latestTotal) ctx.setCompletedTotalUsage(latestTotal);
      // 清理当前 turn 缓存
      ctx.clearTurn();
      break;
    }

    case "token_count": {
      const snapshot = extractUsageSnapshotFromTokenCount(p, lineTimestamp);
      if (snapshot) {
        if (snapshot.lastUsage) ctx.setUsage(snapshot.lastUsage);
        if (snapshot.totalUsage) ctx.setLatestTotalUsage(snapshot.totalUsage);
        events.push({ type: "usage.updated", snapshot });
      }
      break;
    }

    case "user_message": {
      const text = String((p as { message?: string; text?: string }).message ||
        (p as { text?: string }).text || "");
      const rawImages = (p as { images?: unknown }).images;
      // 跳过系统注入的上下文（与 response_item/message(role=user) 一致）
      if (isSystemInjectedContext(text)) break;
      const item: UserMessageItem = {
        id: genId(),
        type: "user_message",
        text: formatUserMessageForDisplay(text),
        images: filterDisplayableImageUrls(
          Array.isArray(rawImages) ? rawImages : [],
        ),
        attachments: extractUserMessageAttachments(text),
      };
      events.push({ type: "item.completed", item, timestamp: lineTimestamp });
      break;
    }

    case "agent_message": {
      const text = String((p as { message?: string; text?: string }).message ||
        (p as { text?: string }).text || "");
      const item: AgentMessageItem = { id: genId(), type: "agent_message", text };
      events.push({ type: "item.completed", item, timestamp: lineTimestamp });
      break;
    }

    case "agent_reasoning": {
      // codex cli 显示明文思考过程的主要来源。
      // event_msg/agent_reasoning 由 ReasoningItem::as_legacy_events 生成
      // （见 codex-rs/protocol/src/legacy_events.rs），payload 为
      // {type:"agent_reasoning", text:"明文推理摘要"}。
      // cli TUI 通过 on_agent_reasoning_delta 渲染这些文本（见
      // codex-rs/tui/src/chatwidget/protocol.rs: ReasoningSummaryTextDelta）。
      const text = String((p as { text?: string }).text || "");
      if (!text) break;
      // 去重：同一推理文本只显示一次（response_item/reasoning 可能携带同样的 summary）
      if (ctx.hasReasoningText(text)) break;
      ctx.addReasoningText(text);
      const item: ReasoningItem = { id: genId(), type: "reasoning", text };
      events.push({ type: "item.completed", item, timestamp: lineTimestamp });
      break;
    }

    case "patch_apply_end": {
      for (const item of mapFileChanges(genId(), p.changes)) {
        events.push({ type: "item.completed", item, timestamp: lineTimestamp });
      }
      break;
    }

    default:
      // 未知 event_msg 类型，跳过
      break;
  }

  return events;
}

/** 映射 response_item 行 */
function mapResponseItem(
  line: Extract<RolloutLine, { type: "response_item" }>,
  genId: () => string,
  ctx: ReplayContext,
  lineTimestamp?: string,
): ReplayEvent | null {
  const item = line.payload as ResponseItem & {
    role?: string;
    content?: Array<{ type?: string; text?: string; image_url?: string }>;
  };

  // message 类型按 role 分发
  if ((item as { type?: string }).type === "message") {
    const role = item.role;
    const text = (item.content || [])
      .filter((c) => c.type === "input_text" || c.type === "text" || c.type === "output_text")
      .map((c) => c.text || "")
      .join("\n");

    if (role === "user") {
      // codex 会以 role:user 注入大量环境上下文（<recommended_plugins>、
      // <environment_context>、# AGENTS.md 指令等），这些不是用户实际输入。
      // CLI 不显示它们，web-ui 同样跳过，以对齐 CLI 的聊天记录显示。
      if (isSystemInjectedContext(text)) {
        return null;
      }
      const images = filterDisplayableImageUrls(
        (item.content || [])
          .filter((content) => content.type === "input_image")
          .map((content) => content.image_url),
      );
      return {
        type: "item.completed",
        item: {
          id: item.id || genId(),
          type: "user_message",
          text: formatUserMessageForDisplay(text),
          images,
          attachments: extractUserMessageAttachments(text),
        },
        timestamp: lineTimestamp,
      };
    }
    if (role === "assistant") {
      return {
        type: "item.completed",
        item: { id: item.id || genId(), type: "agent_message", text },
        timestamp: lineTimestamp,
      };
    }
    // developer / system 跳过
    return null;
  }

  // 非 message 类型：确保有 id 后透传
  if (!item.id) item.id = genId();

  // 容错：部分 rollout 中 response_item 的 type 直接是 agent_message / user_message，
  // 但 text 可能在 content 数组或 message 字段中，需归一化为顶层 text 字段。
  const rawType = (item as { type?: string }).type;
  if (rawType === "agent_message" || rawType === "user_message") {
    const it = item as ResponseItem & {
      text?: string;
      message?: string;
      content?: Array<{ type?: string; text?: string }>;
      images?: unknown[];
    };
    // 若已有非空 text，直接用；否则从 content / message 提取
    if (typeof it.text !== "string" || it.text === "") {
      const extracted =
        (it.content || [])
          .filter((c) => c.type === "input_text" || c.type === "text" || c.type === "output_text")
          .map((c) => c.text || "")
          .join("\n") ||
        it.message ||
        "";
      it.text = extracted;
    }
    if (rawType === "user_message") {
      const rawText = it.text;
      it.text = formatUserMessageForDisplay(rawText);
      (it as UserMessageItem).images = filterDisplayableImageUrls(it.images || []);
      (it as UserMessageItem).attachments = extractUserMessageAttachments(rawText);
    }
  }

  // reasoning 项归一化与去重：
  // codex rollout 中 reasoning.summary 是对象数组 [{type:"summary_text", text:"..."}]，
  // encrypted_content 是加密内容（无法解密）。
  // event_msg/agent_reasoning 已先于 response_item/reasoning 到达，且携带同样的明文摘要
  // （均由 ReasoningItem::as_legacy_events 生成）。这里对 summary 做去重：
  // 若文本已被 agent_reasoning 显示则跳过，避免同一推理出现两次。
  // 若 summary 为空（仅有 encrypted_content），不显示——对齐 cli 行为（cli 不显示加密推理）。
  if (rawType === "reasoning") {
    const it = item as ResponseItem & {
      text?: string;
      summary?: unknown;
      encrypted_content?: string;
    };
    if (typeof it.text !== "string" || it.text === "") {
      it.text = extractReasoningSummaryText(it.summary);
    }
    // 无明文摘要 → 跳过（对齐 cli：不显示加密推理）
    if (!it.text) return null;
    // 已被 agent_reasoning 显示 → 跳过
    if (ctx.hasReasoningText(it.text)) return null;
    ctx.addReasoningText(it.text);
  }

  // Fallback for older logs; current logs use event_msg/item_completed
  // for command output/status and file changes.
  if (rawType === "custom_tool_call") {
    return mapCustomToolCall(item as ResponseItem & { name?: string; input?: string }, genId, lineTimestamp);
  }

  // custom_tool_call_output：工具调用输出，不单独显示（命令输出需要与命令配对，暂不处理）
  if (rawType === "custom_tool_call_output") {
    return null;
  }

  return { type: "item.completed", item, timestamp: lineTimestamp };
}

/**
 * 将 custom_tool_call 映射为 command_execution（shell 命令）或跳过。
 *
 * Legacy code-mode fallback: recognize shell_command/exec_command text without
 * evaluating JavaScript. Structured completion events take precedence.
 */
function mapCustomToolCall(
  item: { id?: string; name?: string; input?: string },
  genId: () => string,
  lineTimestamp?: string,
): ReplayEvent | null {
  const name = item.name;
  const input = typeof item.input === "string" ? item.input : "";

  if (name === "exec") {
    // apply_patch 调用：跳过（patch_apply_end 会产生 file_change）
    if (input.includes("tools.apply_patch")) {
      return null;
    }
    // shell_command 调用：提取 command 参数
    const cmd = extractShellCommand(input);
    if (cmd) {
      const cmdItem: CommandExecutionItem = {
        id: item.id || genId(),
        type: "command_execution",
        command: cmd,
      };
      return { type: "item.completed", item: cmdItem, timestamp: lineTimestamp };
    }
  }

  // 未知 custom_tool_call：跳过
  return null;
}

/**
 * 从 custom_tool_call 的 input 字符串中提取 shell 命令。
 *
 * input 格式：const r = await tools.shell_command({command:"ssh 3090 \"...\"",...}); text(r)
 * 用正则匹配 command:"..." 部分，再用 JSON.parse 反转义 JavaScript 字符串转义。
 */
function extractShellCommand(input: string): string | null {
  const match = input.match(/tools\.(?:shell_command|exec_command)\(\s*\{\s*(?:command|cmd)\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse('"' + match[1] + '"');
  } catch {
    // JSON.parse 失败时手动反转义常见转义
    return match[1]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
}

/**
 * 判断 message 内容是否为 codex 系统注入的上下文（非用户实际输入）。
 *
 * codex 在向模型发送请求前，会注入大量环境上下文作为 role:user 的 message，
 * 如 <recommended_plugins>、<environment_context>、<permissions instructions>、
 * <skills_instructions>、# AGENTS.md 指令等。这些不是用户输入，CLI 不显示，
 * web-ui 也不应显示，以对齐 CLI 的聊天记录呈现。
 *
 * 判断依据：内容以 XML 标签 < 开头，或以 # AGENTS.md 开头。
 * 真正的用户输入不会以这些前缀开头。
 */
function isSystemInjectedContext(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<")) return true;
  if (trimmed.startsWith("# AGENTS.md")) return true;
  return false;
}
