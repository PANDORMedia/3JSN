// Checkpoints between callbacks let microtasks cancel later callbacks in the
// same frame. Callbacks added during dispatch wait for the next native redraw.
export function createAnimationFrames({ now, checkpoint, reportError, setPending }) {
  const callbacks = new Map();
  let nextId = 1;
  return {
    request(callback) {
      if (typeof callback !== "function") throw new TypeError("Animation callback must be a function");
      const id = nextId++;
      callbacks.set(id, callback);
      setPending(true);
      return id;
    },
    cancel(id) {
      callbacks.delete(Number(id));
      setPending(callbacks.size > 0);
    },
    dispatch() {
      const timestamp = now();
      const ids = [...callbacks.keys()];
      for (const id of ids) {
        const callback = callbacks.get(id);
        if (!callback) continue;
        callbacks.delete(id);
        try { callback.call(globalThis, timestamp); }
        catch (error) { reportError(error); }
        checkpoint();
      }
      setPending(callbacks.size > 0);
    },
  };
}
