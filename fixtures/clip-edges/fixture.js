(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'underlay', 'subject'].map(id => [id, document.getElementById(id)]),
  );
  const polygon = 'polygon(nonzero,17.25px 11.375px,224.625px 18.25px,217.375px 143.625px,13.125px 134.25px)';
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'position:relative;margin:0;border:0;padding:0;width:448px;height:256px;background:white;',
    outer: 'position:absolute;left:48px;top:40px;width:256px;height:176px;margin:0;border:0;padding:0;background:transparent;',
    middle: `position:relative;left:0;top:0;width:240px;height:160px;margin:0;border:0;padding:0;background:transparent;clip-path:${polygon};`,
    underlay: 'position:absolute;left:-16px;top:-16px;width:272px;height:192px;margin:0;border:0;padding:0;background:#e02030;z-index:auto;visibility:hidden;',
    subject: 'position:absolute;left:-16px;top:-16px;width:272px;height:192px;margin:0;border:0;padding:0;background:#e02030;z-index:auto;',
  };
  const duplicate = 'visibility:visible;';
  const coveredBlue = 'visibility:visible;background:#2060e0;';
  const rounded = 'left:0.375px;top:0.25px;clip-path:none;overflow:hidden;border-radius:31.375px / 27.625px;';
  const inset = 'clip-path:inset(9.375px 13.625px 11.25px 17.125px);';
  const nested = 'clip-path:polygon(nonzero,37.125px 0.25px,248.75px 26.5px,180.375px 166.25px,0.5px 94.125px);';
  const roundedGroup = {
    outer: 'left:48.375px;top:40.25px;width:240px;height:160px;overflow:hidden;border-radius:31.375px / 27.625px;',
    middle: 'clip-path:none;opacity:0.5;',
  };
  const cases = {
    'polygon-single': {},
    'polygon-duplicate-red': { underlay: duplicate },
    'polygon-covered-blue': { underlay: coveredBlue },
    'rounded-single': { middle: rounded },
    'rounded-duplicate-red': { middle: rounded, underlay: duplicate },
    'inset-single': { middle: inset },
    'inset-covered-blue': { middle: inset, underlay: coveredBlue },
    'opacity-single': { middle: 'opacity:0.5;' },
    'opacity-covered-blue': { middle: 'opacity:0.5;', underlay: coveredBlue },
    'nested-single': { outer: nested },
    'nested-covered-blue': { outer: nested, underlay: coveredBlue },
    'rounded-opacity-single': roundedGroup,
    'rounded-opacity-covered-blue': { ...roundedGroup, underlay: coveredBlue },
    'polygon-restored': {},
    'opacity-restored': { middle: 'opacity:0.5;' },
  };

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown clip edge case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
    },
  };
})();
