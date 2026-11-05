import { mapFileChanges } from "./file-change";
import type {
  ItemCompletedEvent,
  ResponseItem,
  Usage,
  UsageSnapshot,
  UserInputQuestion,
  UserInputResponseRequest,
} from "@/types/api";

export interface AppServerUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  autoResolutionMs: number | null;
}

export function mapUserInputRequest(
  interactionId: string,
  params: AppServerUserInputParams,
): ItemCompletedEvent {
  return {
    type: "item.completed",
    item: {
      id: `user-input:${params.itemId}`,
      type: "user_input_request",
      interactionId,
      questions: params.questions,
      autoResolutionMs: params.autoResolutionMs,
    },
    timestamp: new Date().toISOString(),
  };
}

export function normalizeUserInputAnswers(
  answers: UserInputResponseRequest["answers"],
): { answers: Record<string, { answers: string[] }> } {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, value]) => [
        id,
        { answers: Array.isArray(value) ? value : [value] },
      ]),
    ),
  };
}

type UnknownItem = Record<string, unknown> & { id?: string; type?: string };

export function mapAppServerItem(item: UnknownItem): ResponseItem[] {
  const id = typeof item.id === "string" ? item.id : crypto.randomUUID();
  switch (item.type) {
    case "agentMessage":
      return [{ id, type: "agent_message", text: String(item.text ?? "") }];
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.map(String) : [];
      const content = Array.isArray(item.content) ? item.content.map(String) : [];
      return [{ id, type: "reasoning", text: [...summary, ...content].join("\n\n") }];
    }
    case "commandExecution":
      return [{
        id,
        type: "command_execution",
        command: String(item.command ?? ""),
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
        aggregated_output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
        exit_code: typeof item.exitCode === "number" ? item.exitCode : null,
        status: item.status === "completed" ? "completed" : "in_progress",
      }];
    case "fileChange":
      return mapFileChanges(id, item.changes);
    case "mcpToolCall":
      return [{
        id,
        type: "mcp_tool_call",
        server: String(item.server ?? ""),
        tool: String(item.tool ?? ""),
        arguments: JSON.stringify(item.arguments ?? {}),
        output: item.result == null ? undefined : JSON.stringify(item.result),
        error: item.error == null ? undefined : JSON.stringify(item.error),
      }];
    case "webSearch":
      return [{ id, type: "web_search", query: String(item.query ?? "") }];
    case "plan":
      return [{ id, type: "plan_update", status: String(item.text ?? "") }];
    default:
      return [];
  }
}

interface TokenBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

function mapUsage(value: TokenBreakdown | undefined): Usage {
  return {
    input_tokens: value?.inputTokens ?? 0,
    cached_input_tokens: value?.cachedInputTokens ?? 0,
    cache_write_input_tokens: value?.cacheWriteInputTokens ?? 0,
    output_tokens: value?.outputTokens ?? 0,
    reasoning_output_tokens: value?.reasoningOutputTokens ?? 0,
  };
}

export function mapTokenUsage(tokenUsage: {
  total?: TokenBreakdown;
  last?: TokenBreakdown;
  modelContextWindow?: number | null;
}): UsageSnapshot {
  return {
    totalUsage: mapUsage(tokenUsage.total),
    lastUsage: mapUsage(tokenUsage.last),
    contextTokens: tokenUsage.last?.inputTokens ?? 0,
    contextWindow: tokenUsage.modelContextWindow ?? undefined,
    updatedAt: new Date().toISOString(),
  };
}
