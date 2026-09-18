(() => {
  const fields = ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'];
  globalThis.domGeometry = {
    run() {
      const checks = [];
      const outer = document.getElementById('outer');
      const middle = document.getElementById('middle');
      const subject = document.getElementById('subject');
      const leaf = document.getElementById('leaf');
      function reset() {
        outer.setAttribute('style', 'position:relative;left:32px;top:24px;width:240px;height:176px;');
        middle.setAttribute('style', 'position:relative;left:24px;top:16px;width:160px;height:128px;');
        subject.setAttribute('style', 'position:absolute;left:120px;top:80px;width:100px;height:90px;');
        leaf.setAttribute('style', 'position:fixed;left:10px;top:12px;width:20px;height:18px;');
      }
      function rectangle(name, element, [x, y, width, height]) {
        const expected = { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x };
        try {
          const rect = element.getBoundingClientRect();
          const observed = Object.fromEntries(fields.map(field => [field, rect[field]]));
          checks.push({ name, passed: fields.every(field => Number.isFinite(observed[field]) && Math.abs(observed[field] - expected[field]) < 0.01), observed, expected });
        } catch (error) {
          checks.push({ name, passed: false, observed: { error: String(error) }, expected });
        }
      }
      const zero = (name, element) => rectangle(name, element, [0, 0, 0, 0]);
      const original = [176, 120, 100, 90];
      reset();
      rectangle('visible box', subject, original);
      subject.style.display = 'none';
      zero('self display none', subject);
      zero('fixed descendant under hidden parent', leaf);
      subject.style.display = 'block';
      rectangle('restore own display', subject, original);
      middle.style.display = 'none';
      zero('absolute descendant under hidden ancestor', subject);
      zero('fixed descendant under hidden grandparent', leaf);
      middle.style.display = 'block';
      rectangle('restore ancestor display', subject, original);
      middle.style.display = 'contents';
      zero('own display contents', middle);
      rectangle('boxed child of display contents', subject, [152, 104, 100, 90]);
      outer.style.display = 'contents';
      zero('nested contents outer', outer);
      zero('nested contents middle', middle);
      rectangle('boxed child of nested contents', subject, [120, 80, 100, 90]);
      reset();
      subject.style.visibility = 'hidden';
      rectangle('visibility hidden keeps geometry', subject, original);
      subject.style.visibility = 'visible';
      subject.style.opacity = '0';
      rectangle('zero opacity keeps geometry', subject, original);
      subject.style.opacity = '1';
      middle.style.overflow = 'hidden';
      rectangle('overflow clipping keeps geometry', subject, original);
      subject.style.left = '-500px';
      rectangle('offscreen box keeps geometry', subject, [-444, 120, 100, 90]);
      reset();
      subject.style.width = '0px';
      rectangle('zero width preserves origin', subject, [176, 120, 0, 90]);
      subject.style.height = '0px';
      rectangle('zero area preserves origin', subject, [176, 120, 0, 0]);
      reset();
      middle.removeChild(subject);
      zero('detached retained element', subject);
      zero('descendant of detached subtree', leaf);
      middle.appendChild(subject);
      rectangle('reattachment restores geometry', subject, original);
      checks.push({ name: 'reattachment preserves wrapper identity', passed: document.getElementById('subject') === subject, observed: document.getElementById('subject') === subject });
      const fresh = document.createElement('div');
      fresh.setAttribute('style', 'position:fixed;left:11px;top:7px;width:50px;height:40px;');
      zero('never attached element', fresh);
      return { fixture: 'dom-geometry', status: checks.every(check => check.passed) ? 'passed' : 'failed', checks };
    },
  };
})();
