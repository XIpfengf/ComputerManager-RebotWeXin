import { spawn } from "node:child_process";
import { SqliteState } from "../bridge/sqlite-state.ts";
import { runLoginFlow } from "../cli/login-flow.ts";
import { currentHostStatus, type CliIo } from "../cli/ilink.ts";
import { ILinkClient } from "../ilink/ilink-client.ts";
import { protectForCurrentUser, unprotectForCurrentUser } from "../windows/dpapi.ts";
import { runtimePaths } from "../windows/runtime-paths.ts";
import { AccountStore, assertAccountName, PRIMARY_ACCOUNT } from "./account-store.ts";

export async function accountsCommand(args: readonly string[], io: CliIo): Promise<number> {
  if (process.platform !== "win32") throw new Error("E_HOST_WINDOWS_ONLY");
  const [action, alias] = args;
  if (!((action === "list" && args.length === 1) || (action === "add" && alias && args.length === 2))) {
    io.error("用法: ilink accounts list | ilink accounts add <别名>（例如 secondary）");
    return 2;
  }
  const accounts = new AccountStore(runtimePaths().dataDirectory);
  let state: SqliteState | undefined;
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error("E_LOGIN_CANCELLED"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    accounts.importPrimary();
    if (action === "list") {
      const host = await currentHostStatus();
      for (const account of accounts.list()) io.log(`${account.name}：已绑定，${host?.accounts?.[account.name]?.phase ?? "未加载"}（独立会话）`);
      return 0;
    }
    assertAccountName(alias!);
    if (alias === PRIMARY_ACCOUNT || accounts.list().some(a => a.name === alias)) throw new Error("别名已存在；添加不会替换已有微信");
    const tokens: string[] = [];
    for (const account of accounts.list()) {
      const existing = accounts.openState(account.name);
      try {
        const session = existing.getILinkSession();
        if (session) tokens.push(unprotectForCurrentUser(session.protectedToken));
      } finally { existing.close(); }
    }
    state = accounts.openState(alias!);
    // Recover an unpublished successful scan without overwriting that binding.
    let result = state.getILinkSession();
    if (!result) {
      await runLoginFlow({
        ilink: new ILinkClient(), localTokenList: tokens,
        now: Date.now, protectToken: protectForCurrentUser, state,
        signal: abort.signal,
        showQr: url => {
          io.log(`请用第二个微信扫码，保留原微信绑定：${url}`);
          const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true });
          child.on("error", () => io.error("浏览器打开失败，请使用上面的二维码链接")); child.unref();
        },
        sleep: milliseconds => new Promise<void>((resolve, reject) => {
          const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", onAbort); resolve(); };
          const onAbort = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", onAbort); reject(abort.signal.reason); };
          const timer = setTimeout(done, milliseconds);
          abort.signal.addEventListener("abort", onAbort, { once: true });
          if (abort.signal.aborted) onAbort();
        }),
      });
      result = state.getILinkSession();
    }
    if (!result) throw new Error("E_ACCOUNT_LOGIN_NOT_SAVED");
    if (accounts.list().some(a => a.userId === result.controllerUserId || a.botId === result.botId)) throw new Error("这个微信已绑定；请使用另一个微信扫码，原绑定未替换");
    accounts.register(alias!, result.controllerUserId, result.botId);
    io.log(`账号 ${alias} 已添加。运行中的多账号 Bridge 会自动加载；请由用户验证两个微信各自收发。`);
    return 0;
  } finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    state?.close(); accounts.close();
  }
}
