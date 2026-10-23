import {createServer,createConnection,type Server} from "node:net";
import type {DelegationContext} from "./desktop-tools.ts";
export type DelegationHandler=(context:DelegationContext,args:unknown)=>Promise<string>;
export async function startDelegationServer(path:string,handle:DelegationHandler):Promise<Server>{
 const server=createServer(socket=>{let input="";let started=false;socket.setTimeout(30_000,()=>socket.destroy());socket.on("error",()=>{});socket.on("data",chunk=>{if(started)return;input+=chunk.toString();if(Buffer.byteLength(input)>128*1024){socket.destroy();return;}if(!input.includes("\n"))return;started=true;
   void (async()=>{try{const p=JSON.parse(input.slice(0,input.indexOf("\n")));if(!/^[0-9a-f-]{36}$/iu.test(p.context?.threadId??"")||!/^[0-9a-f-]{36}$/iu.test(p.context?.turnId??""))throw Error("来源会话无效");const text=await handle(p.context,p.arguments);socket.end(JSON.stringify({ok:true,text})+"\n");}catch(error){const message=error instanceof Error?error.message:"委派请求失败";const text=/^[\u3400-\u9fff]/u.test(message)&&message.length<160&&!/[\\/]/u.test(message)?message:"委派请求未通过校验或服务暂不可用。";socket.end(JSON.stringify({ok:false,text})+"\n");}})();});});
 await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path,()=>{server.off("error",reject);resolve();});});return server;
}
export async function callDelegationServer(path:string,context:DelegationContext,args:unknown):Promise<{ok:boolean;text:string}>{
 return new Promise((resolve,reject)=>{const socket=createConnection(path);let output="";let done=false;const fail=()=>{if(!done){done=true;reject(Error("E_DELEGATION_IPC_UNAVAILABLE"));}socket.destroy();};socket.setTimeout(30_000,fail);socket.on("error",fail);socket.on("connect",()=>socket.write(JSON.stringify({context,arguments:args})+"\n"));socket.on("data",chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>256*1024)return fail();if(output.includes("\n")){try{const result=JSON.parse(output.slice(0,output.indexOf("\n")));done=true;resolve(result);socket.destroy();}catch{fail();}}});socket.on("end",()=>{if(!done)fail();});});
}
