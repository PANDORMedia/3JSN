import { withBrowserSession } from '../../scripts/compatibility/browser-session.mjs';
import { writeFile } from 'node:fs/promises';
const report = await withBrowserSession('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', async ({command,origin}) => {
  await command('Page.enable');
  await command('Page.navigate',{url:origin+'/fixtures/dom-focus/index.html'});
  await command('Page.bringToFront');
  let ready=false;
  for(let i=0;i<100;i++) {
    const r=await command('Runtime.evaluate',{expression:'document.readyState === "complete" && !!document.body && location.pathname.endsWith("index.html")',returnByValue:true});
    if(r.result?.value){ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  if(!ready) throw Error('Navigation timeout');
  const r=await command('Runtime.evaluate',{expression:`(() => {
    const result=[];
    for (const [name,action] of [
      ['self-before',s=>s.p.insertBefore(s.a,s.a)],
      ['append-last',s=>s.p.appendChild(s.a)],
      ['before-next',s=>s.p.insertBefore(s.a,s.b)],
      ['invalid-remove',s=>s.q.removeChild(s.a)],
      ['invalid-cycle',s=>s.a.appendChild(s.p)],
      ['text-ancestor',s=>s.p.textContent='new'],
      ['text-self',s=>s.a.textContent='new'],
    ]) {
      const p=document.createElement('div'),q=document.createElement('div'),a=document.createElement('button'),b=document.createElement('button');
      a.id='a';b.id='b'; p.appendChild(a); if(name==='before-next') p.appendChild(b); document.body.appendChild(p);document.body.appendChild(q);a.focus();
      const events=[];for(const kind of ['blur','focusout'])a.addEventListener(kind,e=>events.push({type:e.type,connected:a.isConnected,parent:a.parentNode===p,active:document.activeElement.id||document.activeElement.tagName}));
      let error=null;try{action({a,b,p,q});}catch(e){error=e.name;}
      result.push({name,error,events:structuredClone(events),active:document.activeElement.id||document.activeElement.tagName});p.remove();q.remove();
    }return result;
  })()`, returnByValue:true});
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
  return {version:await command('Browser.getVersion'),pageHadFocus:(await command('Runtime.evaluate',{expression:'document.hasFocus()',returnByValue:true})).result.value,mutations:r.result.value};
});
await writeFile(new URL('./report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
