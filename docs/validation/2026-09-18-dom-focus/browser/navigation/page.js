(() => {
  const events = [];
  const listeners = [];
  let recording = true;
  const label = node => node ? node.id || node.nodeName.toLowerCase() : null;
  const snapshot = () => ({ activeElement: label(document.activeElement),
    focus: label(document.querySelector(':focus')), hasFocus: document.hasFocus() });
  const listen = (target, type, callback, capture = false) => {
    target.addEventListener(type, callback, capture);
    listeners.push(() => target.removeEventListener(type, callback, capture));
  };
  for (const type of ['focus', 'blur', 'focusin', 'focusout', 'keydown', 'keyup', 'mousedown', 'mouseup', 'click']) {
    listen(document, type, event => {
      if (recording) events.push({ type, target: label(event.target), relatedTarget: label(event.relatedTarget),
        isTrusted: event.isTrusted, key: event.key ?? null, shiftKey: event.shiftKey ?? null,
        defaultPrevented: event.defaultPrevented, targetConnected: event.target.isConnected,
        ...snapshot() });
    }, true);
  }
  globalThis.navigationProbe = {
    snapshot,
    tree: () => [...document.querySelectorAll('#tree [id]')].map(node => ({ id: node.id,
      tag: node.localName, tabIndex: node.tabIndex, disabled: node.disabled ?? null,
      inert: node.inert, ancestorInert: Boolean(node.closest('[inert]')) })),
    focus(id) { document.getElementById(id).focus({ preventScroll: true }); return snapshot(); },
    events: () => structuredClone(events),
    clearEvents() { events.length = 0; },
    mouseControl(mode) {
      const target = document.getElementById('natural-b');
      if (mode === 'cancel') listen(target, 'mousedown', event => event.preventDefault());
      if (mode === 'remove' || mode === 'disable') listen(target, 'mousedown', () => {
        events.push({ type: 'handler-before', mode, ...snapshot(), targetConnected: target.isConnected });
        if (mode === 'remove') target.parentNode.removeChild(target);
        else target.disabled = true;
        events.push({ type: 'handler-after', mode, ...snapshot(), targetConnected: target.isConnected });
      });
    },
    point(id) {
      const { x, y, width, height } = document.getElementById(id).getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    },
    dispose() {
      const eventCount = events.length;
      recording = false;
      for (const remove of listeners) remove();
      const tree = document.getElementById('tree');
      tree.parentNode.removeChild(tree);
      return { eventsBefore: eventCount, eventsAfter: events.length, detached: !tree.isConnected };
    },
  };
})();
