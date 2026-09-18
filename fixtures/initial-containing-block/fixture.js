(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'spacer', 'subject'].map(id => [id, document.getElementById(id)]),
  );
  const base = {
    root: 'position:static;left:auto;top:auto;margin:0;border:0;padding:0;width:auto;height:auto;transform:none;background:white;',
    body: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:transparent;',
    outer: 'position:static;left:auto;top:auto;width:320px;height:60px;background:#dddddd;',
    middle: 'position:static;left:auto;top:auto;box-sizing:border-box;margin-left:24px;padding-top:12px;width:200px;height:60px;background:#bbccee;',
    spacer: 'display:block;width:8px;height:24px;background:#667788;',
    subject: 'position:absolute;left:24px;right:auto;top:auto;bottom:0;width:96px;height:24px;background:#e02030;',
  };
  const rootBox = 'margin:12px;border:6px solid #333333;padding:10px;width:300px;height:144px;';
  const percentages = 'left:25%;top:25%;bottom:auto;width:25%;height:25%;';
  const fixedPercentages = `position:fixed;${percentages}`;
  const autoAnchor = 'left:auto;top:auto;bottom:auto;width:25%;height:24px;';
  const fixedAncestry = {
    outer: 'position:relative;left:8px;top:6px;',
    middle: 'position:relative;left:12px;top:10px;',
  };
  const relativeRootFixed = {
    ...fixedAncestry,
    root: `${rootBox}position:relative;left:8px;top:6px;`,
    subject: fixedPercentages,
  };
  const mergeOrder = {
    root: 'position:relative;',
    outer: 'height:160px;background:transparent;',
    middle: 'background:transparent;',
    spacer: 'position:absolute;left:72px;top:44px;width:80px;height:64px;background:#2060e0;',
    subject: 'position:fixed;left:48px;top:40px;bottom:auto;width:128px;height:64px;',
  };
  const cases = {
    'short-absolute-bottom': {},
    'tall-absolute-bottom': { outer: 'height:384px;' },
    'tall-fixed-stretch': {
      outer: 'height:384px;',
      subject: 'position:fixed;left:240px;top:16px;bottom:16px;width:48px;height:auto;',
    },
    'short-viewport-percent': { subject: percentages },
    'root-box-absolute-percent': { root: rootBox, subject: percentages },
    'root-box-fixed-percent': {
      ...fixedAncestry,
      root: rootBox,
      subject: fixedPercentages,
    },
    'relative-root-absolute': {
      root: `${rootBox}position:relative;left:8px;top:6px;`,
      subject: percentages,
    },
    'absolute-root-absolute': {
      root: `${rootBox}position:absolute;left:20px;top:16px;`,
      subject: percentages,
    },
    'relative-root-fixed': relativeRootFixed,
    'fixed-root-fixed': {
      ...fixedAncestry,
      root: `${rootBox}position:fixed;left:20px;top:16px;`,
      subject: fixedPercentages,
    },
    'transformed-root-fixed': {
      ...fixedAncestry,
      root: `${rootBox}transform:translate(12px,8px);`,
      subject: fixedPercentages,
    },
    'root-fixed-restored': relativeRootFixed,
    'viewport-absolute-restored': { subject: percentages },
    'short-auto-anchor': { subject: autoAnchor },
    'root-box-auto-anchor': { root: rootBox, subject: autoAnchor },
    'auto-anchor-restored': { subject: autoAnchor },
    'root-effect-fixed-auto-order': {
      root: 'clip-path:inset(0);',
      outer: 'height:160px;',
      spacer: 'position:relative;left:48px;top:32px;width:80px;height:64px;background:#2060e0;z-index:auto;',
      subject: 'position:fixed;left:48px;top:40px;bottom:auto;width:128px;height:64px;z-index:auto;',
    },
    'root-positive-z-merge-order': {
      ...mergeOrder,
      spacer: `${mergeOrder.spacer}z-index:1;`,
      subject: `${mergeOrder.subject}z-index:1;`,
    },
    'root-negative-z-merge-order': {
      ...mergeOrder,
      spacer: `${mergeOrder.spacer}z-index:-1;`,
      subject: `${mergeOrder.subject}z-index:-1;`,
    },
  };
  let spacerAfterSubject = false;

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown initial containing block case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
      const laterSpacer = name === 'root-effect-fixed-auto-order';
      if (laterSpacer !== spacerAfterSubject) {
        nodes.middle.appendChild(laterSpacer ? nodes.spacer : nodes.subject);
        spacerAfterSubject = laterSpacer;
      }
    },
  };
})();
