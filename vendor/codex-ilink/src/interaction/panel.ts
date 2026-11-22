import {createServer,type IncomingMessage,type ServerResponse} from "node:http";
import {randomBytes} from "node:crypto";
import {mkdirSync,writeFileSync,renameSync} from "node:fs";
import {dirname} from "node:path";
import type {AddressInfo} from "node:net";
import type {ChannelConversation} from "./conversation.ts";
import {interactionPage} from "./panel-page.ts";

export type PanelChannel={snapshot():unknown;preview(text:string):unknown;update(revision:number,patch:unknown):unknown;reset(revision:number):unknown;weights(revision:number,weights:unknown):unknown};
export function panelChannel(conversation:ChannelConversation,thread:()=>string):PanelChannel{return {snapshot:()=>conversation.view(thread()),preview:text=>conversation.preview(thread(),text),update:(rev,p)=>conversation.update(rev,p),reset:rev=>conversation.resetMood(rev),weights:(rev,w)=>conversation.memory.setRecallWeights(rev,w)};}
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join();}

/** Loopback only, per-account capabilities, no external scripts or cross-account selector. */
export async function startInteractionPanel(options:{channels:Map<string,PanelChannel>;accessFile:string;port?:number}){
 const tokens=new Map<string,string>();let origin="";
 const persist=()=>{mkdirSync(dirname(options.accessFile),{recursive:true});const file=options.accessFile+".tmp";writeFileSync(file,JSON.stringify({version:1,origin,accounts:Object.fromEntries([...tokens].map(([name,token])=>[name,`${origin}/#token=${token}`]))},null,2),{mode:0o600});renameSync(file,options.accessFile);};
 const urlFor = (name: string): string | undefined => {
  if (!options.channels.has(name)) return undefined;
  if (!tokens.has(name)) {
   tokens.set(name, randomBytes(32).toString("base64url"));
   try { persist(); }
   catch {
    tokens.delete(name);
    return undefined;
   }
  }
  return `${origin}/#token=${tokens.get(name)}`;
 };
 const handler=async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");
  const json=(status:number,data:unknown)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(data));};
  const expectedHost=new URL(origin).host;
  if(req.headers.host!==expectedHost||(req.headers.origin!==undefined&&req.headers.origin!==origin)){json(403,{error:"只接受本机控制页同源请求。"});return;}
  if(!req.url||req.url.includes("?")||req.url.includes("#")){json(400,{error:"请求地址无效。"});return;}
  if(req.method==="GET"&&req.url==="/"){const nonce=randomBytes(18).toString("base64");res.setHeader("Content-Security-Policy",`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(interactionPage(nonce));return;}
  const auth=req.headers.authorization;const account=[...tokens].find(([,token])=>auth===`Bearer ${token}`)?.[0];
  if(!account){json(401,{error:"需要当前通道的访问链接。"});return;}
  const channel=options.channels.get(account);if(!channel){json(503,{error:"当前通道尚未就绪。"});return;}
  try{
   if(req.method==="GET"&&req.url==="/api/status"){json(200,channel.snapshot());return;}
   if(req.method!=="POST"){json(405,{error:"不支持的请求。"});return;}
   if(!/^application\/json(?:;|$)/iu.test(req.headers["content-type"]??"")){json(415,{error:"需要JSON请求。"});return;}
   const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=data.length;if(bytes>16384){json(413,{error:"请求过大。"});return;}chunks.push(data);}
   const value:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
   if(req.url==="/api/settings"&&exact(value,["revision","patch"])&&Number.isSafeInteger(value.revision)){json(200,channel.update(Number(value.revision),value.patch));return;}
   if(req.url==="/api/weights"&&exact(value,["revision","weights"])&&Number.isSafeInteger(value.revision)){json(200,channel.weights(Number(value.revision),value.weights));return;}
   if(req.url==="/api/mood/reset"&&exact(value,["revision"])&&Number.isSafeInteger(value.revision)){json(200,channel.reset(Number(value.revision)));return;}
   if(req.url==="/api/preview"&&exact(value,["text"])&&typeof value.text==="string"){json(200,channel.preview(value.text));return;}
   json(400,{error:"请求字段无效。"});
  }catch(error){const message=error instanceof Error?error.message:"";json(message.includes("修订")?409:400,{error:/^[\u3400-\u9fff]/u.test(message)&&message.length<100?message:"请求无效或当前通道暂不可用。"});}
 };
 const server=createServer((req,res)=>{void handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port??0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
 const close = () => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
 });
 origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try {
  for (const name of options.channels.keys()) tokens.set(name, randomBytes(32).toString("base64url"));
  persist();
 } catch (error) {
  await close().catch(() => {});
  throw error;
 }
 return { origin, urlFor, close };
}
