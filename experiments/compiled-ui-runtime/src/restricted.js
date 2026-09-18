import 'ext:dom_canvas/canvas.js';

function unsupported(operation) {
  throw new DOMException(`${operation} is unavailable in this restricted artifact: dynamic HTML parsing is disabled.`, 'NotSupportedError');
}

// These setters/methods must fail explicitly instead of becoming inert expando
// properties. innerHTML and iframe creation also reject in the native DOM ops.
Object.defineProperty(Element.prototype, 'outerHTML', {
  configurable: true, set() { unsupported('outerHTML'); },
});
for (const name of ['insertAdjacentHTML', 'setHTML', 'setHTMLUnsafe']) {
  Object.defineProperty(Element.prototype, name, {
    configurable: true, writable: true, value() { unsupported(name); },
  });
}
for (const name of ['write', 'writeln', 'open']) {
  Object.defineProperty(Document.prototype, name, {
    configurable: true, writable: true, value() { unsupported(`document.${name}`); },
  });
}
class DOMParser {
  parseFromString() { unsupported('DOMParser.parseFromString'); }
}
class Range {
  createContextualFragment() { unsupported('Range.createContextualFragment'); }
}
Object.assign(globalThis, { DOMParser, Range });
Object.defineProperty(Document.prototype, 'createRange', {
  configurable: true, writable: true, value() { return new Range(); },
});
for (const name of ['parseHTML', 'parseHTMLUnsafe']) {
  Object.defineProperty(Document, name, {
    configurable: true, writable: true, value() { unsupported(`Document.${name}`); },
  });
}
for (const target of [globalThis, Document.prototype]) {
  Object.defineProperty(target, 'location', {
    configurable: true,
    get() { unsupported('document navigation'); },
    set() { unsupported('document navigation'); },
  });
}
