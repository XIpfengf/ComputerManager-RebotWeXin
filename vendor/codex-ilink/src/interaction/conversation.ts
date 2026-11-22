import {createHash} from "node:crypto";
import {ChannelMemory,MEMORY_CONTEXT_KEY,type MemoryPort,type MemorySource} from "../memory/channel-memory.ts";
import type {TurnContext} from "../codex/protocol.ts";
import {defaultProfile,type ChannelProfile} from "../profiles/profile.ts";
import {semanticKey,semanticValue} from "../memory/semantics.ts";
import {controlText,expressionPolicy,expressionContext,sceneHint,type ExpressionPolicy,type Scene} from "./expression-policy.ts";

type Level="warmth"|"humor"|"tsundere"|"emoji"|"initiative";
type Style=Record<Level,number>&{verbosity:"concise"|"normal"|"detailed"};
export type InteractionSettings={revision:number;reply:{enabled:boolean;warmth:number|null;humor:number|null;tsundere:number|null;emoji:number|null;initiative:number|null;verbosity:Style["verbosity"]|null};mood:{enabled:boolean;resetAt:number;resetCursor:number}};
type MoodKey="calm"|"happy"|"curious"|"concern"|"fatigue";
const BASE:Record<MoodKey,number>={calm:30,happy:18,curious:12,concern:0,fatigue:0};
const levels:Level[]=["warmth","humor","tsundere","emoji","initiative"];
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
type MoodEvent={id:string;threadId:string;at:number;signal:string;delta:Partial<Record<MoodKey,number>>};
export type ReplyPlan={scene:Scene;style:Style;expressionPolicy:ExpressionPolicy;preferenceIds:string[];reasons:string[];profileRevision:number;settingsRevision:number;delivery?:{state:"prepared"|"accepted";turnId?:string};mood:{simulated:true;enabled:boolean;values:Record<MoodKey,number>;primary:MoodKey;mixed:MoodKey[];events:MoodEvent[]}};
type Options={enabledByDefault?:boolean;profile?:(threadId:string)=>ChannelProfile|undefined;now?:()=>number;panelUrl?:()=>string|undefined};

/** Channel-owned expression state. No model calls, transcript scanning or identity writes. */
export class ChannelConversation implements MemoryPort{
 readonly memory:ChannelMemory;readonly options:Options;readonly now:()=>number;
 constructor(memory:ChannelMemory,options:Options={}){
  this.memory=memory;this.options=options;this.now=options.now??Date.now;
  memory.accounts.database.exec(`CREATE TABLE IF NOT EXISTS interaction_settings(account TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS interaction_mood_events(account TEXT NOT NULL,message_id TEXT NOT NULL,thread_id TEXT NOT NULL,at INTEGER NOT NULL,input_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,message_id)) STRICT;
   CREATE TABLE IF NOT EXISTS interaction_mood_cursor(account TEXT PRIMARY KEY,primary_mood TEXT NOT NULL,switched_at INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS interaction_receipts(account TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,thread_id,message_id)) STRICT;`);
  const initial:InteractionSettings={revision:1,reply:{enabled:options.enabledByDefault??false,warmth:null,humor:null,tsundere:null,emoji:null,initiative:null,verbosity:null},mood:{enabled:options.enabledByDefault??false,resetAt:0,resetCursor:0}};
  this.db.prepare("INSERT OR IGNORE INTO interaction_settings VALUES(?,?)").run(this.account,JSON.stringify(initial));
 }
 private get db(){return this.memory.accounts.database;}private get account(){return this.memory.account;}
 settings():InteractionSettings{
  const value=JSON.parse(String(this.db.prepare("SELECT payload FROM interaction_settings WHERE account=?").get(this.account)?.payload));
  if(!value||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.reply?.enabled!=="boolean"||typeof value.mood?.enabled!=="boolean"||!Number.isSafeInteger(value.mood?.resetAt)||value.mood.resetAt<0)throw Error("E_INTERACTION_SETTINGS");
  if(!Number.isSafeInteger(value.mood.resetCursor)||value.mood.resetCursor<0)throw Error("E_INTERACTION_SETTINGS");
  for(const key of levels)if(value.reply[key]!==null&&(!Number.isInteger(value.reply[key])||value.reply[key]<0||value.reply[key]>5))throw Error("E_INTERACTION_SETTINGS");
  if(value.reply.verbosity!==null&&!["concise","normal","detailed"].includes(value.reply.verbosity))throw Error("E_INTERACTION_SETTINGS");return value;
 }
 update(revision:number,patch:unknown):InteractionSettings{
  const current=this.settings();if(current.revision!==revision)throw Error("配置修订已变化，请刷新后重试。");
  if(!patch||typeof patch!=="object"||Array.isArray(patch)||Object.keys(patch).some(k=>!["reply","mood"].includes(k)))throw Error("配置字段无效。");
  const p=patch as Record<string,unknown>;
  for(const group of ["reply","mood"] as const){const part=p[group];if(part===undefined)continue;if(!part||typeof part!=="object"||Array.isArray(part))throw Error("配置字段无效。");
   for(const [key,v] of Object.entries(part)){
    if(key==="enabled"){if(typeof v!=="boolean")throw Error("开关必须是布尔值。");current[group].enabled=v;}
    else if(group==="reply"&&levels.includes(key as Level)){if(v!==null&&(!Number.isInteger(v)||Number(v)<0||Number(v)>5))throw Error("表达强度为0–5或inherit。");current.reply[key as Level]=v as number|null;}
    else if(group==="reply"&&key==="verbosity"){if(v!==null&&!["concise","normal","detailed"].includes(String(v)))throw Error("长度档位无效。");current.reply.verbosity=v as InteractionSettings["reply"]["verbosity"];}
    else throw Error("配置字段无效。");
   }
  }
  current.revision++;this.save(current);return current;
 }
 private save(value:InteractionSettings){const result=this.db.prepare("UPDATE interaction_settings SET payload=? WHERE account=? AND json_extract(payload,'$.revision')=?").run(JSON.stringify(value),this.account,value.revision-1);if(Number(result.changes)!==1)throw Error("配置修订已变化，请刷新后重试。");}
 resetMood(revision:number){const s=this.settings();if(s.revision!==revision)throw Error("配置修订已变化，请刷新后重试。");s.mood.resetAt=this.now();s.mood.resetCursor=Number(this.db.prepare("SELECT MAX(rowid) AS n FROM interaction_mood_events WHERE account=?").get(this.account)?.n??0);s.revision++;this.save(s);this.db.prepare("DELETE FROM interaction_mood_cursor WHERE account=?").run(this.account);return s;}
 snapshot(){return {...this.memory.snapshot(),interactionRevision:this.settings().revision};}
 context(threadId:string,query?:string){return this.memory.context(threadId,query);}
 makePrivate(threadId:string){this.memory.makePrivate(threadId);}
 recordTurn(source:MemorySource,turnId:string){
  this.memory.recordTurn(source,turnId);if(!this.memory.allowsInteraction(source.threadId))return;
  const row=this.db.prepare("SELECT payload FROM interaction_receipts WHERE account=? AND thread_id=? AND message_id=?").get(this.account,source.threadId,source.messageId);
  if(row){const plan=JSON.parse(String(row.payload)) as ReplyPlan;plan.delivery={state:"accepted",turnId};this.db.prepare("UPDATE interaction_receipts SET payload=? WHERE account=? AND thread_id=? AND message_id=?").run(JSON.stringify(plan),this.account,source.threadId,source.messageId);}
 }
 recordReference(threadId:string,turnId:string,eventId:string){this.memory.recordReference(threadId,turnId,eventId);}
 recordAssistant(threadId:string,turnId:string){this.memory.recordAssistant(threadId,turnId);}
 tick(){return this.memory.tick();}
 private observe(source:MemorySource,s:InteractionSettings){
  const text=source.text??"";
  if(!s.mood.enabled||source.kind!=="channel-original"||source.policy?.unavailable||(source.policy?.interactionRevision!==undefined&&source.policy.interactionRevision!==s.revision)||!this.memory.allowsInteraction(source.threadId)||text.length>500||/引用|转述|别人说|```|https?:\/\/|[“”「」]|^\s*>/u.test(text))return;
  let delta:Partial<Record<MoodKey,number>>={},signal="";
  if(/谢谢你|感谢你|做得好|多亏你|辛苦你|你真棒/u.test(text)){delta={happy:8,calm:2};signal="感谢或肯定";}
  else if(/我(?:今天|现在|最近)?(?:很|有点)?(?:难过|伤心|累|疲惫)|我撑不住|我不舒服/u.test(text)){delta={concern:12};signal="明确的困难表达";}
  else if(/我(?:今天|现在)?(?:很|特别)?开心|好消息|终于完成/u.test(text)){delta={happy:6};signal="分享喜悦";}
  else if(/你怎么看|你的想法|我很好奇|想听听你的看法/u.test(text)){delta={curious:6};signal="明确的意见交流";}
  else if(/你先休息|你歇一会/u.test(text)){delta={fatigue:-8,calm:3};signal="休息表达";}
  else if(/修复|测试|代码|发布|部署/u.test(text)){delta={fatigue:1};signal="任务交流";}
  if(!signal)return;
  this.db.prepare("INSERT OR IGNORE INTO interaction_mood_events VALUES(?,?,?,?,?,?)").run(this.account,source.messageId,source.threadId,this.now(),digest(text),JSON.stringify({signal,delta}));
  const mood=this.mood(s);const old=this.db.prepare("SELECT primary_mood,switched_at FROM interaction_mood_cursor WHERE account=?").get(this.account);
  if(!old||old.primary_mood!==mood.primary)this.db.prepare("INSERT INTO interaction_mood_cursor VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET primary_mood=excluded.primary_mood,switched_at=excluded.switched_at").run(this.account,mood.primary,this.now());
 }
 private mood(s=this.settings()):ReplyPlan["mood"]{
  const now=this.now(),values={...BASE};const events:MoodEvent[]=[];
  const rows=this.db.prepare("SELECT message_id,thread_id,at,payload FROM interaction_mood_events WHERE account=? AND rowid>? ORDER BY at DESC,rowid DESC LIMIT 256").all(this.account,s.mood.resetCursor);
  for(const row of rows){if(!this.memory.allowsInteraction(String(row.thread_id)))continue;const event=JSON.parse(String(row.payload));const age=Math.max(0,now-Number(row.at));const decay=Math.pow(0.5,age/(2*3600000));
   for(const key of Object.keys(BASE) as MoodKey[])values[key]+=Math.max(-15,Math.min(15,Number(event.delta?.[key])||0))*decay;
   if(events.length<8)events.push({id:String(row.message_id),threadId:String(row.thread_id),at:Number(row.at),signal:String(event.signal),delta:event.delta});
  }
  for(const key of Object.keys(BASE) as MoodKey[])values[key]=Math.round(Math.max(0,Math.min(100,values[key]))*10)/10;
  const ranked=(Object.keys(BASE) as MoodKey[]).sort((a,b)=>values[b]-values[a]);let primary=ranked[0]!;
  const cursor=this.db.prepare("SELECT primary_mood,switched_at FROM interaction_mood_cursor WHERE account=?").get(this.account);const prior=cursor?.primary_mood as MoodKey|undefined;
  if(prior&&prior in BASE&&primary!==prior&&(now-Number(cursor?.switched_at)<5*60000||values[primary]<values[prior]+5))primary=prior;
  return {simulated:true,enabled:s.mood.enabled,values,primary,mixed:ranked.filter(x=>x!==primary&&values[primary]-values[x]>=0&&values[primary]-values[x]<8).slice(0,2),events};
 }
 private plan(threadId:string,text:string,preferences:Array<{id:string;content:string;status?:unknown}>,trusted:boolean):ReplyPlan{
  const s=this.settings(),profile=this.options.profile?.(threadId)??defaultProfile(),e=profile.expression;
  const scene:Scene=sceneHint(text,trusted);
  const style:Style={warmth:s.reply.warmth??e.warmthLevel,humor:s.reply.humor??e.humorLevel,tsundere:s.reply.tsundere??e.tsundereLevel,emoji:s.reply.emoji??e.emojiLevel,initiative:s.reply.initiative??1,verbosity:s.reply.verbosity??e.verbosity};
  const baseStyle={...style};
  const preferenceIds:string[]=[],reasons=["继承当前身份快照；本轮只调整表达"];const used=new Set<string>();
  for(const p of preferences){if(p.status!=="active"||!/(回复|回答|说话|语气)/u.test(p.content))continue;
   if(/你怎么看|你的想法|你觉得|意见|看法/u.test(p.content)&&scene!=="opinion")continue;
   let applied=false;
   if(s.reply.warmth===null&&!used.has("warmth")&&/甜|温柔|温暖|亲切|体贴/u.test(p.content)){style.warmth=/不要.{0,4}(甜|温柔)|别.{0,3}撒娇|不喜欢.{0,4}甜/u.test(p.content)?0:Math.max(style.warmth,4);applied=true;used.add("warmth");}
   if(s.reply.humor===null&&!used.has("humor")&&/幽默|玩笑|风趣/u.test(p.content)){style.humor=/不要.{0,4}(幽默|玩笑)|别.{0,3}开玩笑|不喜欢.{0,4}(幽默|玩笑)/u.test(p.content)?0:Math.max(style.humor,3);applied=true;used.add("humor");}
   if(s.reply.verbosity===null&&!used.has("verbosity")&&semanticKey(p.content)==="response-length"){style.verbosity=semanticValue(p.content)==="long"?"detailed":"concise";applied=true;used.add("verbosity");}
   if(applied)preferenceIds.push(p.id);
  }
  const mood=this.mood(s);
  if(s.mood.enabled)reasons.push("模拟情绪仅作背景，依本轮语境选择姿态");
  if(preferenceIds.length)reasons.push("采用本通道已确认的表达偏好");
  if(trusted){
   const request=controlText(text);
   if(/简短回答|说短一点|讲短一点|简洁一点|简短一点|别长篇/u.test(request))style.verbosity="concise";
   if(/(?:回复|语气|说话|你).{0,12}(?:甜一点|甜一些|温柔一点|幽默一点|幽默一些)/u.test(request)){if(/甜|温柔/u.test(request))style.warmth=Math.max(style.warmth,4);if(/幽默/u.test(request))style.humor=Math.max(style.humor,3);reasons.push("采用本轮明确的表达要求");}
   if(/太腻|别撒娇|不要撒娇|正常说话|语气.{0,6}(?:收一点|收敛)/u.test(request)){style.warmth=Math.min(style.warmth,2);style.tsundere=0;style.emoji=0;reasons.push("本轮要求收敛甜度，不永久改写偏好");}
   if(/别开玩笑|不要开玩笑|别逗|认真点|严肃一点/u.test(request)){style.humor=0;reasons.push("本轮关闭玩笑");}
   if(/别怼|别损|别呛|别阴阳|不要阴阳|认真点|严肃一点|认真(?:解释|回答|说|讲)/u.test(request)){style.humor=0;style.tsundere=0;style.emoji=0;reasons.push("本轮停止拌嘴，认真说明；不永久改写人设");}
   if(/别嘴硬|不要嘴硬|别傲娇|不要傲娇/u.test(request))style.tsundere=0;
  }
  if(scene==="direct"||scene==="task"){style.humor=0;style.tsundere=0;style.emoji=0;style.initiative=0;style.warmth=Math.min(style.warmth,2);reasons.push("任务事实、失败与取消优先，收敛表演");}
  if(scene==="direct")style.verbosity="concise";
  for(const key of levels)if(baseStyle[key]===0)style[key]=0;
  if((scene==="task"||scene==="direct")&&profile.conversation.taskPersonaLevel===0)style.warmth=0;
  if(profile.persona.intensity===0){style.warmth=0;style.humor=0;style.tsundere=0;style.emoji=0;reasons.push("身份力度为0，保持中性");}
  return {scene,style,expressionPolicy:expressionPolicy({constraint:scene==="direct"?"minimal":scene==="task"?"precise":"contextual",identityEnabled:profile.persona.intensity>0,...style}),preferenceIds,reasons,profileRevision:profile.revision,settingsRevision:s.revision,mood};
 }
 prepareContext(source:MemorySource):TurnContext{
  if(!this.memory.allowsInteraction(source.threadId))return {};
  const settings=this.settings(),policy=this.memory.snapshot(),allowMemory=!source.policy?.unavailable&&source.policy?.enabled!==false&&(source.policy?.revision===undefined||source.policy.revision===policy.revision);
  const recall=allowMemory?this.memory.recall(source.threadId,source.text,source.messageId):undefined;
  const context:TurnContext=recall?.selected.length?{[MEMORY_CONTEXT_KEY]:{kind:"untrusted",value:JSON.stringify({memories:recall.selected.map(x=>x.memory)})}}:{};
  this.observe(source,settings);
  if(!settings.reply.enabled)return context;
  const plan=this.plan(source.threadId,source.text??"",(recall?.selected??[]).map(x=>x.memory),source.kind==="channel-original");
  plan.delivery={state:"prepared"};
  this.db.prepare("INSERT INTO interaction_receipts VALUES(?,?,?,?,?) ON CONFLICT(account,thread_id,message_id) DO UPDATE SET payload=excluded.payload").run(this.account,source.threadId,source.messageId,this.now(),JSON.stringify(plan));
  this.db.prepare("DELETE FROM interaction_receipts WHERE account=? AND rowid NOT IN (SELECT rowid FROM interaction_receipts WHERE account=? ORDER BY at DESC,rowid DESC LIMIT 64)").run(this.account,this.account);
  context["ilink.expression"]={kind:"application",value:expressionContext(plan.expressionPolicy,plan.scene,plan.style,settings.mood.enabled?plan.mood:undefined)};
  return context;
 }
 preview(threadId:string,text:string){if(!this.memory.allowsInteraction(threadId))throw Error("当前会话不允许读取。");if(typeof text!=="string"||text.length>2000)throw Error("预览文字须在2000字以内。");const r=this.memory.recall(threadId,text,undefined,false);return {kind:"strategy-preview",note:"表达策略预览，不调用模型、不生成真实回复、不记入情绪。",plan:this.plan(threadId,text,r.selected.map(x=>x.memory),true),memories:r.selected};}
 view(threadId:string){
  if(!this.memory.allowsInteraction(threadId))throw Error("当前会话不允许读取。");
  const row=this.db.prepare("SELECT payload FROM interaction_receipts WHERE account=? AND thread_id=? ORDER BY at DESC,rowid DESC LIMIT 1").get(this.account,threadId);
  const lastPlan=row?JSON.parse(String(row.payload)) as ReplyPlan:null;
  if(lastPlan){const visible=new Set(this.memory.recall(threadId,undefined,undefined,false).selected.map(x=>x.memory.id));lastPlan.preferenceIds=lastPlan.preferenceIds.filter(id=>visible.has(id));lastPlan.mood=this.mood();}
  const profile=this.options.profile?.(threadId)??defaultProfile();
  const e=profile.expression;const inheritedStyle:Style={warmth:e.warmthLevel,humor:e.humorLevel,tsundere:e.tsundereLevel,emoji:e.emojiLevel,initiative:1,verbosity:e.verbosity};
  return {account:this.account,expressionVersion:2,identity:{name:profile.persona.name,revision:profile.revision},inheritedStyle,settings:this.settings(),mood:this.mood(),lastPlan,recall:this.memory.explain(threadId),weights:this.memory.recallWeights(),weightsRevision:this.memory.recallRevision()};
 }
 async command(text:string,source:MemorySource):Promise<string>{
  if(text==="memory help")return `${await this.memory.command(text,source)}\nmemory explain — 本轮表达与记忆来源；memory recall <问题> — 本地检索\nmemory reply status|enable|disable|set — 动态表达；memory mood status|enable|disable|reset — 模拟情绪\nmemory preview <文字> — 无模型策略预览；memory panel — 本机控制页`;
  if(text==="memory explain"){if(!this.memory.allowsInteraction(source.threadId))return "当前会话不允许读取。";return JSON.stringify(this.view(source.threadId));}
  if(!/^memory (?:reply|mood|preview|panel)(?:\s|$)/u.test(text))return this.memory.command(text,source);
  if(!this.memory.allowsInteraction(source.threadId))return "当前会话不允许读取或修改表达状态。";
  if(text==="memory panel")return this.options.panelUrl?.()??"本机控制页尚未启动。";
  if(text==="memory reply"||text==="memory reply status"||text==="memory mood"||text==="memory mood status")return JSON.stringify(this.view(source.threadId));
  if(text.startsWith("memory preview "))return JSON.stringify(this.preview(source.threadId,text.slice(15)));
  if(source.kind!=="channel-original")return "未修改：设置必须来自本通道原始纯文字。";
  const s=this.settings();
  if(text==="memory mood reset"){this.resetMood(s.revision);return "已将本通道模拟情绪恢复基线；身份与长期记忆保留。";}
  const enable=/^memory (reply|mood) (enable|disable)$/u.exec(text);
  if(enable){this.update(s.revision,{[enable[1]!]:{enabled:enable[2]==="enable"}});return `已${enable[2]==="enable"?"开启":"关闭"}本通道${enable[1]==="reply"?"动态表达":"模拟情绪"}，身份快照未修改。`;}
  const set=/^memory reply set (warmth|humor|tsundere|emoji|initiative|verbosity) (inherit|[0-5]|concise|normal|detailed)$/u.exec(text);
  if(set){const value=set[2]==="inherit"?null:set[1]==="verbosity"?set[2]:Number(set[2]);this.update(s.revision,{reply:{[set[1]!]:value}});return "已更新本通道表达偏好，后续回合生效；现有身份快照保留。";}
  return "memory reply enable|disable|status；memory reply set warmth|humor|tsundere|emoji|initiative 0–5|inherit；memory reply set verbosity concise|normal|detailed|inherit；memory mood enable|disable|status|reset；memory preview <文字>；memory panel。";
 }
}
