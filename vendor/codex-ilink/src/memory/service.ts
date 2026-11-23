import type { AccountStore } from "../accounts/account-store.ts";
import { ChannelMemory, type MemoryPort } from "./channel-memory.ts";

/** Deployment scope uses authenticated registry aliases, never display names or model arguments. */
export function v2AccountEnabled(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment.ILINK_V2_ACCOUNTS;
  if (!value || value.length > 4096) return false;
  const names = value.split(",").map(part => part.trim());
  return names.length <= 100 && names.every(part => /^[a-z][a-z0-9-]{0,31}$/u.test(part)) && names.includes(name);
}

export function createChannelMemory(accounts: AccountStore, account: string, options: NonNullable<ConstructorParameters<typeof ChannelMemory>[2]> = {}): MemoryPort {
  try { return new ChannelMemory(accounts, account, options); }
  catch {
    return {
      command: async () => "记忆服务不可用，未确认保存。普通消息和任务仍可继续。",
      context: () => { throw Error("E_MEMORY_UNAVAILABLE"); },
      snapshot: () => ({ enabled: false, autoEnabled: false, revision: 0, unavailable: true }),
      makePrivate: () => { throw Error("E_MEMORY_UNAVAILABLE"); },
      recordTurn() {}, recordReference() {}, recordAssistant() {}, async tick() {},
    };
  }
}
