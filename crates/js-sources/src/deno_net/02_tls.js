(() => {
  function loadTlsKeyPair() {
    throw new TypeError("Native network fetch is unavailable; use packaged assets.");
  }

  return { loadTlsKeyPair };
})();
