'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const script = path.resolve(__dirname, '../scripts/repackage-binaries.cjs');
const code = fs.readFileSync(script, 'utf8');

function preflight({ sourceVersion, release, offline = false }) {
  const destinations = [];
  const errors = [];
  const context = {
    __dirname: path.dirname(script),
    console: { log() {}, error(message) { errors.push(message); } },
    process: {
      platform: 'darwin',
      env: { SILO_RELEASE_DEST: '/output', SILO_RELEASE_VERSION: '9.9.9', SILO_RELEASE_REBUILD_CURRENT: 'true' },
    },
    require(name) {
      if (name === '../package.json') return { version: sourceVersion, build: { productName: 'Silo' } };
      if (name === './release-version.cjs') return require('../scripts/release-version.cjs');
      if (name === 'fs') return {
        existsSync() { return true; },
        mkdirSync(destination) {
          destinations.push(destination);
          throw new Error('Stop before any build or file mutation');
        },
      };
      if (name === 'child_process') return {
        spawnSync(program, args) {
          assert.equal(program, 'gh');
          assert.deepEqual(Array.from(args), ['api', 'repos/ilovespectra/silo-downloads/releases/latest']);
          return offline
            ? { status: 1, stderr: 'GitHub unavailable', stdout: '' }
            : { status: 0, stderr: '', stdout: JSON.stringify(release) };
        },
      };
      return require(name);
    },
  };
  vm.runInNewContext(code, context, { filename: script });
  return { destinations, errors };
}

test('published downloads release alone selects version despite source drift, files and stale overrides', async () => {
  for (const sourceVersion of ['2.3.0', '2.3.1', '9.9.9']) {
    const result = preflight({
      sourceVersion, release: { tag_name: 'v2.2.9', draft: false, prerelease: false },
    });
    await Promise.resolve();
    assert.deepEqual(result.destinations, ['/output/2.3.0']);
    assert.match(result.errors[0], /Stop before/);
  }
  const published = preflight({
    sourceVersion: '2.3.0', release: { tag_name: 'v2.3.0', draft: false, prerelease: false },
  });
  await Promise.resolve();
  assert.deepEqual(published.destinations, ['/output/2.3.1']);
});

test('unavailable or invalid published release fails before any output mutation', () => {
  assert.throws(() => preflight({ sourceVersion: '2.3.1', offline: true }), /GitHub unavailable/);
  assert.throws(() => preflight({ sourceVersion: '2.3.1', release: {} }), /published stable/);
});
