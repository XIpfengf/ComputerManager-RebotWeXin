import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Read-only compatibility bridge: current App Server Thread does not expose Desktop pins. Fail closed on schema drift. */
export function isDesktopThreadPinned(threadId: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  const home=environment.CODEX_HOME?.trim()||join(environment.USERPROFILE??homedir(),".codex");
  const files=readdirSync(home).filter(n=>/^state_\d+\.sqlite$/u.test(n)).sort((a,b)=>Number(b.match(/\d+/u)![0])-Number(a.match(/\d+/u)![0]));
  const path=files[0]?join(home,files[0]):null;if(!path||!existsSync(path))throw new Error("无法核实 Desktop 固定状态，停止归档");
  const db=new DatabaseSync(path,{readOnly:true});
  try{db.exec("PRAGMA busy_timeout=1500");const columns=db.prepare("PRAGMA table_info(threads)").all().map(r=>r.name);if(!columns.includes("id")||!columns.includes("is_pinned"))throw new Error("Desktop固定状态格式变化，停止归档");
    const row=db.prepare("SELECT is_pinned FROM threads WHERE id=?").get(threadId);if(!row)throw new Error("Desktop线程不存在，停止归档");return row.is_pinned===1;
  }finally{db.close();}
}
