(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'carrier', 'subject', 'peer'].map(id => [id, document.getElementById(id)]),
  );
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'position:relative;margin:0;padding:0;width:448px;height:256px;background:white;',
    outer: 'position:absolute;left:32px;top:24px;width:128px;height:80px;margin:0;border:0;padding:0;background:white;overflow:hidden;',
    middle: 'position:static;left:0;top:0;width:160px;height:112px;margin:0;border:0;padding:0;background:#2060e0;z-index:auto;clip-path:inset(-80px);',
    carrier: 'position:static;width:160px;height:112px;margin:0;border:0;padding:0;background:transparent;',
    subject: 'position:fixed;left:128px;top:72px;width:128px;height:64px;margin:0;background:#e02030;z-index:2;',
    peer: 'display:none;',
  };
  const cases = {
    'clip-baseline': {},
    'opacity-baseline': { middle: 'clip-path:none;opacity:0.5;' },
    'no-effect': { middle: 'clip-path:none;' },
    'clip-expanded-2000': { middle: 'clip-path:inset(-2000px);' },
    'clip-on-fixed-subject': { middle: 'clip-path:none;', subject: 'clip-path:inset(-80px);' },
    'clip-on-overflow-ancestor': { middle: 'clip-path:none;', outer: 'clip-path:inset(-2000px);' },
    'clip-with-opacity': { middle: 'opacity:0.5;' },
    'clip-with-ancestor-overflow-visible': { outer: 'overflow:visible;' },
    'clip-with-own-overflow-only': { outer: 'overflow:visible;', middle: 'overflow:hidden;' },
    'css-rect-absolute-middle': { middle: 'position:absolute;clip-path:none;clip:rect(-80px,240px,192px,-80px);' },
    'clip-absolute-middle': { middle: 'position:absolute;' },
    'clip-fixed-middle': { middle: 'position:fixed;left:32px;top:24px;' },
    'clip-middle-escapes-static-ancestor': {
      outer: 'position:static;margin-left:32px;margin-top:24px;',
      middle: 'position:absolute;left:32px;top:24px;',
    },
    'clip-restored': {},
  };

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown effect clip routing case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
    },
  };
})();
