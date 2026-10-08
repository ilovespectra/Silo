'use strict';

const base = require('./electron-builder.config.cjs');

module.exports = {
  ...base,
  win: {
    ...base.win,
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-${version}-x64-Setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
  publish: [{
    provider: 'github',
    owner: 'ilovespectra',
    repo: 'silo-downloads',
  }],
};
