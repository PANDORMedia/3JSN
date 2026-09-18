(() => {
  const nodes = Object.fromEntries(
    ['outer', 'bridge', 'middle', 'spacer', 'subject'].map(id => [id, document.getElementById(id)]),
  );
  const base = {
    outer: 'position:absolute;left:32px;top:24px;width:320px;height:176px;background:#dddddd;',
    bridge: 'position:static;box-sizing:border-box;width:100%;height:100%;padding:16px 24px;',
    middle: 'position:static;width:120px;height:80px;background:#bbccee;',
    spacer: 'display:none;width:8px;height:28px;background:#667788;',
    subject: 'position:absolute;left:150px;top:100px;width:50%;height:32px;background:#e02030;',
  };
  const shortDocument = {
    outer: 'position:static;width:100%;height:60px;',
    bridge: 'padding:0;',
    middle: 'width:100%;height:60px;',
  };
  const viewportFixed = {
    middle: 'position:relative;',
    subject: 'position:fixed;left:288px;top:184px;width:96px;height:40px;',
  };
  const cases = {
    'short-root-absolute-bottom': {
      ...shortDocument,
      subject: 'left:24px;top:auto;bottom:0;width:96px;height:24px;',
    },
    'short-root-fixed-stretch': {
      ...shortDocument,
      subject: 'position:fixed;left:auto;right:24px;top:16px;bottom:16px;width:48px;height:auto;',
    },
    'absolute-percent-escape': {},
    'block-auto-anchor': {
      spacer: 'display:block;',
      subject: 'left:auto;top:auto;height:24px;',
    },
    'flex-auto-anchor': {
      middle: 'display:flex;width:200px;height:112px;justify-content:flex-end;align-items:center;',
      subject: 'left:auto;top:auto;height:24px;',
    },
    'grid-static-anchor': {
      middle: 'display:grid;width:200px;height:120px;grid-template-columns:60px 100px;grid-template-rows:32px 64px;gap:8px;justify-items:center;align-items:end;',
      subject: 'left:auto;top:auto;height:24px;grid-column:2;grid-row:2;',
    },
    'grid-owner-area': {
      outer: 'display:grid;grid-template-columns:96px 192px;grid-template-rows:64px 88px;gap:16px;',
      subject: 'left:0;top:0;grid-column:2;grid-row:2;',
    },
    'viewport-fixed': viewportFixed,
    'transformed-fixed': {
      middle: 'transform:translate(20px,12px);',
      subject: 'position:fixed;left:48px;top:40px;height:32px;',
    },
    'viewport-fixed-restored': viewportFixed,
    'relative-descendant-escape': {
      bridge: 'width:160px;height:112px;overflow:hidden;',
      middle: 'position:absolute;left:176px;top:120px;width:120px;height:72px;',
      subject: 'position:relative;left:16px;top:12px;width:64px;height:32px;',
    },
    'absolute-percent-restored': {},
  };

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown positioned layout case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
    },
  };
})();
