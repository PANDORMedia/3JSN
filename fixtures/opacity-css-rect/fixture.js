(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'underlay', 'subject']
      .map(id => [id, document.getElementById(id)]),
  );
  const polygon = 'polygon(nonzero,-16px -8px,256px 0px,248px 176px,-8px 168px)';
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'position:relative;margin:0;border:0;padding:0;width:448px;height:256px;background:white;',
    outer: 'position:absolute;left:48px;top:40px;width:240px;height:160px;margin:0;border:0;padding:0;background:transparent;',
    middle: 'position:absolute;left:0;top:0;width:240px;height:160px;margin:0;border:0;padding:0;background:transparent;transform:translate(0.375px,0.25px);clip:rect(16px,208px,136px,24px);clip-path:none;opacity:1;',
    underlay: 'position:absolute;left:-16px;top:-16px;width:272px;height:192px;margin:0;border:0;padding:0;background:#2060e0;z-index:auto;visibility:hidden;',
    subject: 'position:absolute;left:-16px;top:-16px;width:272px;height:192px;margin:0;border:0;padding:0;background:#e02030;z-index:auto;',
  };
  const families = {
    'rect-alpha-one': '',
    'rect-opacity-half': 'opacity:0.5;',
    'polygon-rect-alpha-one': `clip-path:${polygon};`,
    'polygon-rect-opacity-half': `clip-path:${polygon};opacity:0.5;`,
  };
  const cases = Object.fromEntries(Object.entries(families).flatMap(([name, middle]) => [
    [`${name}-single`, { middle }],
    [`${name}-covered-blue`, { middle, underlay: 'visibility:visible;' }],
  ]));
  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown CSS rect boundary case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
    },
  };
})();
