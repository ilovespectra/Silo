const packageJson = require('./package.json');
const testOutput = process.env.SILO_TEST_OUTPUT_DIR;
const extraResources = testOutput
  ? packageJson.build.extraResources.filter(({ from }) => from !== '.model-test-cache')
  : packageJson.build.extraResources;

module.exports = {
  ...packageJson.build,
  directories: {
    ...packageJson.build.directories,
    ...(testOutput ? { output: testOutput } : {}),
  },
  extraResources,
  dmg: {
    background: 'public/dmg-background.png',
    window: { width: 720, height: 500 },
    contents: [
      { x: 150, y: 175, type: 'file' },
      { x: 570, y: 175, type: 'link', path: '/Applications' },
    ],
  },
};
