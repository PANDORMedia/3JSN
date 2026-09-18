(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'carrier', 'subject'].map(id => [id, document.getElementById(id)]),
  );
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'position:relative;margin:0;border:0;padding:0;width:448px;height:256px;background:white;',
    outer: 'position:absolute;left:32px;top:24px;width:320px;height:176px;margin:0;border:0;padding:0;background:transparent;',
    middle: 'position:relative;left:0;top:0;width:160px;height:112px;margin:0;border:0;padding:0;background:#2060e0;z-index:0;',
    carrier: 'position:static;width:80px;height:64px;margin:0;border:0;padding:0;background:#20a060;',
    subject: 'position:absolute;left:16px;top:16px;width:128px;height:64px;margin:0;border:0;padding:0;background:#e02030;z-index:-1;',
  };
  const opacity = {
    outer: 'width:128px;height:80px;overflow:hidden;background:white;',
    middle: 'position:static;opacity:0.5;',
    carrier: 'width:160px;height:112px;background:transparent;',
    subject: 'position:fixed;left:128px;top:72px;z-index:2;',
  };
  const outsideOwner = {
    middle: 'position:absolute;left:600px;top:400px;opacity:0.5;',
    carrier: 'background:transparent;',
    subject: 'position:fixed;left:128px;top:72px;z-index:2;',
  };
  const offsetRoot = {
    root: 'position:relative;left:8px;top:6px;margin:12px;border:6px solid #333333;padding:10px;width:300px;height:144px;',
    subject: 'position:fixed;left:64px;top:40px;z-index:2;',
    middle: 'background:transparent;',
    carrier: 'background:transparent;',
  };
  const cases = {
    'negative-before-inflow': {},
    'zero-after-inflow': { subject: 'z-index:0;' },
    'negative-restored': {},
    'hidden-ancestor-visible-child': {
      middle: 'visibility:hidden;',
      subject: 'visibility:visible;z-index:2;',
    },
    'visibility-restored': {},
    'opacity-fixed-escape': opacity,
    'opacity-relative-clipped': {
      ...opacity,
      subject: 'position:relative;left:96px;top:48px;z-index:2;',
    },
    'opacity-fixed-restored': opacity,
    'opacity-owner-offscreen': outsideOwner,
    'opacity-owner-zero-size': {
      ...outsideOwner,
      middle: 'position:absolute;left:0;top:0;width:0;height:0;opacity:0.5;',
    },
    'opacity-owner-restored': opacity,
    'nested-opacity-fixed': {
      ...opacity,
      carrier: 'width:160px;height:112px;background:transparent;opacity:0.5;',
    },
    'offset-root-fixed': offsetRoot,
    'transformed-fixed': {
      middle: 'transform:translate(20px,12px) scale(1.5);transform-origin:0 0;',
      carrier: 'background:transparent;',
      subject: 'position:fixed;left:16px;top:16px;z-index:2;',
    },
    'all-styles-restored': {},
  };

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown ownership renderer case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
    },
  };
})();
