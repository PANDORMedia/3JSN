(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'bridge', 'peer', 'subject'].map(id => [id, document.getElementById(id)]),
  );
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'margin:0;padding:0;background:transparent;',
    outer: 'position:relative;left:32px;top:24px;width:320px;height:176px;background:transparent;',
    middle: 'position:static;display:block;width:280px;height:144px;background:transparent;',
    bridge: 'display:none;',
    peer: 'position:absolute;left:40px;top:20px;right:auto;bottom:auto;width:80px;height:64px;margin:0;background:#2060e0;z-index:1;order:0;',
    subject: 'position:fixed;left:48px;top:40px;right:auto;bottom:auto;width:128px;height:64px;margin:0;background:#e02030;z-index:1;order:0;',
  };
  const flexItem = 'position:relative;left:auto;top:auto;width:128px;height:80px;flex:0 0 auto;margin-right:-96px;';
  const flex = { middle: 'display:flex;align-items:flex-start;', peer: flexItem, subject: flexItem };
  const grid = {
    middle: 'display:grid;grid-template-columns:240px;grid-template-rows:120px;',
    peer: 'position:relative;left:auto;top:auto;grid-area:1/1;width:96px;height:64px;margin-left:32px;margin-top:16px;',
    subject: 'position:relative;left:auto;top:auto;grid-area:1/1;width:128px;height:80px;',
  };
  const flexOutOfFlow = {
    middle: `${flex.middle}position:relative;`,
    peer: `${flexItem}margin-left:32px;top:16px;order:1;z-index:auto;`,
    subject: 'position:absolute;left:0;top:0;width:128px;height:80px;z-index:auto;',
  };
  const cases = {
    'owners-positive': {},
    'owners-negative': { peer: 'z-index:-1;', subject: 'z-index:-1;' },
    'effect-auto-order': {
      root: 'clip-path:inset(0);',
      peer: 'position:relative;z-index:auto;',
      subject: 'z-index:auto;',
    },
    'flex-order-forward': { ...flex, peer: `${flex.peer}order:1;` },
    'flex-order-reverse': { ...flex, peer: `${flex.peer}order:-1;` },
    'flex-order-reset': flex,
    'flex-oof-order-negative': { ...flexOutOfFlow, subject: `${flexOutOfFlow.subject}order:-9;` },
    'flex-oof-order-positive': { ...flexOutOfFlow, subject: `${flexOutOfFlow.subject}order:9;` },
    'grid-order-forward': { ...grid, peer: `${grid.peer}order:1;` },
    'grid-order-reverse': { ...grid, peer: `${grid.peer}order:-1;` },
    'grid-order-reset': grid,
    'grid-oof-order-positive': {
      ...grid,
      middle: `${grid.middle}position:relative;`,
      peer: `${grid.peer}order:1;z-index:auto;`,
      subject: 'position:absolute;left:0;top:0;width:128px;height:80px;order:9;z-index:auto;',
    },
    'contents-flex-order': {
      ...flex,
      bridge: 'display:contents;order:-100;',
      peer: `${flex.peer}order:-1;`,
      subject: `${flex.subject}order:1;`,
    },
    'contents-grid-order': {
      ...grid,
      bridge: 'display:contents;order:-100;',
      peer: `${grid.peer}order:-1;`,
      subject: `${grid.subject}order:1;`,
    },
    'pseudo-order-ties': { ...grid, peer: 'display:none;' },
    'pseudo-order-flipped': { ...grid, peer: 'display:none;' },
    'dom-peer-last': {},
    'dom-order-restored': {},
  };
  let treeMode = 'normal';

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown paint order case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
      nodes.middle.setAttribute('data-pseudos', name === 'pseudo-order-ties' ? 'ties'
        : name === 'pseudo-order-flipped' ? 'flipped' : 'none');
      const mode = name.startsWith('contents-') ? 'contents'
        : ['effect-auto-order', 'dom-peer-last'].includes(name) ? 'peer-after' : 'normal';
      if (mode !== treeMode) {
        nodes.middle.appendChild(nodes.bridge);
        if (mode === 'contents') {
          nodes.bridge.appendChild(nodes.subject);
          nodes.middle.appendChild(nodes.peer);
        } else if (mode === 'peer-after') {
          nodes.middle.appendChild(nodes.subject);
          nodes.middle.appendChild(nodes.peer);
        } else {
          nodes.middle.appendChild(nodes.peer);
          nodes.middle.appendChild(nodes.subject);
        }
        treeMode = mode;
      }
    },
  };
})();
