(() => {
  const stable = document.getElementById('stable');
  const original = document.getElementById('child');
  const status = document.getElementById('status');
  let clicks = 0;
  document.getElementById('advance').addEventListener('click', () => {
    clicks++; status.textContent = `Advanced ${clicks}`; status.classList.add('active');
  });
  function check(condition, message) { if (!condition) throw new Error(message); }
  function snapshot() {
    return { clicks, samples: [...document.querySelectorAll('[data-probe]')].map(node => {
      const rect = node.getBoundingClientRect();
      return { key: node.getAttribute('data-probe'), text: node.textContent, rect: [rect.x, rect.y, rect.width, rect.height] };
    }) };
  }
  function mutate() {
    document.getElementById('advance').click();
    const child = document.createElement('strong');
    child.textContent = 'Created live'; child.id = 'created';
    stable.appendChild(child); stable.style.paddingLeft = '19px';
    check(document.getElementById('created') === child, 'Created node identity changed');
    stable.removeChild(child);
    check(child.textContent === 'Created live' && child.parentNode === null, 'Detached wrapper changed');
    stable.appendChild(child);
    check(document.getElementById('child') === original, 'Existing child identity changed');
    return snapshot();
  }
  function verify(dynamicHtml) {
    const positive = mutate();
    if (dynamicHtml) {
      stable.innerHTML = '<span id="parsed">Dynamic markup</span>';
      check(document.getElementById('parsed').textContent === 'Dynamic markup', 'Parser-enabled path failed');
      check(original.textContent === 'Original child' && original.parentNode === null, 'Replaced wrapper invalidated');
      return { positive, dynamicMarkup: true };
    }
    const rejected = [];
    const operations = {
      innerHTML: () => { stable.innerHTML = '<b>Must not replace children</b>'; },
      emptyInnerHTML: () => { stable.innerHTML = ''; },
      bodyInnerHTML: () => { document.body.innerHTML = '<p>Must not replace document contents</p>'; },
      iframe: () => document.createElement('IFRAME'),
      outerHTML: () => { stable.outerHTML = '<p>Replacement</p>'; },
      insertAdjacentHTML: () => stable.insertAdjacentHTML('afterend', '<p>Insertion</p>'),
      setHTML: () => stable.setHTML('<p>Replacement</p>'),
      setHTMLUnsafe: () => stable.setHTMLUnsafe('<p>Replacement</p>'),
      DOMParser: () => new DOMParser().parseFromString('<p>Parsed</p>', 'text/html'),
      contextualFragment: () => document.createRange().createContextualFragment('<p>Fragment</p>'),
      documentWrite: () => document.write('<p>Document</p>'),
      documentWriteln: () => document.writeln('<p>Document</p>'),
      documentOpen: () => document.open(),
      documentParse: () => Document.parseHTML('<p>Document</p>'),
      documentParseUnsafe: () => Document.parseHTMLUnsafe('<p>Document</p>'),
      navigation: () => { globalThis.location = 'https://fixture.invalid/'; },
      documentNavigation: () => { document.location = 'https://fixture.invalid/'; },
    };
    for (const [operation, apply] of Object.entries(operations)) {
      const before = JSON.stringify(snapshot());
      let caught;
      try { apply(); } catch (error) { caught = error; }
      check(caught && /HTML pars|restricted artifact/i.test(caught.message), `${operation} did not reject explicitly`);
      check(JSON.stringify(snapshot()) === before, `${operation} mutated the live tree before rejection`);
      check(document.getElementById('child') === original && original.parentNode === stable, `${operation} detached retained children`);
      rejected.push({ operation, name: caught.name, message: caught.message });
    }
    check(!Object.hasOwn(stable, 'outerHTML'), 'outerHTML became a silent expando');
    return { positive, rejected, treePreserved: true };
  }
  globalThis.uiProbe = { snapshot, mutate, verify };
})();
