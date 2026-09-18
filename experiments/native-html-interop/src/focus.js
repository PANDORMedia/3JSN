// Native document state owns focus; this controller only sequences JS callbacks
// after each native operation has released its document borrow.
export function createFocusController({ read, mutate, idOf, wrap, document, emit }) {
  let revision = 0;
  let fixupPending = false;
  const scheduleTask = setTimeout;
  const focused = () => wrap(read({ kind: 'focused' }));
  const eligible = target => read({ kind: 'focusability', id: idOf(target) }).programmatic;

  function change(target) {
    if (target !== null && !eligible(target)) return;
    const previous = focused();
    if (previous === target) return;
    const currentRevision = ++revision;
    mutate({ kind: 'focus', id: null });
    if (previous !== null) {
      emit(previous, 'blur', target, false);
      emit(previous, 'focusout', currentRevision === revision ? target : null, true);
    }
    // An event handler may focus another node, including focusing then blurring
    // back to the viewport. Its completed transition supersedes this one.
    if (currentRevision !== revision || target === null || !eligible(target)) return;
    mutate({ kind: 'focus', id: idOf(target) });
    if (focused() !== target) return;
    emit(target, 'focus', previous, false);
    if (currentRevision === revision && focused() === target) {
      emit(target, 'focusin', previous, true);
    }
    scheduleFixup();
  }

  function fixup() {
    const target = focused();
    if (target && !eligible(target)) change(null);
  }

  function scheduleFixup() {
    if (fixupPending || !focused()) return;
    fixupPending = true;
    scheduleTask(() => { fixupPending = false; fixup(); }, 0);
  }

  function update(request) {
    if (['append', 'insert', 'remove', 'text', 'html'].includes(request.kind) && focused()) {
      const removed = wrap(read({ kind: 'focusRemoval', mutation: request }));
      if (removed) change(null);
    }
    const result = mutate(request);
    if (request.kind === 'attribute' && request.name.toLowerCase() === 'hidden') fixup();
    // Tree/text mutations can change selectors or stylesheet text too. Preserve
    // synchronous and microtask observations, then resolve eligibility once.
    scheduleFixup();
    return result;
  }

  return {
    mutate: update,
    activeElement() { return focused() ?? document().body ?? document().documentElement; },
    focus(target) { change(target); },
    blur(target) { if (focused() === target) change(null); },
    pointer(target) {
      while (target && target.nodeType !== 9) {
        if (target.nodeType === 1 && eligible(target)) { change(target); return; }
        target = target.parentNode;
      }
      change(null);
    },
    navigate(backward) {
      const target = wrap(read({ kind: 'focusNext', backward: Boolean(backward) }));
      if (target) change(target);
    },
  };
}
