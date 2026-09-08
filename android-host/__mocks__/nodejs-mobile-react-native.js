const listeners = new Set();

const nodejs = {
  start: jest.fn(),
  channel: {
    addListener: jest.fn((_event, listener) => listeners.add(listener)),
    removeListener: jest.fn((_event, listener) => listeners.delete(listener)),
    send: jest.fn(),
  },
};

module.exports = {__esModule: true, default: nodejs};
