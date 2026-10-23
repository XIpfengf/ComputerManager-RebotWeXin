import {createInterface} from "node:readline";
import {DELEGATION_TOOL} from "./tool.ts";
import {callDelegationServer} from "./ipc.ts";
const pipe=process.env.CODEX_ILINK_DELEGATION_PIPE;
if(!pipe)throw Error("E_DELEGATION_PIPE_REQUIRED");
const lines=createInterface({input:process.stdin});
for await(const line of lines){
 let request:Record<string,any>;try{request=JSON.parse(line);}catch{continue;}
 if(request.id===undefined)continue;
 const reply=(result:unknown)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\n");
 if(request.method==="initialize"){reply({protocolVersion:request.params?.protocolVersion??"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"ilink-delegation",version:"1.0.0"}});continue;}
 if(request.method==="tools/list"){reply({tools:[DELEGATION_TOOL]});continue;}
 if(request.method==="tools/call"){
   void(async()=>{try{
     if(request.params?.name!==DELEGATION_TOOL.name)throw Error("Unknown tool");
     let metadata=request.params?._meta?.["x-codex-turn-metadata"];if(typeof metadata==="string")metadata=JSON.parse(metadata);
     if(!metadata?.thread_id||!metadata?.turn_id)throw Error("Missing real origin");
     const result=await callDelegationServer(pipe,{threadId:metadata.thread_id,turnId:metadata.turn_id},request.params.arguments);
     reply({isError:!result.ok,content:[{type:"text",text:result.text}]});
   }catch{reply({isError:true,content:[{type:"text",text:"委派连接不可用或缺少真实微信回合上下文；没有绕过授权投递任务。"}]});}})();continue;
 }
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32601,message:"Method not found"}})+"\n");
}
