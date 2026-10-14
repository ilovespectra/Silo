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
const product = packageJson.build.productName;

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^v/i, '').replace(/[-_ ].*$/, '');
  const match = /^([0-9]+)\.([0-9]+)(?:\.([0-9]+))?(?:\.(?:[0-9]+))*$/.exec(cleaned);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] === b[index]) continue;
    return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function bumpPatchVersion(value) {
  const parsed = parseSemver(value);
  if (!parsed) return value;
  const [major, minor, patch] = parsed;
  return `${major}.${minor}.${patch + 1}`;
}

function findLatestVersionInFolder(folder) {
  if (!folder || !fs.existsSync(folder)) return null;

  let latest = null;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const match = entry.isFile()
      ? /Silo-([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(entry.name)
      : entry.isDirectory() && fs.existsSync(path.join(folder, entry.name, `${product}-${entry.name}-arm64.dmg`))
        ? /^([0-9]+\.[0-9]+\.[0-9]+)$/.exec(entry.name)
        : null;
    if (!match) continue;
    const candidate = match[1];
    if (!latest || compareVersions(candidate, latest) > 0) {
      latest = candidate;
    }
  }
  return latest;
}

function readLatestGitHubReleaseTag() {
  try {
    const output = capture('gh', ['api', 'repos/ilovespectra/silo-downloads/releases/latest', '--jq', '.tag_name']);
    return output || null;
  } catch {
    return null;
  }
}

const explicitDestination = process.env.SILO_RELEASE_DEST
  ? path.resolve(process.env.SILO_RELEASE_DEST)
  : '';
// With an explicit output root, each release gets its own <root>/<version> folder.
const defaultDestinationFor = (value) => (explicitDestination
  ? path.join(explicitDestination, value)
  : path.join(os.homedir(), 'Downloads', `SILO ${value} TEST`));

// The release version always comes from package.json. When that version was
// already packaged (in the destination) or published, bump the patch and
// commit/push the bump so the Mac builds and Windows CI use the same version.
function resolveReleaseVersion() {
  const current = packageJson.version;
  const existingFolders = [...new Set(
    [explicitDestination, defaultDestinationFor(current)].filter(Boolean),
  )];
  const alreadyPackaged = existingFolders.some((folder) =>
    fs.existsSync(path.join(folder, `${product}-${current}-arm64.dmg`)));
  const remoteVersion = readLatestGitHubReleaseTag();
  const remoteIsNewerOrSame = remoteVersion && compareVersions(remoteVersion, current) >= 0;
  if (!alreadyPackaged && !remoteIsNewerOrSame) return current;
  const base = remoteVersion && compareVersions(remoteVersion, current) > 0
    ? parseSemver(remoteVersion).join('.')
    : current;
  let next = bumpPatchVersion(base);
  for (const folder of existingFolders) {
    const folderVersion = findLatestVersionInFolder(folder);
    while (folderVersion && compareVersions(folderVersion, next) >= 0) next = bumpPatchVersion(next);
  }
  return next;
}

const version = resolveReleaseVersion();
const destination = defaultDestinationFor(version);
const outputFolder = path.join(projectRoot, 'release');
const stageParent = process.env.SILO_RELEASE_STAGE_DIR
  ? path.resolve(process.env.SILO_RELEASE_STAGE_DIR)
  : outputFolder;
const suppliedWindowsInstaller = process.env.SILO_WINDOWS_SETUP_EXE
  ? path.resolve(process.env.SILO_WINDOWS_SETUP_EXE)
  : '';
const suppliedWindowsBuildSha = process.env.SILO_WINDOWS_BUILD_SHA || '';
const preservedUntracked = new Set([
  'claudetest.txt',
  'electron-dist/paidLicense.d.ts',
  'electron-dist/paidLicense.js',
  'electron-dist/paidLicensePublicKey.d.ts',
  'electron-dist/paidLicensePublicKey.js',
  'scripts/generate_from_silo_clip_index.py',
  'test/test_silo_clip_generator.py',
  'scripts/beta-license-dashboard.local.cjs',
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
    throw new Error('Run this command on the release Mac; it builds both Mac installers locally.');
  }
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) {
    throw new Error('Install the project dependencies first with npm ci.');
  }
  fs.mkdirSync(destination, { recursive: true });
  if (!fs.statSync(destination).isDirectory()) {
    throw new Error(`The selected release destination is not a folder: ${destination}`);
  }

  assertCleanReleaseInputs();
  if (version !== packageJson.version) {
    if (suppliedWindowsInstaller) {
      throw new Error(`Version ${packageJson.version} is already packaged; bump package.json before supplying a Windows installer.`);
    }
    console.log(`\nBumping Silo ${packageJson.version} -> ${version} and pushing to ${branch}…`);
    run('npm', ['version', version, '--no-git-tag-version']);
    run('git', ['add', 'package.json', 'package-lock.json']);
    run('git', ['commit', '-m', `Release v${version}`]);
    run('git', ['push', 'origin', branch]);
  }
  const localSha = capture('git', ['rev-parse', 'HEAD']);
  if (suppliedWindowsInstaller) {
    if (!fs.existsSync(suppliedWindowsInstaller) ||
        !fs.statSync(suppliedWindowsInstaller).isFile() ||
        fs.statSync(suppliedWindowsInstaller).size === 0 ||
        path.basename(suppliedWindowsInstaller) !== `${product}-${version}-x64-Setup.exe`) {
      throw new Error('SILO_WINDOWS_SETUP_EXE must name a non-empty Windows x64 installer from the current build.');
    }
    if (suppliedWindowsBuildSha !== localSha) {
      throw new Error('SILO_WINDOWS_BUILD_SHA must match the exact local main commit used by the Windows build.');
    }
  } else {
    run('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' });
    const remoteSha = capture('gh', [
      'api', `repos/${repository}/commits/${branch}`, '--jq', '.sha',
    ]);
    if (remoteSha !== localSha) {
      throw new Error(`Local ${branch} must match GitHub ${branch} before packaging.`);
    }
  }

  const expected = [
    `${product}-${version}-x64.dmg`,
    `${product}-${version}-x64.zip`,
    `${product}-${version}-arm64.dmg`,
    `${product}-${version}-arm64.zip`,
    `${product}-${version}-x64-Setup.exe`,
    'latest-mac.yml',
  ];
  fs.mkdirSync(stageParent, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(stageParent, '.repackage-binaries-'));
  const stagedFiles = new Map();
  const macManifestPaths = {};
  const pendingInstalls = [];
  let completed = false;

  try {
    for (const architecture of ['x64', 'arm64']) {
      const buildOutput = path.join(stageRoot, `mac-${architecture}`);
      run('npm', [`run`, `dist:mac:${architecture}`], {
        env: { ...process.env, SILO_RELEASE_OUTPUT_DIR: buildOutput },
      });
      for (const extension of ['dmg', 'zip']) {
        const name = `${product}-${version}-${architecture}.${extension}`;
        stagedFiles.set(name, findOne(buildOutput, name));
      }
      macManifestPaths[architecture] = findOne(buildOutput, 'latest-mac.yml');
    }

    const mergedManifest = path.join(stageRoot, 'latest-mac.yml');
    run(process.execPath, [
      path.join(projectRoot, 'scripts', 'merge-mac-update-manifests.cjs'),
      macManifestPaths.x64,
      macManifestPaths.arm64,
      mergedManifest,
    ]);
    stagedFiles.set('latest-mac.yml', mergedManifest);

    if (suppliedWindowsInstaller) {
      stagedFiles.set(`${product}-${version}-x64-Setup.exe`, suppliedWindowsInstaller);
    } else {
      const previousRunText = capture('gh', [
        'run', 'list', '--repo', repository, '--workflow', workflow,
        '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // ""',
      ]);
      const previousRunId = previousRunText ? Number(previousRunText) : null;
      const startedAt = Date.now();
      run('gh', ['workflow', 'run', workflow, '--repo', repository, '--ref', branch]);
      const workflowRun = await waitForWorkflowRun(previousRunId, localSha, startedAt);
      run('gh', ['run', 'watch', String(workflowRun.databaseId), '--repo', repository, '--exit-status']);

      const windowsDownload = path.join(stageRoot, 'windows-ci');
      fs.mkdirSync(windowsDownload);
      run('gh', [
        'run', 'download', String(workflowRun.databaseId), '--repo', repository,
        '--name', 'silo-windows-x64', '--dir', windowsDownload,
      ]);
      const name = `${product}-${version}-x64-Setup.exe`;
      stagedFiles.set(name, findOne(windowsDownload, name));
    }

    if (stagedFiles.size !== expected.length || expected.some((name) => !stagedFiles.has(name))) {
      throw new Error(`Expected release files ${expected.join(', ')}; staged ${[...stagedFiles.keys()].join(', ')}.`);
    }
    for (const name of expected) {
      const source = stagedFiles.get(name);
      const target = path.join(destination, name);
      // latest-mac.yml is unversioned and always describes the newest build.
      if (fs.existsSync(target) && name !== 'latest-mac.yml') {
        throw new Error(`Refusing to replace an existing test artifact: ${target}`);
      }
      pendingInstalls.push(stageFile(source, target));
    }

    for (const file of pendingInstalls) fs.renameSync(file.temporary, file.target);
    completed = true;

    console.log(`\nInstalled ${expected.length} verified test release assets in ${destination}:`);
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
    if (!completed) console.error('Existing destination files were left in place until every build asset was ready.');
  }
}

repackage().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
