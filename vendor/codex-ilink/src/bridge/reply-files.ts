import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  outboundMediaPathKey, stageOutboundMedia, stagedOutboundMedia,
  serializeOutboundPayload, removeOutboundMediaSnapshot,
} from "../media/outbound-media.ts";
import type { OutboundAttachmentIntent } from "./sqlite-state.ts";
import { extractWechatLocalFileReferences } from "./wechat-output.ts";

/** Resolve only explicit local file links; web citations are not downloaded. */
export function replyFilePath(target: string, workspace: string): string {
  let path = target;
  if (/^file:/iu.test(path)) {
    const url = new URL(path);
    if (url.hostname && url.hostname !== "localhost") throw new Error("E_OUTBOUND_MEDIA_PATH");
    path = fileURLToPath(url);
  } else {
    try { path = decodeURIComponent(path); } catch { /* literal percent in a filename */ }
    path = path.replace(/#(?:L\d+(?:-L\d+)?|[^#]*)$/u, "").replace(/:\d+(?::\d+)?$/u, "");
  }
  if (/^[\\/]{2}/u.test(path)) throw new Error("E_OUTBOUND_MEDIA_PATH");
  return win32.isAbsolute(path) ? path : win32.resolve(workspace, path);
}

export function prepareReplyFiles(input: {
  text: string;
  workspaceRoot?: string;
  exportRoot?: string;
  registered?: readonly OutboundAttachmentIntent[];
}): { text: string; bodies: string[] } {
  const extracted = extractWechatLocalFileReferences(input.text);
  const bodies: string[] = [], failures: string[] = [];
  const paths = new Set<string>(), snapshots = new Set<string>();
  const add = (media: ReturnType<typeof stagedOutboundMedia>) => {
    const identity = /([0-9a-f]{64})(\.[^\\/]*)?$/iu.exec(media.path);
    const key = identity ? `${identity[1]}${identity[2] ?? ""}`.toLowerCase() : outboundMediaPathKey(media.path);
    if (snapshots.has(key)) { removeOutboundMediaSnapshot(media.path, input.exportRoot ?? ""); return; }
    snapshots.add(key); bodies.push(serializeOutboundPayload(media));
  };
  for (const attachment of input.registered ?? []) {
    if (attachment.snapshotProvenance !== "staged-v1") {
      failures.push("⚠️ 旧版附件记录未通过当前安全校验，未发送本机文件；请在新的 iLink 任务中重新发送。"); continue;
    }
    try {
      // Reuse the already-authorized immutable send_file snapshot.
      const media = stagedOutboundMedia({ exportRoot: input.exportRoot ?? "", label: attachment.name, path: attachment.path });
      if (!paths.has(outboundMediaPathKey(media.path))) { paths.add(outboundMediaPathKey(media.path)); add(media); }
    } catch { failures.push(`⚠️ 附件“${attachment.name}”未发送：附件快照不可用。`); }
  }
  for (const reference of extracted.references) {
    const label = reference.label.replace(/[\r\n]/gu, " ");
    if (!input.workspaceRoot || !input.exportRoot) {
      failures.push(`⚠️ 附件“${label}”未发送：无法核验当前任务目录。`); continue;
    }
    try {
      const path = replyFilePath(reference.path, input.workspaceRoot);
      const key = outboundMediaPathKey(path);
      if (paths.has(key)) continue;
      paths.add(key);
      add(stageOutboundMedia({ path, workspaceRoot: input.workspaceRoot, exportRoot: input.exportRoot, label }));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const reason = code.includes("OUTSIDE_WORKSPACE") ? "文件不在当前任务目录，请先复制到任务目录后再发送"
        : code.includes("TOO_LARGE") ? "文件超过 100 MB"
        : code.includes("LINK") ? "文件链接未通过安全校验"
        : "文件不存在、不可读或路径不受支持";
      failures.push(`⚠️ 附件“${label}”未发送：${reason}。`);
    }
  }
  return { text: [...failures, extracted.text].filter(Boolean).join("\n\n"), bodies };
}
