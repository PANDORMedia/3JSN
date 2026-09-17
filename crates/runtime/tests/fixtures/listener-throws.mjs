const target = new EventTarget();
target.addEventListener('action', () => { throw new Error('unhandled listener failure'); });
target.dispatchEvent(new Event('action'));
