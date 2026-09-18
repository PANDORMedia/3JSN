// SPDX-License-Identifier: MIT
globalThis.runFocusStylesheetBehavior = async () => {
  const task = () => new Promise(resolve => setTimeout(resolve, 0));
  const active = () => document.activeElement?.id || document.activeElement?.nodeName.toLowerCase();
  const stage = document.createElement('div');
  const button = document.createElement('button');
  button.id = 'focus-stylesheet-target';
  button.textContent = 'Focus';
  stage.appendChild(button);
  document.body.appendChild(stage);
  const results = [];
  let style;
  try {
    for (const mode of ['append-stylesheet', 'replace-stylesheet-text', 'focus-hides-self']) {
      if (style?.parentNode) style.parentNode.removeChild(style);
      style = document.createElement('style');
      style.textContent = mode === 'focus-hides-self'
        ? '#focus-stylesheet-target:focus { display:none }'
        : '#focus-stylesheet-target { display:block }';
      if (mode !== 'append-stylesheet') stage.appendChild(style);
      if (mode !== 'focus-hides-self') button.focus();
      await task();
      if (mode === 'append-stylesheet') {
        style.textContent = '#focus-stylesheet-target { display:none }';
        stage.appendChild(style);
      } else if (mode === 'replace-stylesheet-text') {
        style.textContent = '#focus-stylesheet-target { display:none }';
      } else button.focus();
      const result = { mode, immediate: active() };
      await Promise.resolve();
      result.afterMicrotask = active();
      stage.getBoundingClientRect();
      result.afterLayout = active();
      await task();
      result.afterTask = active();
      result.focus = document.querySelector(':focus')?.id ?? null;
      results.push(result);
    }
    return results;
  } finally {
    if (stage.parentNode) stage.parentNode.removeChild(stage);
  }
};
