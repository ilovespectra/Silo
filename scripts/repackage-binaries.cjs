'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packageJson = require('../package.json');

const projectRoot = path.resolve(__dirname, '..');
const repository = 'ilovespectra/Silo';
const workflow = 'windows-exe.yml';
const branch = 'main';
const version = packageJson.version;
const product = packageJson.build.productName;
const outputFolder = path.join(projectRoot, 'release');
const destination = process.env.SILO_RELEASE_DEST
  ? path.resolve(process.env.SILO_RELEASE_DEST)
  : path.join(os.homedir(), 'Downloads', 'SILO 2.0.4 REAL');
const preservedUntracked = new Set([
  'claudetest.txt',
  'scripts/generate_from_silo_clip_index.py',
  'test/test_silo_clip_generator.py',
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
  }
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(' ')} failed.`);
  }
  return result.stdout.trim();
}

function assertCleanReleaseInputs() {
  if (capture('git', ['branch', '--show-current']) !== branch) {
    throw new Error(`Switch to ${branch} before packaging.`);
  }
  const workingTree = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], {
    cwd: projectRoot,
  });
  if (workingTree.error) throw workingTree.error;
  if (workingTree.status === 1) {
    throw new Error('Commit or discard tracked working-tree changes before packaging.');
  }
  if (workingTree.status !== 0) {
    throw new Error('Could not inspect tracked working-tree changes.');
  }
  const stagedTree = spawnSync('git', ['diff', '--cached', '--quiet'], {
    cwd: projectRoot,
  });
  if (stagedTree.error) throw stagedTree.error;
  if (stagedTree.status === 1) {
    throw new Error('Commit or unstage staged changes before packaging.');
  }
  if (stagedTree.status !== 0) throw new Error('Could not inspect staged changes.');

  const untracked = capture('git', [
    'ls-files', '--others', '--exclude-standard',
  ]).split('\n').filter(Boolean);
  const unexpected = untracked.filter((file) => !preservedUntracked.has(file));
  if (unexpected.length) {
    throw new Error(
      `Untracked files must be reviewed and committed before packaging:\n${unexpected.join('\n')}`,
    );
  }
}

function findOne(root, expectedName) {
  const matches = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name === expectedName) matches.push(fullPath);
    }
  }
  visit(root);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${expectedName} under ${root}; found ${matches.length}.`);
  }
  const stat = fs.statSync(matches[0]);
  if (stat.size === 0) throw new Error(`${expectedName} is empty.`);
  return matches[0];
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getNewWorkflowRun(previousRunId, commitSha, startedAt) {
  const rows = JSON.parse(capture('gh', [
    'run', 'list', '--repo', repository,
    '--workflow', workflow, '--branch', branch,
    '--event', 'workflow_dispatch', '--limit', '20',
    '--json', 'databaseId,headSha,status,createdAt',
  ]));
  return rows.find((row) => row.databaseId !== previousRunId &&
    row.headSha === commitSha && Date.parse(row.createdAt) >= startedAt - 5000);
}

async function waitForWorkflowRun(previousRunId, commitSha, startedAt) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const runInfo = getNewWorkflowRun(previousRunId, commitSha, startedAt);
    if (runInfo) return runInfo;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error('Timed out waiting for the Windows packaging workflow to start.');
}

function stageFile(source, target) {
  const temporary = `${target}.repackage-${process.pid}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  return { temporary, target };
}

async function repackage() {
  if (process.platform !== 'darwin') {
    throw new Error('Run this command on the release Mac; it builds both Mac DMGs locally.');
  }
  if (version !== '2.0.4') {
    throw new Error(`This recovery command targets Silo 2.0.4, but package.json is ${version}.`);
  }
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) {
    throw new Error('Install the project dependencies first with npm ci.');
  }
  if (!fs.existsSync(destination)) {
    throw new Error(`The selected Downloads folder does not exist: ${destination}`);
  }
  if (!fs.statSync(destination).isDirectory()) {
    throw new Error(`The selected Downloads path is not a folder: ${destination}`);
  }

  assertCleanReleaseInputs();
  run('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' });
  const remoteSha = capture('gh', [
    'api', `repos/${repository}/commits/${branch}`, '--jq', '.sha',
  ]);
  const localSha = capture('git', ['rev-parse', 'HEAD']);
  if (remoteSha !== localSha) {
    throw new Error(`Local ${branch} must match GitHub ${branch} before packaging.`);
  }

  const expected = [
    `${product}-${version}-x64.dmg`,
    `${product}-${version}-arm64.dmg`,
    `${product}-${version}-x64-Setup.exe`,
  ];
  const stageRoot = fs.mkdtempSync(path.join(outputFolder, '.repackage-binaries-'));
  const stagedFiles = [];
  const pendingInstalls = [];
  let completed = false;

  try {
    for (const architecture of ['x64', 'arm64']) {
      const buildOutput = path.join(stageRoot, `mac-${architecture}`);
      run('npm', [`run`, `dist:mac:${architecture}`], {
        env: { ...process.env, SILO_RELEASE_OUTPUT_DIR: buildOutput },
      });
      stagedFiles.push(findOne(buildOutput, `${product}-${version}-${architecture}.dmg`));
    }

    const previousRunText = capture('gh', [
      'run', 'list', '--repo', repository, '--workflow', workflow,
      '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // ""',
    ]);
    const previousRunId = previousRunText ? Number(previousRunText) : null;
    const startedAt = Date.now();
    run('gh', ['workflow', 'run', workflow, '--repo', repository, '--ref', branch]);
    const workflowRun = await waitForWorkflowRun(previousRunId, remoteSha, startedAt);
    run('gh', ['run', 'watch', String(workflowRun.databaseId), '--repo', repository, '--exit-status']);

    const windowsDownload = path.join(stageRoot, 'windows-ci');
    fs.mkdirSync(windowsDownload);
    run('gh', [
      'run', 'download', String(workflowRun.databaseId), '--repo', repository,
      '--name', 'silo-windows-x64', '--dir', windowsDownload,
    ]);
    stagedFiles.push(findOne(windowsDownload, `${product}-${version}-x64-Setup.exe`));

    if (stagedFiles.length !== expected.length) {
      throw new Error(`Expected ${expected.length} release files; staged ${stagedFiles.length}.`);
    }
    for (const [index, source] of stagedFiles.entries()) {
      if (path.basename(source) !== expected[index]) {
        throw new Error(`Unexpected release file: ${path.basename(source)}`);
      }
      const target = path.join(destination, expected[index]);
      pendingInstalls.push(stageFile(source, target));
    }

    for (const file of pendingInstalls) fs.renameSync(file.temporary, file.target);
    completed = true;

    console.log(`\nInstalled ${expected.length} verified build artifacts in ${destination}:`);
    for (const name of expected) {
      const filePath = path.join(destination, name);
      console.log(`${sha256(filePath)}  ${name}`);
    }
    console.log('\nThe GitHub release draft was not published or changed.');
  } finally {
    for (const file of pendingInstalls) {
      if (fs.existsSync(file.temporary)) fs.rmSync(file.temporary, { force: true });
    }
    fs.rmSync(stageRoot, { recursive: true, force: true });
    if (!completed) console.error('Existing Downloads artifacts were left in place until all three builds were ready.');
  }
}

repackage().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
