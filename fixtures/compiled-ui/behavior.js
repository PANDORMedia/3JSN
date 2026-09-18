(() => {
  let clicks = 0;
  const action = document.getElementById('action');
  if (action) action.addEventListener('click', () => {
    clicks++;
    document.getElementById('status').textContent = `Advanced ${clicks} · café`;
    document.getElementById('card').className = 'card changed';
  });
  function snapshot() {
    return {
      clicks,
      samples: Array.from(document.querySelectorAll('[data-probe]'), node => {
        const rect = node.getBoundingClientRect();
        return { key: node.getAttribute('data-probe'), text: node.textContent,
          rect: [rect.x, rect.y, rect.width, rect.height] };
      }),
      templates: document.querySelectorAll('template').length,
      inertContentQueryable: document.getElementById('inert') !== null,
      foreignContent: document.querySelectorAll('svg foreignObject div').length,
    };
  }
  function mutate() {
    if (action) action.click();
    const target = document.getElementById('mutate-target');
    const retained = target;
    const child = document.createElement('strong');
    child.setAttribute('data-probe', 'created');
    child.textContent = 'Created with DOM operations';
    target.appendChild(child);
    target.style.paddingLeft = '7px';
    const created = snapshot();
    target.removeChild(child);
    target.innerHTML = '<span data-probe="parsed">Runtime <b>markup</b> remains supported.</span>';
    return { sameTarget: retained === document.getElementById('mutate-target'), created, parsed: snapshot() };
  }
  globalThis.uiFixture = { snapshot, mutate };
})();
