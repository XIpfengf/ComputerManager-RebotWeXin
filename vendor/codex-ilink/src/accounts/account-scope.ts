import type { CodexRuntime } from "../codex/codex-runtime.ts";
import type { CodexEvent } from "../bridge/bridge.ts";
import { SqliteTurnLeaseStore } from "../coordination/turn-lease.ts";
import type { AcquireTurnLeaseInput, ClaimBridgeTurnInput, MarkDesktopStopInput, ReleaseTurnLeaseInput } from "../coordination/turn-lease.ts";
import { AccountStore } from "./account-store.ts";

/** All accounts arbitrate in the original Guard DB; reconciliation sees only its own threads. */
export class AccountLeaseStore extends SqliteTurnLeaseStore {
  readonly accounts: AccountStore;
  readonly account: string;
  constructor(path: string, accounts: AccountStore, account: string) { super(path); this.accounts = accounts; this.account = account; }
  check(threadId: string): void {
    if (this.accounts.owner(threadId) !== this.account) throw new Error("E_ACCOUNT_THREAD_OWNERSHIP");
  }
  override listLeases() { return super.listLeases().filter(l => this.accounts.owner(l.threadId) === this.account); }
  override getLease(id: string) { this.check(id); return super.getLease(id); }
  override tryAcquire(input: AcquireTurnLeaseInput) { this.check(input.threadId); return super.tryAcquire(input); }
  override release(input: ReleaseTurnLeaseInput) { this.check(input.threadId); return super.release(input); }
  override isHeldBy(input: ReleaseTurnLeaseInput) { this.check(input.threadId); return super.isHeldBy(input); }
  override claimBridgeTurn(input: ClaimBridgeTurnInput) { this.check(input.threadId); return super.claimBridgeTurn(input); }
  override markDesktopStop(input: MarkDesktopStopInput) { this.check(input.threadId); return super.markDesktopStop(input); }
  override releaseStoppedDesktop(input: Pick<MarkDesktopStopInput, "threadId" | "turnId">) { this.check(input.threadId); return super.releaseStoppedDesktop(input); }
}

const ID_ARGUMENT_METHODS = new Set(["resumeThread", "ensureThread", "archiveThread", "unarchiveThread", "compactThread", "updateThreadModelSettings"]);
const OBJECT_ARGUMENT_METHODS = new Set(["readThread", "setThreadName", "startTurn", "interruptTurn"]);

/** A facade, not a second App Server. Owns event delivery and approval tokens. */
export function accountCodex(runtime: CodexRuntime, accounts: AccountStore, name: string): CodexRuntime {
  const requestIds = new Set<number | string>();
  const check = (id: unknown) => {
    if (typeof id !== "string" || accounts.owner(id) !== name) throw new Error("E_ACCOUNT_THREAD_OWNERSHIP");
  };
  return new Proxy(runtime, {
    get(target, key) {
      if (key === "close") return () => undefined; // Host owns the shared runtime.
      if (key === "onEvent") return (listener: (e: CodexEvent) => void) => target.onEvent(event => {
        const id = event.params.threadId;
        if (typeof id === "string" && accounts.owner(id) !== name) return;
        if (event.id !== undefined) {
          if (typeof id !== "string") return;
          for (const request of requestIds) if (!target.isServerRequestLive(request)) requestIds.delete(request);
          requestIds.add(event.id);
        }
        listener(event);
      });
      if (key === "isServerRequestLive") return (id: number | string) => requestIds.has(id) && target.isServerRequestLive(id);
      if (key === "respondToServerRequest") return (id: number | string, result: Record<string, unknown>) => {
        if (!requestIds.delete(id)) return false;
        return target.respondToServerRequest(id, result);
      };
      if (key === "startThread") return async (...args: Parameters<CodexRuntime["startThread"]>) => {
        const result = await target.startThread(...args);
        accounts.claimThread(name, result.thread.id);
        return result;
      };
      if (key === "listThreads") return async (...args: Parameters<CodexRuntime["listThreads"]>) => {
        const result = await target.listThreads(...args);
        return { ...result, data: result.data.filter(t => {
          if (!t || typeof t !== "object") return false;
          const id = (t as { id?: unknown }).id;
          return typeof id === "string" && accounts.owner(id) === name;
        }) };
      };
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (typeof key === "string" && (ID_ARGUMENT_METHODS.has(key) || OBJECT_ARGUMENT_METHODS.has(key))) {
        return (...args: unknown[]) => {
          const input = args[0];
          check(ID_ARGUMENT_METHODS.has(key) ? input : (input as { threadId?: unknown })?.threadId);
          if (key === "setThreadName" && (input as { name?: string }).name === "微信主会话") {
            return target.setThreadName({ threadId: (input as { threadId: string }).threadId, name: `微信主会话 · ${name}` });
          }
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}
