(() => {
  const nodes = Object.fromEntries(
    ['root', 'body', 'outer', 'middle', 'carrier', 'subject', 'peer'].map(id => [id, document.getElementById(id)]),
  );
  const base = {
    root: 'position:static;margin:0;border:0;padding:0;width:auto;height:auto;background:white;',
    body: 'position:relative;margin:0;padding:0;width:448px;height:256px;background:white;',
    outer: 'position:absolute;left:32px;top:24px;width:320px;height:176px;margin:0;border:0;padding:0;background:transparent;',
    middle: 'position:relative;left:0;top:0;width:160px;height:112px;margin:0;border:0;padding:0;background:transparent;z-index:auto;',
    carrier: 'position:static;width:160px;height:112px;margin:0;border:0;padding:0;background:transparent;',
    subject: 'position:absolute;left:16px;top:16px;width:128px;height:64px;margin:0;background:#e02030;z-index:2;',
    peer: 'position:absolute;left:72px;top:60px;width:80px;height:64px;margin:0;background:#20a060;z-index:0;',
  };
  const zeroParent = { middle: 'z-index:0;' };
  const escapedGroup = {
    outer: 'width:128px;height:80px;overflow:hidden;background:white;',
    middle: 'position:static;background:#2060e0;',
    subject: 'position:fixed;left:128px;top:72px;',
    peer: 'display:none;',
  };
  const relativeSubject = 'position:relative;left:96px;top:48px;';
  const opacityGroup = { ...escapedGroup, middle: `${escapedGroup.middle}opacity:0.5;` };
  const clipGroup = { ...escapedGroup, middle: `${escapedGroup.middle}clip-path:inset(-80px);` };
  const ownOverflow = {
    ...clipGroup,
    outer: `${escapedGroup.outer}overflow:visible;`,
    middle: `${clipGroup.middle}overflow:hidden;`,
    subject: 'position:absolute;left:96px;top:48px;',
  };
  const escapingCarrier = {
    ...ownOverflow,
    carrier: 'position:absolute;left:96px;top:48px;width:128px;height:64px;',
    subject: 'position:relative;left:0;top:0;',
  };
  const cases = {
    'relative-auto-positive': {},
    'absolute-auto-positive': { middle: 'position:absolute;' },
    'zero-parent-positive': zeroParent,
    'fixed-auto-positive': { middle: 'position:fixed;left:32px;top:24px;' },
    'sticky-auto-positive': { middle: 'position:sticky;' },
    'zero-peer-first': zeroParent,
    'zero-order-restored': zeroParent,
    'opacity-fixed-escape': opacityGroup,
    'opacity-relative-clipped': { ...opacityGroup, subject: relativeSubject },
    'clip-group-fixed-escape': clipGroup,
    'clip-group-relative-clipped': { ...clipGroup, subject: relativeSubject },
    'effect-own-overflow-absolute': ownOverflow,
    'relative-in-escaping-carrier': escapingCarrier,
    'css-rect-on-auto-carrier': {
      ...escapingCarrier,
      carrier: `${escapingCarrier.carrier}clip:rect(8px,88px,48px,8px);`,
    },
    'rounded-overflow': {
      outer: 'width:160px;height:112px;box-sizing:border-box;border:8px solid #333333;padding:8px;border-radius:32px;overflow:hidden;background:white;',
      middle: 'position:static;',
      subject: 'position:relative;left:-8px;top:-8px;',
      peer: 'display:none;',
    },
    'clip-group-fixed-restored': clipGroup,
    'auto-parent-restored': {},
  };
  let peerFirst = false;

  globalThis.clipFixture = {
    prepare(name) {
      if (!Object.hasOwn(cases, name)) throw new Error(`Unknown paint ownership case: ${name}`);
      for (const [id, style] of Object.entries(base)) {
        nodes[id].setAttribute('style', style + (cases[name][id] ?? ''));
      }
      const nextPeerFirst = name === 'zero-peer-first';
      if (nextPeerFirst !== peerFirst) {
        nodes.body.appendChild(nextPeerFirst ? nodes.outer : nodes.peer);
        peerFirst = nextPeerFirst;
      }
    },
  };
})();
