(() => {
  const root = document.getElementById('root');
  const button = document.getElementById('button');
  root.style.backgroundColor = 'rgb(32, 160, 96)';
  button.textContent = 'Native UI';
  if (root.getBoundingClientRect().width !== 240 || button.textContent !== 'Native UI') {
    throw new Error('Paint mutation did not reach the authoritative DOM.');
  }
})();
