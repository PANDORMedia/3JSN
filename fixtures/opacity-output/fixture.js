(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'effect', 'ordinary', 'underlay', 'subject', 'later']
      .map(id => [id, document.getElementById(id)]),
  );
  const polygon = 'polygon(nonzero,17.25px 11.375px,224.625px 18.25px,217.375px 143.625px,13.125px 134.25px)';
  const inset = 'inset(9.375px 13.625px 11.25px 17.125px)';
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'position:relative;margin:0;border:0;padding:0;width:448px;height:256px;background:white;',
    outer: 'position:absolute;left:48px;top:40px;width:240px;height:160px;margin:0;border:0;padding:0;background:transparent;',
    middle: 'position:relative;left:0;top:0;width:240px;height:160px;margin:0;border:0;padding:0;background:transparent;opacity:0.5;',
    effect: 'position:static;width:auto;height:160px;margin:0;border:0;padding:0;background:transparent;',
    ordinary: 'display:none;position:absolute;left:-16px;top:-16px;width:176px;height:136px;margin:0;border:0;padding:0;background:#e02030;',
    underlay: 'position:absolute;left:-16px;top:-16px;width:272px;height:192px;margin:0;border:0;padding:0;background:#2060e0;z-index:auto;visibility:hidden;',
    subject: 'position:absolute;left:-16px;top:-16px;width:272px;height:192px;margin:0;border:0;padding:0;background:#e02030;z-index:auto;',
    later: 'position:absolute;left:408px;top:224px;width:4px;height:4px;margin:0;border:0;padding:0;background:#f09098;',
  };
  const ownInset = { middle: `clip-path:${inset};` };
  const ancestorInset = { outer: `clip-path:${inset};` };
  const ownRounded = {
    middle: 'left:0.375px;top:0.25px;overflow:hidden;border-radius:31.375px / 27.625px;',
  };
  const nestedPrefix = {
    outer: `opacity:0.5;clip-path:${polygon};`,
    middle: `left:18.375px;top:8.25px;width:216px;height:144px;clip-path:${inset};`,
    later: 'background:#f7c7cb;',
  };
  const fixedFill = 'position:fixed;left:160px;top:16px;width:192px;height:224px;';
  const nestedEscape = {
    outer: `opacity:0.5;clip-path:${polygon};`,
    middle: 'left:24.375px;top:16.25px;width:144px;height:104px;overflow:hidden;border-radius:20.375px / 18.625px;opacity:1;',
    effect: 'height:104px;opacity:0.5;',
    ordinary: 'display:block;',
    underlay: fixedFill,
    subject: fixedFill,
    later: 'background:#f7c7cb;',
  };
  const signedEscape = {
    ...nestedEscape,
    underlay: `${fixedFill}z-index:-2;`,
    subject: `${fixedFill}z-index:2;`,
  };
  const covered = styles => ({ ...styles, underlay: `${styles.underlay ?? ''}visibility:visible;` });
  const cases = {
    'own-inset-single': ownInset,
    'own-inset-covered-blue': covered(ownInset),
    'ancestor-inset-single': ancestorInset,
    'ancestor-inset-covered-blue': covered(ancestorInset),
    'own-rounded-single': ownRounded,
    'own-rounded-covered-blue': covered(ownRounded),
    'nested-prefix-single': nestedPrefix,
    'nested-prefix-covered-blue': covered(nestedPrefix),
    'nested-escape-single': nestedEscape,
    'nested-escape-covered-blue': covered(nestedEscape),
    'signed-escape-single': signedEscape,
    'signed-escape-covered-blue': covered(signedEscape),
    'own-inset-restored': ownInset,
    'nested-escape-restored': nestedEscape,
  };

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown opacity output case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
    },
  };
})();
