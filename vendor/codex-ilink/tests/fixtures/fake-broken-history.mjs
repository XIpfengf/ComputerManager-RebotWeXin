import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  if(request.method==='initialize') console.log(JSON.stringify({id:request.id,result:{}}));
  if(request.method==='turn/start') {
    console.log(JSON.stringify({method:'turn/started',params:{threadId:request.params.threadId,turn:{id:'active-turn'}}}));
    console.log(JSON.stringify({id:request.id,result:{turn:{id:'active-turn'}}}));
  }
  if(request.method==='thread/read') {
    if(request.params.includeTurns) process.stdout.write('{"id":2,"result":{"text":"unescaped\nnewline"}}\n');
    else console.log(JSON.stringify({id:request.id,result:{thread:{id:request.params.threadId,turns:[]}}}));
  }
  if(request.method==='thread/turns/list') {
    if(process.argv.includes('--break-pages')) process.stdout.write('{"result":"broken\npage"}\n');
    else if(process.argv.includes('--two-pages') && !request.params.cursor) console.log(JSON.stringify({id:request.id,result:{data:[{id:'earlier',status:'completed',items:[]}],nextCursor:'page-2'}}));
    else console.log(JSON.stringify({id:request.id,result:{data:[{id:'external-turn',status:'completed',items:[{type:'agentMessage',phase:'final',text:'FULL_FINAL_原样保留'.repeat(1000)}]}],nextCursor:null}}));
  }
  if(request.method==='model/list') console.log(JSON.stringify({id:request.id,result:{data:[],nextCursor:null}}));
});
