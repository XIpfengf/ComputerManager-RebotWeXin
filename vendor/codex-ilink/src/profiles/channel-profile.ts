import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { CodexRuntime, ThreadIdentitySettings } from "../codex/codex-runtime.ts";
import type { ProjectNavigationEntry } from "../bridge/bridge.ts";
import type { ThreadPermissionSettings } from "../codex/protocol.ts";
import { compilePersona, defaultProfile, PROFILE_FIELDS, setProfileField, type ChannelProfile } from "./profile.ts";
import { hash, ProfileStore } from "./profile-store.ts";
export type ProfilePort = {
  command(text: string): Promise<string>;
  workspace(selected: string | null): Promise<string | null>;
  status(threadId: string): string;
};
export class ProfileValidationError extends Error {}
export const CONFIG_HELP = ["config — 本通道配置（仅未来新会话生效）", "config show | models | efforts | projects", "config set <配置项> <值>",
  `配置项：${Object.keys(PROFILE_FIELDS).join(" / ")} / workspace`,
  '例：config set name 小白狐', '例：config set traits ["聪明","亲和"]', '例：config set tone 轻松、友好，工作时清楚直接',
  'config set model <完整模型ID或inherit>', 'config set effort <强度或inherit>', 'config set workspace inbox 或 project:<config projects中的稳定键>',
  'config reload — 载入手工编辑且校验通过的本地配置', 'config reset — 查看重置确认码', 'new — 使用最新配置开启空白会话；clear — 替换当前会话并归档旧会话',
  'model / effort 只修改当前会话；config set model/effort 只修改以后新建会话。', '用 config set address "" 清空文本。身份力度 intensity=0–5，任务力度 task-persona=0–2；有效任务力度不超过身份力度。'].join("\n");
/** Service is bound by the host to one authenticated account, never a user-supplied alias. */
export class ChannelProfileService implements ProfilePort {
  readonly store: ProfileStore; readonly account: string; readonly runtime: CodexRuntime; readonly projects: () => Promise<readonly ProjectNavigationEntry[]> | readonly ProjectNavigationEntry[];
  #tail: Promise<unknown> = Promise.resolve();
  #reset: { code: string; revision: number; expires: number } | undefined;
  constructor(options: { store: ProfileStore; account: string; runtime: CodexRuntime; projects: ChannelProfileService["projects"] }) {
    this.store = options.store; this.account = options.account; this.runtime = options.runtime; this.projects = options.projects;
  }
  serial<T>(fn: () => Promise<T>): Promise<T> { const work = this.#tail.then(fn); this.#tail = work.catch(() => {}); return work; }
  async projectCatalog(): Promise<Array<ProjectNavigationEntry & { key: string }>> {
    return (await this.projects()).flatMap(p => {
      try { const cwd = realpathSync.native(p.cwd); return [{ ...p, cwd, key: `project-${hash(cwd.replaceAll("/", "\\").toLowerCase()).slice(0,24)}` }]; } catch { return []; }
    });
  }
  async workspace(selected: string | null): Promise<string | null> {
    return this.workspaceFor(this.store.load(this.account), selected);
  }
  private async workspaceFor(p: ChannelProfile, selected: string | null): Promise<string | null> {
    if (selected) return selected;
    if (p.session.workspace.mode === "inbox") return null;
    const found = (await this.projectCatalog()).find(x => x.key === p.session.workspace.projectKey); if (!found) throw new Error("默认项目已不可用；发送 config projects 重新选择，或 config set workspace inbox"); return found.cwd;
  }
  async models() { const result = []; let cursor: string | null = null;
    do { const page = await this.runtime.listModels(cursor ? { cursor } : {}); result.push(...page.data.filter(m => !m.hidden)); cursor = page.nextCursor; } while (cursor); return result; }
  async validateExecution(p: ChannelProfile, cwd?: string): Promise<{ model: string; effort: string }> {
    const project = cwd ?? (p.session.workspace.mode === "project" ? (await this.workspaceFor(p, null)) ?? undefined : undefined);
    const defaults = p.session.model === null ? await this.runtime.readDefaultModelSettings(project) : { model: p.session.model, effort: null };
    const models = await this.models(); const model = p.session.model ?? defaults.model;
    const selected = models.find(m => m.model === model || m.id === model); if (!selected) throw new Error("模型不可用；发送 config models 查看完整标识");
    const effort = p.session.reasoningEffort ?? (p.session.model === null ? defaults.effort ?? selected.defaultReasoningEffort : selected.defaultReasoningEffort);
    if (!selected.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new Error("模型不支持该推理强度；先 config set effort inherit，再更换模型");
    if (p.session.workspace.mode === "project" && !(await this.projectCatalog()).some(x => x.key === p.session.workspace.projectKey)) throw new Error("默认项目不存在；发送 config projects 查看");
    return { model: selected.model, effort };
  }
  async command(text: string): Promise<string> { return this.serial(async () => {
    try { return await this.execute(text.trim()); } catch (e) { return `配置操作失败：${e instanceof Error ? e.message : "未知错误"}。未改变现有会话。`; }
  }); }
  private async execute(text: string): Promise<string> {
    const action = text.replace(/^config\b\s*/u, "");
    if (action === "help") return CONFIG_HELP;
    this.store.initialize(this.account);
    if (action === "reload") {
      const p = await this.store.reload(this.account, async candidate => {
        const old = JSON.parse(this.store.current(this.account)!.payload) as ChannelProfile;
        if (JSON.stringify(old.session) !== JSON.stringify(candidate.session)) await this.validateExecution(candidate);
      }); this.#reset = undefined; return this.saved(p);
    }
    const p = this.store.load(this.account);
    if (!action) return [this.status(""), `身份：${p.persona.name}；称呼：${p.persona.userAddress || "（无）"}`, "配置位置：profiles/<当前通道>/profile.json（本机私有）", "发送 config help 查看命令；修改后发 new 生效。"].join("\n");
    if (action === "show") return JSON.stringify(p, null, 2);
    if (action === "models") return (await this.models()).map(m => `${m.model}：${m.supportedReasoningEfforts.map(e => e.reasoningEffort).join(" / ")}；默认 ${m.defaultReasoningEffort}`).join("\n");
    if (action === "efforts") { const resolved = await this.validateExecution(p); const m = (await this.models()).find(m => m.model === resolved.model)!; return `${m.model}\n${m.supportedReasoningEfforts.map(e => `${e.reasoningEffort}：${e.description}`).join("\n")}\n新会话解析强度：${resolved.effort}`; }
    if (action === "projects") return (await this.projectCatalog()).map(p => `${p.key}：${p.name || basename(p.cwd)}`).join("\n") || "暂无可选项目";
    if (action === "reset") { this.#reset = { code: randomBytes(4).toString("hex").toUpperCase(), revision: p.revision, expires: Date.now() + 120000 }; return `将重置当前通道身份和新会话默认设置，保留绑定与历史。两分钟内发送 config reset confirm ${this.#reset.code}`; }
    if (action.startsWith("reset confirm ")) { const reset = this.#reset; this.#reset = undefined;
      if (!reset || reset.expires <= Date.now() || reset.revision !== p.revision || action !== `reset confirm ${reset.code}`) throw new Error("确认码无效、已使用或过期，请重新 config reset");
      return this.saved(this.store.save(this.account, { ...defaultProfile(), revision: p.revision }));
    }
    const match = /^set ([a-z-]+) ([\s\S]+)$/u.exec(action);
    if (match) { const next = setProfileField(p, match[1]!, match[2]!);
      if (JSON.stringify(p.session) !== JSON.stringify(next.session)) await this.validateExecution(next);
      const saved = this.store.save(this.account, next); this.#reset = undefined; return this.saved(saved);
    }
    return `配置命令格式不正确。\n${CONFIG_HELP}`;
  }
  saved(p: ChannelProfile): string { return `已保存本通道配置 v${p.revision}；现有会话保持原快照，发送 new 或 clear 后生效。`; }
  status(threadId: string): string {
    const current = this.store.current(this.account); const snapshot = threadId ? this.store.thread(threadId, this.account) : null;
    return [`已保存配置：${current ? `v${current.revision}` : "尚未初始化"}`, `新会话默认：${current ? (() => { const p = JSON.parse(current.payload) as ChannelProfile; return `${p.session.model ?? "继承 Codex"} / ${p.session.reasoningEffort ?? "继承默认强度"}`; })() : "继承 Codex"}`,
      ...(threadId ? [snapshot ? `当前身份快照：${snapshot.profile.persona.name} v${snapshot.profile.revision}；创建时 ${snapshot.model} / ${snapshot.effort ?? "默认"}` : "当前身份快照：旧会话（未注入通道身份）"] : [])].join("\n");
  }
  async start(cwd: string, permissions: ThreadPermissionSettings, create: CodexRuntime["startThread"], selection?: ThreadIdentitySettings): ReturnType<CodexRuntime["startThread"]> {
    return this.serial(async () => {
      let p: ChannelProfile; let resolved: { model: string; effort: string };
      try {
        p = this.store.load(this.account);
        if (selection?.inboxDirectory) cwd = (await this.workspaceFor(p, selection.workspaceSelection ?? null)) ?? selection.inboxDirectory;
        resolved = await this.validateExecution(p, cwd);
      } catch (e) { throw new ProfileValidationError(`无法使用通道配置新建会话：${e instanceof Error ? e.message : "配置不可用"}`); }
      const instructions = compilePersona(p);
      const started = await create(cwd, permissions, { developerInstructions: instructions, model: resolved.model, effort: resolved.effort });
      try {
        if (started.model !== resolved.model || started.reasoningEffort !== resolved.effort) throw new Error("原生会话参数与请求不一致");
        this.store.snapshot({ account: this.account, threadId: started.thread.id, profile: p, instructions, model: resolved.model, effort: resolved.effort, cwd: String(started.cwd ?? cwd) });
      } catch (e) { await this.runtime.archiveThread(started.thread.id).catch(() => {}); throw e; }
      return started;
    });
  }
}
