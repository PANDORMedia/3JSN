import { mount, snapshot, verify, unmount } from './application.mjs';
import { runDomContract } from './dom-contract.mjs';

const domContract = runDomContract();
const ready = mount();
globalThis.uiProbe = {
  async snapshot() { await ready; return { ...snapshot(), domContract }; },
  async verify() { await ready; return verify(); },
  unmount,
};
