import type { FileChangeItem } from "@/types/api";

/** Normalize app-server arrays and persisted FileChange maps through one path. */
export function mapFileChanges(id: string, raw: unknown): FileChangeItem[] {
  const changes = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.entries(raw).map(([path, value]) => ({ path, ...(value as object) }))
      : [];
  return changes.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    if (typeof entry.path !== "string") return [];
    const kind = entry.kind ?? entry.type;
    const details = kind && typeof kind === "object" ? kind as Record<string, unknown> : {};
    const type = typeof kind === "string" ? kind : details.type;
    const movePath = details.movePath ?? details.move_path ?? entry.move_path;
    const change: FileChangeItem["change"] = type === "add" ? "create"
      : type === "delete" ? "delete"
      : type === "rename" || typeof movePath === "string" ? "rename" : "edit";
    const target = typeof movePath === "string" ? movePath : entry.path;
    const content = typeof entry.diff === "string" ? entry.diff
      : typeof entry.content === "string" ? entry.content : undefined;
    return [{
      id: id + ":" + index,
      type: "file_change" as const,
      change,
      path: target,
      ...(change === "rename" ? { oldPath: entry.path } : {}),
      patch: content === undefined ? undefined
        : change === "create" || change === "delete"
          ? contentDiff(content, entry.path, change === "create")
          : content,
    }];
  });
}

/** For additions/deletions the protocol carries file content, not a unified diff. */
function contentDiff(content: string, path: string, addition: boolean): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const count = lines.length;
  const range = count ? "1," + count : "0,0";
  return [
    "--- " + (addition ? "/dev/null" : path),
    "+++ " + (addition ? path : "/dev/null"),
    "@@ -" + (addition ? "0,0" : range) + " +" + (addition ? range : "0,0") + " @@",
    ...lines.map((line) => (addition ? "+" : "-") + line),
    ...(content && !content.endsWith("\n") ? ["\\ No newline at end of file"] : []),
  ].join("\n");
}
