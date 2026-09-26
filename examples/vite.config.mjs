export default {
  build: {
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: 'dom-window/index.html',
    },
  },
};
