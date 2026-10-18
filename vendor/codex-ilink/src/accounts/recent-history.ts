import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
type Message = { role: string; text: string; timestamp?: string };

/** Read a fixed window; tool outputs and image data never cross the App Server pipe. */
export async function recentHistory(path: unknown, query: string, beforeBytes?: number) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("E_HISTORY_PATH_UNAVAILABLE");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("E_HISTORY_NOT_FILE");
    const endOffset = Math.min(stat.size, beforeBytes ?? stat.size);
    const start = Math.max(0, endOffset - MAX_BYTES);
    const buffer = Buffer.alloc(endOffset - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const window = buffer.subarray(0, bytesRead);
    let offset = start > 0 ? window.indexOf(10) + 1 : 0;
    if (start > 0 && offset === 0) offset = bytesRead;
    // Include the skipped crossing record in the previous window, without a gap.
    const previousEnd = start > 0 && offset < bytesRead ? start + offset : start;
    let skippedRecords = start > 0 ? 1 : 0;
    let latestEvent: { type: string; timestamp?: string; turnId?: string } | null = null;
    const messages: Message[] = [];
    while (offset < bytesRead) {
      const end = window.indexOf(10, offset);
      if (end < 0) { skippedRecords++; break; } // An active writer may not have committed its last record.
      const line = window.subarray(offset, end);
      offset = end + 1;
      if (line.length > MAX_RECORD_BYTES) { skippedRecords++; continue; }
      let record;
      try { record = JSON.parse(line.toString("utf8")); } catch { skippedRecords++; continue; }
      const p = record?.payload;
      if (!p || typeof p !== "object") continue;
      const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
      if (record.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(p.type)) {
        latestEvent = { type: p.type, timestamp, ...(typeof p.turn_id === "string" ? {turnId:p.turn_id} : {}) };
      }
      if (record.type !== "response_item" || p.type !== "message" || !["user", "assistant"].includes(p.role)) continue;
      const text = (Array.isArray(p.content) ? p.content : []).filter((c: {type?:string;text?:unknown}) =>
        ["input_text","output_text","text"].includes(c?.type ?? "") && typeof c.text === "string")
        .map((c: {text:string}) => c.text).join("\n").replace(/<environment_context>[\s\S]*?<\/environment_context>/gu, "").trim();
      if (!text || (query && !text.toLowerCase().includes(query))) continue;
      messages.push({role:p.role,text:text.length > 4000 ? `${text.slice(0,4000)}\n[该条文字已节选]` : text,...(timestamp ? {timestamp} : {})});
      if (messages.length > 20) messages.shift();
    }
    while (messages.length > 1 && JSON.stringify(messages).length > 24000) messages.shift();
    return { messages, latestEvent, window: { bytesRead, partial: start > 0 || skippedRecords > 0, skippedRecords, nextBeforeBytes:start > 0 ? previousEnd : null } };
  } finally { await file.close(); }
}
