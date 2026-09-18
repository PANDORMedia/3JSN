// Focused public-API controls, independent of React. This is not a full DOM or
// CSSOM conformance suite: no fragments, namespaces, focus or observer delivery.
// https://dom.spec.whatwg.org/#concept-node-pre-insert
// https://webidl.spec.whatwg.org/#legacy-platform-object-abstract-ops
// https://drafts.csswg.org/cssom/#the-cssstyledeclaration-interface
export function runDomContract() {
  function check(condition, message) {
    if (!condition) throw new Error(`DOM contract: ${message}`);
  }
  const sameNodes = (actual, expected) => actual.length === expected.length && expected.every((node, index) => actual[index] === node);
  const names = nodes => [...nodes].map(node => node.nodeName);
  function descriptor(collection, key, node, enumerable) {
    const value = Object.getOwnPropertyDescriptor(collection, key);
    check(value?.value === node && value.enumerable === enumerable && value.writable === false
      && value.configurable === true, `collection descriptor for ${key}`);
    return { value: value.value.nodeName, enumerable: value.enumerable, writable: value.writable, configurable: value.configurable };
  }
  function collectionReflection(collection, expected, label) {
    const keys = Object.keys(collection);
    check(sameNodes(keys, expected.map((_, index) => String(index))), `${label} enumerable indexed keys`);
    for (let index = 0; index < expected.length; index++) check(index in collection, `${label} missing indexed in property`);
    check(!(expected.length in collection) && !('-1' in collection) && !('01' in collection), `${label} unsupported index exists`);
    check(Object.getOwnPropertyDescriptor(collection, String(expected.length)) === undefined, `${label} unsupported index descriptor`);
    const descriptors = expected.map((node, index) => descriptor(collection, String(index), node, true));
    const mapped = Array.prototype.map.call(collection, node => node);
    check(sameNodes(mapped, expected), `${label} generic Array.map skipped or changed nodes`);
    return { keys, descriptors, mapped: names(mapped) };
  }
  function rejects(name, operation, parents) {
    const before = parents.map(parent => ({ parent, children: [...parent.childNodes] }));
    let error;
    try { operation(); } catch (caught) { error = caught; }
    check(error instanceof DOMException && error.name === name, `expected ${name}, received ${error?.name ?? 'success'}`);
    for (const { parent, children } of before) {
      check(sameNodes(parent.childNodes, children), `${name} changed child order`);
      for (const child of children) check(child.parentNode === parent, `${name} detached a child`);
    }
    return error.name;
  }

  const container = document.createElement('div');
  const holder = document.createElement('div');
  const a = document.createElement('span');
  const b = document.createElement('strong');
  const text = document.createTextNode('alpha');
  const tail = document.createTextNode('tail');
  const outside = document.createElement('span');
  a.setAttribute('data-dom-contract', 'first');
  b.setAttribute('data-dom-contract', 'second');
  holder.appendChild(outside);
  const report = {};
  try {
    check(document.ownerDocument === null && document.nodeType === 9 && document.nodeName === '#document', 'document identity fields');
    check([container, holder, a, b, text, tail].every(node => node.ownerDocument === document), 'created node ownerDocument');
    check(text instanceof Node && text instanceof Text && !(text instanceof Element), 'Text interface inheritance');
    check(container instanceof Node && container instanceof Element && !(container instanceof Text), 'Element interface inheritance');
    check(text.nodeType === 3 && text.nodeName === '#text' && text.nodeValue === 'alpha', 'Text identity fields');
    check(container.nodeType === 1 && container.nodeName === 'DIV' && container.nodeValue === null, 'HTML element identity fields');
    container.nodeValue = 'ignored';
    check(container.nodeValue === null && container.textContent === '', 'element nodeValue setter must do nothing');

    const childNodes = container.childNodes, children = container.children;
    check(childNodes === container.childNodes && children === container.children, 'collections are not retained live objects');
    check(childNodes.length === 0 && children.length === 0, 'new element must be empty');
    collectionReflection(childNodes, [], 'empty childNodes');
    collectionReflection(children, [], 'empty children');
    for (const child of [text, a, tail, b]) check(container.appendChild(child) === child, 'appendChild return identity');
    check(sameNodes(childNodes, [text, a, tail, b]) && sameNodes(children, [a, b]), 'retained collections did not update or filter Text');
    check(childNodes.item(1) === a && childNodes.item(99) === null && children.item(1) === b && children.item(99) === null, 'collection item semantics');
    check(container.firstChild === text && container.lastChild === b && text.previousSibling === null
      && text.nextSibling === a && a.previousSibling === text && a.nextSibling === tail && b.nextSibling === null, 'first/last/sibling links');
    text.data = null;
    const nullData = text.data;
    check(nullData === '' && text.nodeValue === '' && text.textContent === '' && container.firstChild === text,
      'CharacterData.data null must become empty without replacing the node');
    text.data = undefined;
    const undefinedData = text.data;
    check(undefinedData === 'undefined' && text.nodeValue === 'undefined' && text.textContent === 'undefined'
      && container.firstChild === text, 'CharacterData.data undefined must become its string value');
    text.nodeValue = 'beta';
    check(text.textContent === 'beta' && container.firstChild === text, 'nodeValue must update the retained Text node');
    text.textContent = 'gamma';
    check(text.nodeValue === 'gamma' && text.childNodes.length === 0 && container.firstChild === text, 'textContent must update CharacterData in place');
    check(container.textContent === 'gammatail', 'element textContent concatenation');
    report.nodes = { document: [document.nodeType, document.nodeName, document.ownerDocument],
      element: [container.nodeType, container.nodeName, container.nodeValue],
      text: [text.nodeType, text.nodeName, text.nodeValue], textInheritance: true, textIdentity: true,
      characterData: { nullValue: nullData, undefinedValue: undefinedData } };
    report.collections = { initialChildNames: names(childNodes), initialElementNames: names(children), retainedIdentity: true, filtersText: true,
      initialReflection: { childNodes: collectionReflection(childNodes, [text, a, tail, b], 'childNodes'),
        children: collectionReflection(children, [a, b], 'children') } };

    check(container.insertBefore(b, a) === b && sameNodes(childNodes, [text, b, a, tail]), 'insertBefore must move an existing child');
    const moved = names(childNodes);
    check(container.insertBefore(a, a) === a && sameNodes(childNodes, [text, b, a, tail]), 'insertBefore self-reference must be a no-op');
    check(container.insertBefore(b, a) === b && sameNodes(childNodes, [text, b, a, tail]), 'insertBefore adjacent child must preserve order');
    check(container.insertBefore(text, null) === text && sameNodes(childNodes, [b, a, tail, text]), 'null reference must append/move');
    holder.appendChild(a);
    check(sameNodes(children, [b]) && sameNodes(childNodes, [b, tail, text]), 'live collections after cross-parent move');
    check(container.insertBefore(a, b) === a && sameNodes(children, [a, b]) && sameNodes(holder.childNodes, [outside]), 'insertBefore must detach from the previous parent');
    check(container.firstChild === a && container.lastChild === text && a.previousSibling === null && a.nextSibling === b
      && b.previousSibling === a && b.nextSibling === tail && tail.previousSibling === b && tail.nextSibling === text
      && text.previousSibling === tail && text.nextSibling === null, 'sibling links did not update after moves');
    const invalidReference = rejects('NotFoundError', () => container.insertBefore(b, outside), [container, holder]);
    const cycle = rejects('HierarchyRequestError', () => a.insertBefore(container, null), [container, a, holder]);
    const selfParent = rejects('HierarchyRequestError', () => container.insertBefore(container, null), [container, holder]);
    report.insertion = { moved, finalChildNames: names(childNodes), finalElementNames: names(children),
      selfNoop: true, adjacentNoop: true, nullAppends: true, crossParentIdentity: true, liveSiblingLinks: true,
      errors: { invalidReference, cycle, selfParent }, errorsPreserveTree: true };
    report.collections.movedReflection = {
      childNodes: collectionReflection(childNodes, [a, b, tail, text], 'moved childNodes'),
      children: collectionReflection(children, [a, b], 'moved children'),
    };

    a.setAttribute('id', 'contractFirst');
    a.setAttribute('name', 'contractShared');
    b.setAttribute('id', 'contractShared');
    b.setAttribute('name', 'contractSecond');
    check(children.contractFirst === a && children.contractSecond === b
      && children.namedItem('contractFirst') === a && children.namedItem('contractSecond') === b,
    'HTMLCollection unique id/name lookup');
    const collisionResult = node => node === a ? 'first' : node === b ? 'second'
      : node === null ? 'null' : node === undefined ? 'undefined' : 'other';
    // Chrome prioritizes ID over name for this mixed collision; the DOM standard
    // specifies first-in-tree-order. Preserve the difference for the harness.
    report.collections.namedCollision = { property: collisionResult(children.contractShared),
      namedItem: collisionResult(children.namedItem('contractShared')) };
    check('contractFirst' in children && 'contractSecond' in children && !('contractMissing' in children)
      && children.contractMissing === undefined && children.namedItem('contractMissing') === null
      && children.namedItem('') === null, 'HTMLCollection named presence/missing lookup');
    const namedDescriptors = [descriptor(children, 'contractFirst', a, false), descriptor(children, 'contractSecond', b, false)];
    check(sameNodes(Object.keys(children), ['0', '1']), 'HTMLCollection named properties must not be enumerable');
    b.setAttribute('id', 'contractFirst');
    check(children.contractFirst === a && children.namedItem('contractFirst') === a, 'duplicate IDs must use the first child');
    container.insertBefore(b, a);
    check(children.contractFirst === b && children.namedItem('contractFirst') === b, 'duplicate ID lookup must follow changed tree order');
    container.insertBefore(b, tail);
    check(children.contractFirst === a && children.namedItem('contractFirst') === a, 'duplicate ID lookup must follow restored tree order');
    b.setAttribute('id', 'contractShared');
    a.removeAttribute('name');
    check(children.contractShared === b && children.namedItem('contractShared') === b, 'named lookup did not update after attribute removal');
    container.removeChild(b);
    check(!('contractSecond' in children) && !('contractShared' in children) && children.contractSecond === undefined
      && children.namedItem('contractSecond') === null && Object.getOwnPropertyDescriptor(children, 'contractSecond') === undefined,
    'named lookup did not update after node removal');
    collectionReflection(children, [a], 'children after named removal');
    container.insertBefore(b, tail);
    check(children.contractSecond === b && children.namedItem('contractShared') === b, 'named lookup did not restore retained identity');
    a.removeAttribute('id');
    b.removeAttribute('id');
    b.removeAttribute('name');
    check(!('contractFirst' in children) && !('contractSecond' in children) && !('contractShared' in children)
      && children.namedItem('contractFirst') === null && children.namedItem('contractSecond') === null,
    'named properties survived removal of their attributes');
    report.collections.named = { descriptors: namedDescriptors, firstMatchInTreeOrder: true, sameKindCollision: 'duplicate-id', attributeRemoval: true,
      nodeRemoval: true, restoredIdentity: true, removed: true };

    report.unusualElements = ['constructor', '__proto__'].map(tag => {
      const element = document.createElement(tag);
      check(element instanceof HTMLElement && element instanceof Element && element instanceof Node
        && element.nodeName === tag.toUpperCase() && element.ownerDocument === document, `createElement(${tag}) interface/identity`);
      check(holder.appendChild(element) === element && holder.lastChild === element, `append ${tag} identity`);
      check(holder.removeChild(element) === element && element.parentNode === null && element.ownerDocument === document,
        `remove ${tag} identity`);
      return { tag, nodeName: element.nodeName, htmlElement: true, retainedIdentity: true };
    });

    const rootBefore = document.documentElement;
    const documentChildren = [...document.childNodes];
    const secondRoot = document.createElement('html');
    const documentText = rejects('HierarchyRequestError', () => document.appendChild(text), [document, container]);
    const documentElement = rejects('HierarchyRequestError', () => document.insertBefore(secondRoot, rootBefore), [document, container]);
    check(secondRoot.parentNode === null, 'rejected second root was attached');
    check(document.textContent === null, 'document textContent getter must return null');
    document.textContent = 'must not replace the document';
    check(document.textContent === null && document.documentElement === rootBefore
      && sameNodes(document.childNodes, documentChildren), 'document textContent setter must do nothing');
    const replacementRoot = document.createElement('section');
    const rootNextSibling = rootBefore.nextSibling;
    try {
      document.removeChild(rootBefore);
      check(document.documentElement === null && rootBefore.parentNode === null, 'documentElement must become null without a root');
      document.insertBefore(replacementRoot, rootNextSibling);
      check(document.documentElement === replacementRoot && replacementRoot.parentNode === document
        && replacementRoot.nodeName === 'SECTION', 'documentElement must return a direct non-html root');
    } finally {
      if (replacementRoot.parentNode === document) document.removeChild(replacementRoot);
      if (rootBefore.parentNode !== document) {
        document.insertBefore(rootBefore, rootNextSibling?.parentNode === document ? rootNextSibling : null);
      }
    }
    check(document.documentElement === rootBefore && sameNodes(document.childNodes, documentChildren)
      && replacementRoot.parentNode === null, 'root restoration must retain the original document tree');
    report.document = { textContent: null, setterNoop: true, nonHtmlRoot: 'SECTION', originalRootRestored: true,
      errors: { text: documentText, secondRoot: documentElement }, errorsPreserveTree: true };

    const style = container.style;
    style.setProperty('padding-left', '8px');
    style.setProperty('--tone', 'gold');
    check(container.style === style && style.paddingLeft === '8px' && style.getPropertyValue('--tone') === 'gold', 'ordinary/custom style properties');
    check(style.cssText === 'padding-left: 8px; --tone: gold;' && container.getAttribute('style') === style.cssText, 'canonical reflected cssText');
    const initialCss = style.cssText;
    style.setProperty('padding-left', 'not-a-length');
    style.setProperty('padding-left', '9px', 'invalid-priority');
    check(style.cssText === initialCss && container.getAttribute('style') === initialCss, 'invalid style value/priority must not mutate declarations');
    const removedOrdinary = style.removeProperty('padding-left');
    const removedCustom = style.removeProperty('--tone');
    check(removedOrdinary === '8px' && removedCustom === 'gold' && style.cssText === ''
      && style.paddingLeft === '' && style.getPropertyValue('--tone') === '', 'style removal values/state');
    style.setProperty('width', '9px', 'important');
    style.setProperty('width', '12px', null);
    check(style.width === '12px' && style.cssText === 'width: 12px;'
      && container.getAttribute('style') === style.cssText, 'null style priority must clear important and set the value');
    style.cssText = ' color : red ; width : 12px ; ';
    check(style.cssText === 'color: red; width: 12px;' && container.getAttribute('style') === style.cssText, 'cssText setter serialization/reflection');
    report.style = { initialCss, invalidNoop: true, removed: [removedOrdinary, removedCustom], nullPriorityClearsImportant: true,
      cssText: style.cssText, reflected: true };

    const untouchedStyle = outside.style;
    check(outside.getAttribute('style') === null && untouchedStyle.removeProperty('color') === ''
      && outside.getAttribute('style') === null, 'removing an absent declaration must not create a style attribute');
    const rawCss = ' color : white ; width : 19px ';
    outside.setAttribute('style', rawCss);
    check(untouchedStyle.removeProperty('margin-left') === '' && outside.getAttribute('style') === rawCss,
      'removing an absent declaration must not rewrite the existing style attribute');
    untouchedStyle.setProperty('color', undefined);
    check(untouchedStyle.color === 'white' && outside.getAttribute('style') === rawCss,
      'undefined style value must preserve the existing white declaration');
    untouchedStyle.setProperty('color', null);
    check(untouchedStyle.color === '' && untouchedStyle.getPropertyValue('color') === '' && untouchedStyle.width === '19px',
      'null style value must remove only its declaration');
    untouchedStyle.setProperty('width', '9px', 'important');
    untouchedStyle.setProperty('width', '12px', undefined);
    check(untouchedStyle.width === '12px' && untouchedStyle.cssText === 'width: 12px;'
      && outside.getAttribute('style') === 'width: 12px;', 'undefined style priority must clear important and set the value');
    const beforeWhitespace = outside.getAttribute('style');
    untouchedStyle.setProperty('width', ' \t\n ');
    check(untouchedStyle.width === '12px' && outside.getAttribute('style') === beforeWhitespace,
      'whitespace-only width must be invalid without removing or rewriting the old declaration');
    report.style.coercion = { absentRemovalPreservesMissingAttribute: true, absentRemovalPreservesRawAttribute: rawCss,
      undefinedValuePreserves: 'white', nullValueRemoves: true, undefinedPriorityClearsImportant: true,
      whitespaceWidthPreserves: untouchedStyle.width };
    report.style.customWhitespace = [' ', '\u00a0'].map(value => {
      untouchedStyle.setProperty('--space', value);
      const expected = value === ' ' ? '' : value;
      check(untouchedStyle.getPropertyValue('--space') === expected
        && untouchedStyle.cssText === `width: 12px; --space: ${expected};`,
      'custom whitespace must retain a declaration with canonical serialization');
      return { value, property: untouchedStyle.getPropertyValue('--space'), cssText: untouchedStyle.cssText };
    });
    report.style.replacement = [
      ['width:12px; height:3px', 'width', '20px', 'width: 20px; height: 3px;'],
      ['height:3px; width:12px!important', 'width', '20px', 'height: 3px; width: 20px;'],
      ['margin:1px; width:12px', 'margin', '2px 3px', 'margin: 2px 3px; width: 12px;'],
      ['--tone:gold; width:12px', '--tone', 'silver', '--tone: silver; width: 12px;'],
      ['width:12px; height:3px', 'color', 'red', 'width: 12px; height: 3px; color: red;'],
    ].map(([initial, property, value, expected]) => {
      untouchedStyle.cssText = initial;
      untouchedStyle.setProperty(property, value);
      check(untouchedStyle.cssText === expected && outside.getAttribute('style') === expected,
        `CSS replacement order and priority for ${property}`);
      return { property, value, cssText: untouchedStyle.cssText };
    });

    container.className = 'alpha beta';
    check(container.getAttribute('class') === 'alpha beta' && container.className === 'alpha beta', 'className setter reflection');
    container.setAttribute('class', 'gamma');
    check(container.className === 'gamma', 'className must observe attribute writes');
    container.removeAttribute('class');
    check(container.className === '' && container.getAttribute('class') === null, 'className must observe attribute removal');
    report.className = { set: 'alpha beta', attributeUpdate: 'gamma', removed: container.className };

    check(!container.isConnected && !a.isConnected && !text.isConnected, 'detached subtree connectivity');
    check(container.querySelector('[data-dom-contract="first"]') === a, 'detached query identity');
    document.body.appendChild(container);
    check(container.isConnected && a.isConnected && text.isConnected, 'connected subtree connectivity');
    check(document.querySelector('[data-dom-contract="first"]') === a
      && container.querySelector('[data-dom-contract="second"]') === b, 'connected query identity');
    document.body.removeChild(container);
    check(!container.isConnected && !a.isConnected && !text.isConnected
      && document.querySelector('[data-dom-contract="first"]') === null, 'removed subtree connectivity/query');
    check(container.querySelector('[data-dom-contract="first"]') === a && a.ownerDocument === document, 'detachment must preserve query identity and ownerDocument');
    report.connection = { detached: false, attached: true, removed: false, queryIdentity: true, ownerPreserved: true };
    return report;
  } finally {
    if (container.parentNode) container.parentNode.removeChild(container);
    if (holder.parentNode) holder.parentNode.removeChild(holder);
  }
}
