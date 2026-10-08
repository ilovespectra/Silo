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
    ...(process.env.SILO_NSIS_INCLUDE
      ? { include: process.env.SILO_NSIS_INCLUDE }
      : {}),
  },
  publish: [{
    provider: 'github',
    owner: 'ilovespectra',
    repo: 'silo-downloads',
  }],
};
