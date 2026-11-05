/**
 * rollout 文件逐行读取器。
 *
 * 透明处理 .jsonl 与 .jsonl.zst：
 * - .jsonl：fs.createReadStream + 按行切分
 * - .jsonl.zst：fs.createReadStream → fzstd 流式解压 → 按行切分
 *
 * plain 与 zst 并存时由 paths.ts 优先返回 plain。
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Transform, pipeline } from "node:stream";
import { Decompress } from "fzstd";
import type { RolloutLine } from "./types";
import { isCompressed } from "./paths";

/**
 * 逐行读取 rollout 文件，yield 解析后的 RolloutLine。
 * 解析失败的行跳过（不中断）。
 */
export async function* readRolloutLines(filePath: string): AsyncIterable<RolloutLine> {
  const compressed = isCompressed(filePath);
  let stream: NodeJS.ReadableStream;

  if (compressed) {
    stream = createZstdDecompressStream(filePath);
  } else {
    stream = createReadStream(filePath, { encoding: "utf8" });
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === "object" && obj !== null && typeof obj.type === "string") {
        yield obj as RolloutLine;
      }
    } catch {
      // 损坏行跳过
    }
  }
}

/** 仅读取首行（session_meta），用于列表与元数据接口 */
export async function readFirstLine(filePath: string): Promise<RolloutLine | null> {
  const compressed = isCompressed(filePath);
  let stream: NodeJS.ReadableStream;

  if (compressed) {
    stream = createZstdDecompressStream(filePath);
  } else {
    stream = createReadStream(filePath, { encoding: "utf8" });
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      rl.close();
      destroyStream(stream);
      const trimmed = line.trim();
      if (!trimmed) return null;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj === "object" && obj !== null) {
          return obj as RolloutLine;
        }
      } catch {
        return null;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 安全销毁流（兼容 Node Readable 与 web ReadableStream） */
function destroyStream(stream: NodeJS.ReadableStream): void {
  try {
    const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
    s.destroy?.();
  } catch {
    /* ignore */
  }
}

/**
 * 读取前 N 行（用于提取首条用户消息预览）。
 * 找到目标后立即关闭流，避免读取大文件全部内容。
 */
export async function readLinesUntil(
  filePath: string,
  predicate: (line: RolloutLine, index: number) => boolean,
  maxLines = 200,
): Promise<RolloutLine[]> {
  const compressed = isCompressed(filePath);
  const stream = compressed
    ? createZstdDecompressStream(filePath)
    : createReadStream(filePath, { encoding: "utf8" });

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const collected: RolloutLine[] = [];
  let i = 0;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj !== "object" || obj === null) continue;
        const rl_line = obj as RolloutLine;
        collected.push(rl_line);
        i++;
        if (predicate(rl_line, i) || i >= maxLines) {
          break;
        }
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
    destroyStream(stream);
  }

  return collected;
}

/**
 * 创建 zstd 解压流。
 * fzstd 的 Decompress 通过 ondata 回调输出解压数据，final=true 表示结束。
 */
function createZstdDecompressStream(filePath: string): NodeJS.ReadableStream {
  const decoder = new Decompress();
  const out = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        decoder.push(new Uint8Array(chunk));
        callback();
      } catch (error) { callback(error as Error); }
    },
    flush(callback) {
      try {
        decoder.push(new Uint8Array(0), true);
        callback();
      } catch (error) { callback(error as Error); }
    },
  });
  decoder.ondata = (data: Uint8Array) => { out.push(Buffer.from(data)); };
  // pipeline propagates early close/errors to the archive's input stream.
  pipeline(createReadStream(filePath, { highWaterMark: 16 * 1024 }), out, () => {});
  return out;
}
