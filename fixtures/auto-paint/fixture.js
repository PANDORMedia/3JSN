(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'branch', 'peer', 'subject'].map(id => [id, document.getElementById(id)]),
  );
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'margin:0;padding:0;background:transparent;',
    outer: 'position:relative;left:32px;top:24px;width:320px;height:176px;background:transparent;',
    middle: 'position:static;display:block;width:240px;height:128px;margin:0;border:0;padding:0;background:transparent;',
    branch: 'position:static;display:block;width:240px;height:128px;margin-top:-128px;background:transparent;',
    peer: 'position:relative;left:40px;top:20px;width:80px;height:64px;margin:0;background:#2060e0;z-index:auto;',
    subject: 'position:fixed;left:48px;top:40px;width:128px;height:64px;margin:0;background:#e02030;z-index:auto;',
  };
  const positiveChild = {
    middle: 'position:relative;',
    branch: 'position:relative;',
    subject: 'position:absolute;left:16px;top:16px;z-index:1;',
  };
  const effectCompetition = { peer: 'z-index:9;', subject: 'z-index:1;' };
  const clip = {
    middle: 'position:relative;width:96px;height:48px;overflow:hidden;background:#e8eef6;',
    branch: 'margin-top:-48px;',
  };
  const containedAbsolute = { ...clip, subject: 'position:absolute;left:16px;top:16px;' };
  const capturedFixed = {
    ...clip,
    middle: `${clip.middle}transform:translate(0px,0px);`,
    subject: 'left:16px;top:16px;',
  };
  const cases = {
    'root-fixed-auto': {},
    'root-effect-fixed-auto': { root: 'clip-path:inset(0);' },
    'positioned-branches-auto': { middle: 'position:relative;', branch: 'position:relative;' },
    'auto-branch-positive-child': positiveChild,
    'zero-branch-positive-child': { ...positiveChild, middle: 'position:relative;z-index:0;' },
    'static-opacity-branch': { ...effectCompetition, branch: 'opacity:0.5;' },
    'static-transform-branch': { ...effectCompetition, branch: 'transform:translate(0px,0px);' },
    'static-effect-removed': effectCompetition,
    'relative-auto-clip': { ...clip, subject: 'position:relative;left:16px;top:16px;' },
    'absolute-contained-clip': containedAbsolute,
    'absolute-escape-clip': { ...containedAbsolute, middle: `${clip.middle}position:static;` },
    'fixed-escape-clip': clip,
    'fixed-transform-clip': capturedFixed,
    'absolute-clip-removed': { ...containedAbsolute, middle: `${clip.middle}overflow:visible;` },
    'absolute-clip-restored': containedAbsolute,
    'root-fixed-restored': {},
  };

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown auto paint case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
    },
  };
})();
