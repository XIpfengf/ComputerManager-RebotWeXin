import { win32 } from "node:path";
import type { DelegationContext, DesktopTools } from "./desktop-tools.ts";

const PAGE_SIZE = 50;
const MAX_PAGES = 2;
const MAX_SESSIONS = 20;
const DESKTOP_QUERY_TIMEOUT_MS = 8_000;

type Session = { id: string; title?: string };
type DesktopSession = Session & { status: string; cwd?: string; projectId?: string };
type ActivityProject = { id: string; name: string; cwd: string };

function belongsToProject(row: DesktopSession | undefined, project: ActivityProject): boolean {
  if (row?.projectId === project.id) return true;
  if (!row?.cwd || !win32.isAbsolute(row.cwd)) return false;
  const relative = win32.relative(project.cwd, row.cwd);
  return relative === "" ||
    (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
}

function parseSession(value: unknown): DesktopSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.hostId !== "local" || typeof row.id !== "string" || !row.id || typeof row.status !== "string") {
    return undefined;
  }
  return {
    id: row.id,
    status: row.status,
    ...(typeof row.title === "string" && row.title ? { title: row.title.slice(0, 200) } : {}),
    ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
    ...(typeof row.projectId === "string" ? { projectId: row.projectId } : {}),
  };
}

function findProject(values: unknown[], selector: string): ActivityProject | undefined {
  const key = selector.trim().toLowerCase();
  const matches: ActivityProject[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const { label, path, projectId } = row;
    if (row.projectKind !== "local" || (row.hostId !== undefined && row.hostId !== "local") ||
        typeof label !== "string" || typeof path !== "string" || !win32.isAbsolute(path) ||
        typeof projectId !== "string" || !projectId) continue;
    if ([label, win32.basename(path), projectId].some(name => name.toLowerCase() === key)) {
      matches.push({ id: projectId, name: label, cwd: path });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export async function listSessionActivity(input: {
  context: DelegationContext;
  project?: string;
  includeInactive?: boolean;
  tools: () => DesktopTools;
  activeBridgeThreads?: () => readonly string[];
  canRead: (id: string) => boolean;
  assertLive: () => void;
}) {
  const rows = new Map<string, DesktopSession>();
  let desktop = "unavailable";
  let project: ActivityProject | undefined;
  let tools: DesktopTools | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(undefined); }, DESKTOP_QUERY_TIMEOUT_MS);
  });

  try {
    tools = input.tools();
    if (input.project) {
      const result = await Promise.race([tools.call(input.context, "list_projects", {}), deadline]);
      input.assertLive();
      if (Array.isArray(result?.projects)) {
        project = findProject(result.projects, input.project);
        if (!project) return { status: "project_unresolved", note: "未找到唯一的已保存本机项目，请核对项目名。" };
      }
    }
    const visited = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && !expired && (!input.project || project); page++) {
      input.assertLive();
      const result = await Promise.race([
        tools.call(input.context, "list_threads", {
          source: "codex", hostId: "local", mode: "history", limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
        deadline,
      ]);
      if (!result || !Array.isArray(result.threads)) break;
      desktop = "partial";
      for (const value of result.threads) {
        const row = parseSession(value);
        if (row && row.id !== input.context.threadId && input.canRead(row.id) && !rows.has(row.id)) {
          rows.set(row.id, row);
        }
      }
      if (result.nextCursor === null) {
        desktop = "complete";
        break;
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || visited.has(result.nextCursor)) break;
      cursor = result.nextCursor;
      visited.add(cursor);
    }
  } catch {
    // Keep any verified page and report the coverage of this snapshot.
  } finally {
    clearTimeout(timer);
    tools?.close();
  }
  input.assertLive();

  if (input.includeInactive) {
    const sessions: Session[] = [];
    for (const row of rows.values()) {
      if (!input.canRead(row.id) || (project && !belongsToProject(row, project))) continue;
      sessions.push({ id: row.id, ...(row.title ? { title: row.title } : {}) });
    }
    return {
      status: desktop === "unavailable" ? "unavailable" : "listed",
      desktopCoverage: desktop,
      ...(project ? { project: project.name } : {}),
      observedAt: new Date().toISOString(),
      sessions: sessions.slice(0, MAX_SESSIONS),
      truncated: sessions.length > MAX_SESSIONS,
      note: "仅列出本通道可见的本机会话名称和 ID，已排除查询所在会话。最多返回 20 条；部分覆盖时可用项目名缩小范围，或按名称、ID 查询。",
    };
  }

  const bridge = new Set(input.activeBridgeThreads?.() ?? []);
  const ids = new Set([...rows.keys(), ...bridge]);
  const active: Session[] = [];
  for (const id of ids) {
    if (id === input.context.threadId || !input.canRead(id)) continue;
    const row = rows.get(id);
    if (input.project && (!project || !belongsToProject(row, project))) continue;
    if (row?.status === "active" || bridge.has(id)) {
      active.push({ id, ...(row?.title ? { title: row.title } : {}) });
    }
  }

  return {
    status: active.length ? "active" : desktop === "unavailable" ? "unavailable" : "none_observed",
    desktopCoverage: desktop,
    ...(project ? { project: project.name } : {}),
    observedAt: new Date().toISOString(),
    activeCount: active.length,
    sessions: active.slice(0, MAX_SESSIONS),
    note: "仅统计本通道可见的本机活动会话，已排除本次查询所在会话。active 表示回合处于活动状态，也可能在等待审批。覆盖不全或没有观察到活动时，不能据此断言其他会话已停止。",
  };
}
