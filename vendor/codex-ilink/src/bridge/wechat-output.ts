export const WECHAT_TEXT_MAX_UTF8_BYTES = 2_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export type WechatLocalFileReference = {
  label: string;
  path: string;
};

export function extractWechatLocalFileReferences(text: string): {
  references: WechatLocalFileReference[];
  text: string;
} {
  const references: WechatLocalFileReference[] = [];
  const remaining: string[] = [];
  let fence: ReturnType<typeof markdownFence> = null;
  for (const line of text.split(/\r?\n/gu)) {
    const marker = markdownFence(line);
    if (fence || marker) {
      remaining.push(line);
      if (fence && marker?.marker === fence.marker && marker.length >= fence.length && marker.rest.trim() === "") fence = null;
      else if (!fence && marker) fence = marker;
      continue;
    }
    const reference = standaloneLocalFileReference(line);
    if (reference) references.push(reference);
    else remaining.push(replaceInlineLocalLinks(line, references));
  }
  return {
    references,
    text: remaining.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
  };
}

/** Bounded individual messages, unbounded number of parts. No body is discarded. */
export function formatWechatFinalReply(
  text: string,
): string[] {
  text = stripDesktopInboxItemDirectives(text);
  text = extractWechatLocalFileReferences(text).text;
  if (text.length === 0) return [];
  if (Buffer.byteLength(text, "utf8") <= WECHAT_TEXT_MAX_UTF8_BYTES) {
    return [text];
  }

  const messages: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const split = takeUtf8Prefix(remaining, WECHAT_TEXT_MAX_UTF8_BYTES);
    if (!split.suffix) { messages.push(split.prefix); break; }
    // Prefer complete paragraphs, then lines/sentences. Keep the exact original
    // separators so concatenating text parts recovers the complete body.
    let end = split.prefix.lastIndexOf("\n\n");
    if (end >= 0) end += 2;
    if (end < split.prefix.length / 3) {
      const boundaries = [...split.prefix.matchAll(/[\n。！？!?；;]/gu)];
      const last = boundaries.at(-1);
      end = last ? last.index + last[0].length : 0;
    }
    if (end < split.prefix.length / 3) end = split.prefix.length;
    messages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return messages;
}

function stripDesktopInboxItemDirectives(text: string): string {
  const lines: string[] = [];
  let activeFence: { length: number; marker: "`" | "~" } | null = null;
  for (const line of text.split(/\r?\n/gu)) {
    const fence = markdownFence(line);
    if (activeFence) {
      lines.push(line);
      if (
        fence?.marker === activeFence.marker &&
        fence.length >= activeFence.length &&
        fence.rest.trim().length === 0
      ) {
        activeFence = null;
      }
      continue;
    }
    if (fence) {
      activeFence = { length: fence.length, marker: fence.marker };
      lines.push(line);
      continue;
    }
    if (!/^::inbox-item\{.*\}\s*$/u.test(line)) lines.push(line);
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function markdownFence(
  line: string,
): { length: number; marker: "`" | "~"; rest: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  const run = match?.[1];
  if (!run) return null;
  const marker = run[0];
  if (marker !== "`" && marker !== "~") return null;
  const rest = match?.[2] ?? "";
  if (marker === "`" && rest.includes("`")) return null;
  return { length: run.length, marker, rest };
}

function takeUtf8Prefix(
  text: string,
  maxBytes: number,
): { prefix: string; suffix: string } {
  let bytes = 0;
  let utf16Length = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (bytes + segmentBytes > maxBytes) break;
    bytes += segmentBytes;
    utf16Length += segment.length;
  }
  if (utf16Length === 0 && text.length > 0) {
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (bytes + characterBytes > maxBytes) break;
      bytes += characterBytes;
      utf16Length += character.length;
    }
  }
  return {
    prefix: text.slice(0, utf16Length),
    suffix: text.slice(utf16Length),
  };
}

function standaloneLocalFileReference(
  line: string,
): WechatLocalFileReference | null {
  const candidate = line.replace(
    /\s+(?:\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?\s*)+$/u,
    "",
  );
  const angle = /^\s*!?\[([^\]\r\n]*)\]\(\s*<((?:[A-Za-z]:[\\/]{1,2})[^>\r\n]+)>\s*\)\s*$/u.exec(
    candidate,
  );
  const plain = angle
    ? null
    : /^\s*!?\[([^\]\r\n]*)\]\(\s*((?:[A-Za-z]:[\\/]{1,2})[^)\r\n]+)\s*\)\s*$/u.exec(
        candidate,
      );
  const match = angle ?? plain;
  if (!match?.[2]) return null;
  return {
    label: match[1]?.trim() || "附件",
    path: match[2].trim(),
  };
}

function isLocalFileTarget(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^file:\/\//iu.test(path) ||
    (!/^[a-z][a-z0-9+.-]*:/iu.test(path) && !/^(?:#|\/\/)/u.test(path) && /[.\\/]/u.test(path));
}

/** Handles balanced parentheses and angle destinations; code spans stay data. */
function replaceInlineLocalLinks(line: string, references: WechatLocalFileReference[]): string {
  let result = "", offset = 0, codeRun = 0;
  while (offset < line.length) {
    if (line[offset] === "`") {
      let end = offset;
      while (line[end] === "`") end++;
      const length = end - offset;
      codeRun = codeRun === length ? 0 : (codeRun || length);
      result += line.slice(offset, end); offset = end; continue;
    }
    const start = line[offset] === "!" && line[offset + 1] === "[" ? offset + 1 : offset;
    if (!codeRun && line[start] === "[") {
      const labelEnd = line.indexOf("](", start + 1);
      if (labelEnd >= 0) {
        let end = labelEnd + 2, depth = 1, angle = false;
        for (; end < line.length; end++) {
          const ch = line[end];
          if (ch === "<") angle = true;
          else if (ch === ">") angle = false;
          else if (!angle && ch === "(") depth++;
          else if (!angle && ch === ")" && --depth === 0) break;
        }
        const raw = line.slice(labelEnd + 2, end).trim();
        const path = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
        if (end < line.length && isLocalFileTarget(path)) {
          const label = line.slice(start + 1, labelEnd).trim() || "附件";
          references.push({ label, path });
          result += label; offset = end + 1; continue;
        }
      }
    }
    result += line[offset++];
  }
  return result;
}
