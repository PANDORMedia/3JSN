const ids = ['thin', 'middle', 'heavy', 'serif', 'italic', 'localized', 'restricted', 'roboto-a', 'serif-b', 'ordered', 'serif-ab'];

export function measure() {
  return Object.fromEntries(ids.map(id => {
    const element = document.getElementById(id);
    return [id, { text: element.textContent, width: element.getBoundingClientRect().width }];
  }));
}

export function localize() {
  document.getElementById('localized').textContent = 'Καλημέρα · Привет';
}
