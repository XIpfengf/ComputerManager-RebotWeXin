/** Local Chinese recall. Scores rank already-authorized evidence, never grant access. */
export type RecallWeights = { relevance:number; time:number; explicit:number };
export const DEFAULT_RECALL_WEIGHTS:RecallWeights={relevance:3,time:1,explicit:2};
export type RecalledMemory = Record<string,unknown> & {id:string;content:string;threadId:string;messageId:string;createdAtMs:number};
const domains = [
 {name:"饮食",pattern:/吃|食物|饮食|口味|米饭|面条|鸡蛋|包子|早餐|午餐|晚餐|晚饭|午饭|早饭|菜单|餐厅|晚膳|下馆子/u},
 {name:"表达偏好",pattern:/回复|回答|说话|语气|幽默|甜一|温柔|温暖|傲娇|风趣|简短|简洁|啰嗦|你怎么看|你的想法|你觉得|你认为|意见|看法/u},
 {name:"生日",pattern:/生日|出生|庆生|生辰/u},
];
const normal=(s:string)=>s.toLowerCase().replace(/白米饭|大米饭|大米/gu,"米饭").replace(/晚膳|晚饭/gu,"晚餐").replace(/风趣|有趣一点/gu,"幽默").replace(/[\s\p{P}\p{S}]/gu,"");
function terms(s:string):Set<string>{const v=normal(s).replace(/你怎么看|你的想法|你觉得|你认为|我希望|我喜欢|我不喜欢|我决定|我最喜欢|你还记得|请问|这个|那个|一下|一些|什么|怎么|可以|时候|之前|最早|现在|最近|以前/gu," ");return new Set(v.split(/\s+/u).flatMap(x=>[...x].slice(0,128).flatMap((_,i)=>i+1<x.length?[x.slice(i,i+2)]:[])));}
export function recallTimeIntent(query=""):"earliest"|"recent"|"current"{
 if(/最早|第一次|最初|当初/u.test(query)&&!/刚刚|刚才|最近/u.test(query))return "earliest";
 return /刚刚|刚才|最近|上次/u.test(query)?"recent":"current";
}
export function rankMemories(rows:RecalledMemory[],query:string|undefined,weights:RecallWeights,now:number){
 const q=terms(query??""),intent=recallTimeIntent(query),all=query===undefined||/记得|偏好|记忆|约定|以前/u.test(query);
 return rows.flatMap(row=>{
  if(intent!=="earliest"&&(row.status==="superseded"||(typeof row.validUntilMs==="number"&&row.validUntilMs<=now)))return [];
  const d=terms(row.content),common=[...q].filter(t=>d.has(t)).length;
  const domain=domains.find(x=>x.pattern.test(query??"")&&x.pattern.test(row.content));
  // Generic words such as “希望/之前” alone are not recall evidence.
  if(!all&&!domain&&common===0)return [];
  const relevance=domain?0.6+Math.min(0.4,common/Math.max(1,q.size)):all&&q.size===0?0.4:common/Math.max(1,q.size);
  if(!all&&!domain&&relevance<0.12)return [];
  const age=Math.max(0,now-row.createdAtMs),freshness=1/(1+age/(30*86400000));
  const temporal=intent==="earliest"?1-freshness:freshness;
  const explicit=row.evidenceType==="correction"?1:row.evidenceType==="explicit"?0.7:0.3;
  const score=Math.round((relevance*weights.relevance+temporal*weights.time+explicit*weights.explicit)*1000)/1000;
  const timeLabels={earliest:"最早记录",recent:"近期记录",current:"当前有效"};const evidenceLabels:Record<string,string>={correction:"本人纠正",explicit:"本人明确陈述",extracted:"合格原话提炼"};
  const reasons=[domain?`主题：${domain.name}`:`词语匹配：${common}`,`时间意图：${timeLabels[intent]}`,`证据：${evidenceLabels[String(row.evidenceType)]??"来源待核"}`];
  if(row.status==="conflict")reasons.push("存在冲突，不能作为确定事实");
  if(row.status==="superseded")reasons.push("历史版本，已经被纠正取代");
  return [{memory:row,score,reasons}];
 }).sort((a,b)=>{
  if(intent==="earliest")return a.memory.createdAtMs-b.memory.createdAtMs||b.score-a.score;
  if(a.memory.evidenceType==="correction"&&b.memory.evidenceType!=="correction")return -1;
  if(b.memory.evidenceType==="correction"&&a.memory.evidenceType!=="correction")return 1;
  return b.score-a.score||b.memory.createdAtMs-a.memory.createdAtMs||a.memory.id.localeCompare(b.memory.id);
 });
}
