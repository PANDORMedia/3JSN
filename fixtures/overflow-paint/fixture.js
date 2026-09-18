(() => {
  const outer = document.getElementById('outer');
  const middle = document.getElementById('middle');
  const subject = document.getElementById('subject');
  const base = {
    outer: 'position:absolute;left:32px;top:24px;width:240px;height:176px;background:#dddddd;overflow:visible;',
    middle: 'position:relative;left:24px;top:16px;width:160px;height:128px;background:#bbccee;overflow:visible;',
    subject: 'position:absolute;left:120px;top:80px;width:100px;height:90px;background:#e02030;z-index:2;',
  };
  const cases = {
    'visible': {},
    'one-clip': { middle: 'overflow:hidden;' },
    'negative-z': { outer: 'background:transparent;', middle: 'background:transparent;overflow:hidden;', subject: 'z-index:-1;' },
    'nested-clips': { outer: 'width:200px;height:140px;overflow:hidden;', middle: 'left:96px;top:64px;overflow:hidden;', subject: 'left:64px;top:48px;width:140px;height:100px;' },
    'rounded-padding': { middle: 'overflow:hidden;box-sizing:border-box;border:8px solid #333333;padding:12px;border-radius:28px;', subject: 'left:0;top:0;width:200px;height:170px;' },
    'relative-subject': { middle: 'overflow:hidden;', subject: 'position:relative;' },
    'transformed-clip': { middle: 'overflow:hidden;transform:rotate(12deg);transform-origin:0 0;' },
    'moved-clip': { outer: 'left:72px;top:40px;', middle: 'width:112px;height:88px;overflow:hidden;', subject: 'left:76px;top:44px;' },
    'resized-clip': { outer: 'left:16px;top:8px;', middle: 'width:200px;height:160px;overflow:hidden;', subject: 'left:148px;top:112px;' },
    'hidden': { middle: 'display:none;overflow:hidden;' },
    'visible-again': { middle: 'overflow:hidden;' },
    'reparented': { outer: 'width:160px;height:128px;overflow:hidden;', parent: 'outer' },
    'restored': { middle: 'overflow:hidden;' },
    'stacking-control': { middle: 'overflow:hidden;z-index:0;' },
    'stacking-demoted': { middle: 'overflow:hidden;' },
    'absolute-escape': { middle: 'position:static;overflow:hidden;', subject: 'left:150px;top:100px;width:50%;height:32px;' },
    'absolute-auto': { middle: 'position:static;overflow:hidden;', subject: 'left:auto;top:auto;width:50%;height:32px;' },
    'viewport-fixed': { middle: 'overflow:hidden;', subject: 'position:fixed;left:180px;top:160px;width:160px;height:48px;' },
    'transformed-fixed': { middle: 'overflow:hidden;transform:translate(20px, 12px);', subject: 'position:fixed;left:120px;top:80px;' },
  };

  globalThis.clipFixture = {
    prepare(name) {
      const value = cases[name];
      if (!value) throw new Error(`Unknown overflow paint case: ${name}`);
      // A body background would hide the negative-z subject before clipping is observable.
      document.body.style.background = name === 'negative-z' ? 'transparent' : 'white';
      outer.setAttribute('style', base.outer + (value.outer ?? ''));
      middle.setAttribute('style', base.middle + (value.middle ?? ''));
      subject.setAttribute('style', base.subject + (value.subject ?? ''));
      const parent = value.parent === 'outer' ? outer : middle;
      if (subject.parentNode !== parent) parent.appendChild(subject);
    },
  };
})();
