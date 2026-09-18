(() => {
  const root = document.getElementById('root');
  const body = document.getElementById('body');
  const outer = document.getElementById('outer');
  const middle = document.getElementById('middle');
  const subject = document.getElementById('subject');
  root.setAttribute('style', 'margin:0;background:white;');
  body.setAttribute('style', 'margin:0;width:448px;height:256px;background:white;');
  outer.setAttribute('style', 'position:relative;width:448px;height:256px;');
  middle.setAttribute('style', 'position:absolute;left:220px;top:120px;width:128px;height:64px;opacity:.5;');
  subject.setAttribute('style', 'width:128px;height:64px;background:#e02030;');
  const cells = [];
  globalThis.clipFixture = { prepare(name) {
    const count = ({'small': 8, 'wide': 1100})[name];
    if (count === undefined) throw new Error(`Unknown layer-budget case: ${name}`);
    for (const cell of cells) outer.removeChild(cell);
    cells.length = 0;
    for (let i = 0; i < count; i++) {
      const cell = document.createElement('div');
      cell.setAttribute('style', `position:absolute;left:${4+(i%40)*3}px;top:${4+Math.floor(i/40)*3}px;width:2px;height:2px;opacity:.5;background:#2060e0;`);
      outer.appendChild(cell);
      cells.push(cell);
    }
    outer.appendChild(middle);
  }};
})();
