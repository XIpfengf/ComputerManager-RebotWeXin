import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {readdirSync} from "node:fs";
import {join} from "node:path";
import {createInterface} from "node:readline";

export type DelegationContext = {threadId:string;turnId:string};
export interface DesktopTools {call(context:DelegationContext, tool:"read_thread"|"send_message_to_thread", args:Record<string,unknown>):Promise<Record<string,any>>;close():void;}

/** Only the official Desktop MCP server speaks to the Desktop endpoint. */
export function discoverDesktopTools(environment:NodeJS.ProcessEnv=process.env, pipes:()=>string[]=()=>readdirSync("\\\\.\\pipe\\")): {endpoint:string;server:string} {
  const names=pipes().filter(p=>/^codex-app-tools-[0-9a-f-]{36}$/iu.test(p)).map(p=>`\\\\.\\pipe\\${p}`);
  const inherited=environment.CODEX_APP_TOOLS_PIPE_PATH;
  const endpoint=inherited && names.includes(inherited)?inherited:names.length===1?names[0]:undefined;
  if(!endpoint)throw new Error(names.length>1?"E_DESKTOP_CONNECTION_AMBIGUOUS":"E_DESKTOP_UNAVAILABLE");
  const home=environment.CODEX_HOME??(environment.USERPROFILE?join(environment.USERPROFILE,".codex"):undefined);
  if(!home)throw new Error("E_DESKTOP_PACKAGE_UNAVAILABLE");
  const root=join(home,"plugins","cache","openai-bundled","codex-app-tools");
  const versions=readdirSync(root).filter(x=>/^\d+\.\d+\.\d+$/u.test(x)).sort((a,b)=>a.localeCompare(b,"en",{numeric:true}));
  if(!versions.length)throw new Error("E_DESKTOP_PACKAGE_UNAVAILABLE");
  return {endpoint,server:join(root,versions.at(-1)!,"server.mjs")};
}

export class OfficialDesktopTools implements DesktopTools {
  #child:ChildProcessWithoutNullStreams|undefined;
  #pending=new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  #id=0;
  #ready:Promise<void>|undefined;
  readonly environment:NodeJS.ProcessEnv;
  readonly discover:()=>{endpoint:string;server:string};
  constructor(environment:NodeJS.ProcessEnv=process.env, discover=()=>discoverDesktopTools(environment)){this.environment=environment;this.discover=discover;}
  #request(method:string,params:Record<string,unknown>):Promise<any>{
    const id=++this.#id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#pending.delete(id);reject(new Error("E_DESKTOP_RPC_OUTCOME_UNKNOWN"));this.close();},20_000);
      this.#pending.set(id,{resolve,reject,timer});
      this.#child!.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n",e=>{if(e)this.close();});
    });
  }
  async #connect():Promise<void>{
    const {endpoint,server}=this.discover();
    const child=spawn(process.execPath,[server],{env:{...this.environment,CODEX_APP_TOOLS_PIPE_PATH:endpoint,CODEX_APP_TOOLS_DEFERRED:"0"},stdio:["pipe","pipe","pipe"],windowsHide:true,shell:false});
    this.#child=child;child.stderr.resume();
    child.on("error",()=>this.close());child.on("close",()=>{if(this.#child===child)this.close();});
    const lines=createInterface({input:child.stdout});
    lines.on("line",line=>{try{const m=JSON.parse(line);const p=this.#pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.#pending.delete(m.id);m.error?p.reject(new Error("E_DESKTOP_TOOL_FAILED")):p.resolve(m.result);}catch{this.close();}});
    await this.#request("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"codex-ilink-delegation",version:"1.0.0"}});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
  }
  async call(context:DelegationContext,tool:"read_thread"|"send_message_to_thread",args:Record<string,unknown>):Promise<Record<string,any>>{
    if(!/^[0-9a-f-]{36}$/iu.test(context.threadId)||!/^[0-9a-f-]{36}$/iu.test(context.turnId))throw new Error("E_DELEGATION_ORIGIN_REQUIRED");
    await(this.#ready??=this.#connect());
    const result=await this.#request("tools/call",{name:tool,arguments:args,_meta:{"x-codex-turn-metadata":{thread_id:context.threadId,turn_id:context.turnId}}});
    if(result.isError)throw new Error("E_DESKTOP_TOOL_FAILED");
    const text=result.content?.find((x:any)=>x.type==="text")?.text;
    try{return JSON.parse(text);}catch{throw new Error("E_DESKTOP_RESULT_INVALID");}
  }
  close():void{const child=this.#child;this.#child=undefined;this.#ready=undefined;child?.stdin.end();if(child?.exitCode===null)child.kill();for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(new Error("E_DESKTOP_RPC_OUTCOME_UNKNOWN"));}this.#pending.clear();}
}
