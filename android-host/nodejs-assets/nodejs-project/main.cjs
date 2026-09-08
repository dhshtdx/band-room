'use strict';

const path = require('node:path');
const rnBridge = require('rn-bridge');

let status = {type: 'server-starting'};

function send(nextStatus) {
  status = nextStatus;
  rnBridge.channel.send(JSON.stringify(nextStatus));
}

rnBridge.channel.on('message', raw => {
  try {
    const message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (message?.type === 'status:request') {
      rnBridge.channel.send(JSON.stringify(status));
    }
  } catch {
    // React Native 侧的非协议消息不影响本机服务器。
  }
});

process.env.PORT = '0';
process.env.BAND_ROOM_DATA_DIR = path.join(rnBridge.app.datadir(), 'band-room-data');

const fatal = error => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  send({type: 'server-error', message});
};

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

send({type: 'server-starting'});
import('./server/index.js')
  .then(module => module.serverReady)
  .then(({port}) => send({type: 'server-ready', port}))
  .catch(fatal);
