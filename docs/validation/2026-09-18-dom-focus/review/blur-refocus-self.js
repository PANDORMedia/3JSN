async function focusReview() {
  const results = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const label = node => node === null ? null : node.id || node.nodeName;
  for (const name of ['blur-refocus-self']) {
    const parent = document.createElement('div'); parent.id='review-parent';
    const a=document.createElement('button');a.id='review-a';parent.appendChild(a);
    const b=document.createElement('button');b.id='review-b';parent.appendChild(b);
    document.body.appendChild(parent);
    const style=document.createElement('style');document.head.appendChild(style);
    if(name==='focus-hides-self') style.textContent='#review-a:focus { display: none }';
    parent.getBoundingClientRect(); await tick();
    const events=[]; const actions=[];
    for(const n of [a,b])for(const type of ['blur','focusout','focus','focusin'])n.addEventListener(type,e=>events.push([type,label(n),label(document.activeElement),n.isConnected,label(n.parentNode)]));
    if(name!=='focus-hides-self')a.focus();
    events.length=0;
    if(name==='remove-parent-focus-sibling')a.addEventListener('blur',()=>b.focus(),{once:true});
    if(name==='remove-refocus-self'||name==='blur-refocus-self')a.addEventListener('blur',()=>a.focus(),{once:true});
    if(name==='blur-removes-anchor')a.addEventListener('blur',()=>parent.removeChild(b),{once:true});
    let error=null;
    try {
      if(name==='remove-parent-focus-sibling')document.body.removeChild(parent);
      if(name==='remove-refocus-self')parent.removeChild(a);
      if(name==='blur-refocus-self')a.blur();
      if(name==='replace-stylesheet-text')style.textContent='#review-a { display:none }';
      if(name==='append-stylesheet'){style.textContent='#review-a { display:none }'; document.head.removeChild(style);document.head.appendChild(style);}
      if(name==='focus-hides-self')a.focus();
      if(name==='blur-removes-anchor')parent.insertBefore(a,b);
    } catch(e){error=e.name;}
    actions.push(['immediate',label(document.activeElement),events.length]);
    await Promise.resolve(); parent.getBoundingClientRect();
    actions.push(['layout',label(document.activeElement),events.length]);
    await tick(); await tick();
    actions.push(['task',label(document.activeElement),events.length]);
    results.push({name,error,events,actions});
    if(parent.parentNode)parent.parentNode.removeChild(parent);
    if(style.parentNode)style.parentNode.removeChild(style);
    await tick();
  }
  return results;
}
globalThis.uiProbe={snapshot:focusReview};
