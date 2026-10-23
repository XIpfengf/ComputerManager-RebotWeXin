export function selectDelegationTargets(entries:readonly {id:string;title:string}[],selector:string):Array<{id:string;title:string}>{
 const key=selector.toLocaleLowerCase();
 const matches=[...new Map(entries.filter(t=>t.title.toLocaleLowerCase().includes(key)).map(t=>[t.id,t])).values()];
 // A real exact title outranks previews that merely quote a delegation request.
 const exact=matches.filter(t=>t.title.toLocaleLowerCase()===key);
 return exact.length?exact:matches;
}
