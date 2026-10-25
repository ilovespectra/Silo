'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const packageJson = require('../package.json');
const { nextPublishedReleaseVersion } = require('./release-version.cjs');

const projectRoot = path.resolve(__dirname, '..');
const repository = 'ilovespectra/Silo';
const workflow = 'windows-exe.yml';
const branch = 'main';
const product = packageJson.build.productName;

const explicitDestination = process.env.SILO_RELEASE_DEST
  ? path.resolve(process.env.SILO_RELEASE_DEST)
  : '';
// With an explicit output root, each release gets its own <root>/<version> folder.
const defaultDestinationFor = (value) => (explicitDestination
  ? path.join(explicitDestination, value)
  : path.join(os.homedir(), 'Downloads', `SILO ${value} TEST`));

function resolveReleaseVersion() {
  const release = JSON.parse(capture('gh', [
    'api', 'repos/ilovespectra/silo-downloads/releases/latest',
  ]));
  const next = nextPublishedReleaseVersion(release);
  console.log(`Published silo-downloads release: ${release.tag_name}; building ${next}.`);
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
  if (result.error) {
    throw describeGitHubFailure(command, args, result.error, result.stderr);
  }
  if (result.status !== 0) {
    throw describeGitHubFailure(command, args, null, result.stderr);
  }
  return result;
}

function describeGitHubFailure(command, args, error, stderr) {
  const invocation = `${command} ${args.join(' ')}`;
  const details = [stderr, error && error.message].filter(Boolean).join('\n').trim();

  if (command === 'gh' || args[0] === 'gh' || args.includes('--repo')) {
    const networkMatch = /can't assign requested address|ECONNREFUSED|ENETUNREACH|timed out|network|socket/i;
    if (details && networkMatch.test(details)) {
      return new Error(
        `${invocation} failed because GitHub is unreachable from this machine. ` +
        'The clean release flow requires a working GitHub API connection and gh authentication. ' +
        'If gh is blocked on this host, trigger the Windows workflow from the browser or fix network access before retrying.',
      );
    }
    if (details && /not logged in|authentication|auth/i.test(details)) {
      return new Error(
        `${invocation} failed because gh is not authenticated. ` +
        'Run `gh auth login` or trigger the Windows workflow from the browser with a working GitHub session.',
      );
    }
  }

  if (error) return error;
  return new Error(details || `${invocation} failed.`);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw describeGitHubFailure(command, args, result.error, result.stderr);
  if (result.status !== 0) {
    throw describeGitHubFailure(command, args, null, result.stderr);
  }
  return result.stdout.trim();
}

function assertCleanReleaseInputs() {
  if (capture('git', ['branch', '--show-current']) !== branch) {
    throw new Error(`Switch to ${branch} before packaging.`);
  }
  // Local packaging repairs do not change the application compiled by Windows CI.
  const applicationPaths = ['--', '.', ':!scripts/dist-mac.cjs', ':!scripts/repackage-binaries.cjs'];
  const workingTree = spawnSync('git', ['diff', '--quiet', 'HEAD', ...applicationPaths], {
    cwd: projectRoot,
  });
  if (workingTree.error) throw workingTree.error;
  if (workingTree.status === 1) {
    throw new Error('Commit or discard tracked working-tree changes before packaging.');
  }
  if (workingTree.status !== 0) {
    throw new Error('Could not inspect tracked working-tree changes.');
  }
  const stagedTree = spawnSync('git', ['diff', '--cached', '--quiet', ...applicationPaths], {
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

function assertLocalMatchesRemote() {
  const localSha = capture('git', ['rev-parse', 'HEAD']);
  const remoteSha = capture('gh', [
    'api', `repos/${repository}/commits/${branch}`, '--jq', '.sha',
  ]);
  if (remoteSha !== localSha) {
    throw new Error(`Local ${branch} must match GitHub ${branch} before packaging.`);
  }
  return localSha;
}

async function dispatchWindowsWorkflow(commitSha, fields = []) {
  const previousRunText = capture('gh', [
    'run', 'list', '--repo', repository, '--workflow', workflow,
    '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // ""',
  ]);
  const previousRunId = previousRunText ? Number(previousRunText) : null;
  const startedAt = Date.now();
  run('gh', [
    'workflow', 'run', workflow, '--repo', repository, '--ref', branch,
    ...fields.flatMap((field) => ['-f', field]),
  ]);
  const workflowRun = await waitForWorkflowRun(previousRunId, commitSha, startedAt);
  run('gh', ['run', 'watch', String(workflowRun.databaseId), '--repo', repository, '--exit-status']);
  return workflowRun;
}

// Runs Windows install, preparation, compile, and test steps on GitHub Actions
// for the exact pushed commit before the release version or any build changes.
async function runWindowsTestGate() {
  const sha = assertLocalMatchesRemote();
  const runs = JSON.parse(capture('gh', [
    'run', 'list', '--repo', repository, '--workflow', workflow,
    '--commit', sha, '--status', 'success', '--limit', '1', '--json', 'url',
  ]) || '[]');
  if (runs.length) {
    console.log(`\nWindows CI already passed for ${sha.slice(0, 7)}: ${runs[0].url}`);
    return;
  }
  console.log(`\nRunning the Windows test gate on GitHub Actions for ${sha.slice(0, 7)} before building…`);
  try {
    await dispatchWindowsWorkflow(sha, ['tests_only=true']);
  } catch (error) {
    throw new Error(
      `Windows test gate failed for ${sha.slice(0, 7)}; no version was changed and nothing was built.\n` +
      (error instanceof Error ? error.message : String(error)),
    );
  }
  console.log('Windows test gate passed.');
}

async function repackage() {
  if (process.platform !== 'darwin') {
    throw new Error('Run this command on the release Mac; it builds both Mac installers locally.');
  }
  if (fs.existsSync(destination) && !fs.statSync(destination).isDirectory()) {
    throw new Error(`The selected release destination is not a folder: ${destination}`);
  }

  assertCleanReleaseInputs();
  console.log('\nInstalling exact locked dependencies and preparing local app runtime assets…');
  run('npm', ['ci', '--no-audit', '--no-fund']);
  run(process.execPath, [path.join(projectRoot, 'scripts', 'prepare-build-dependencies.cjs')]);
  assertCleanReleaseInputs();
  console.log('\nChecking semantic search before versioning or dispatching Windows packaging…');
  run('npm', ['run', 'test:semantic-isolation']);
  if (!suppliedWindowsInstaller) {
    run('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' });
    await runWindowsTestGate();
  }
  if (version !== packageJson.version) {
    if (suppliedWindowsInstaller) {
      throw new Error(`Set the source package to published-release target ${version} and rebuild the supplied Windows installer from that pushed commit.`);
    }
    console.log(`\nSetting Silo ${packageJson.version} -> ${version} from the published release and pushing to ${branch}…`);
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
    assertLocalMatchesRemote();
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
    if (suppliedWindowsInstaller) {
      stagedFiles.set(`${product}-${version}-x64-Setup.exe`, suppliedWindowsInstaller);
    } else {
      const workflowRun = await dispatchWindowsWorkflow(localSha);

      const windowsDownload = path.join(stageRoot, 'windows-ci');
      fs.mkdirSync(windowsDownload);
      run('gh', [
        'run', 'download', String(workflowRun.databaseId), '--repo', repository,
        '--name', 'silo-windows-x64', '--dir', windowsDownload,
      ]);
      const name = `${product}-${version}-x64-Setup.exe`;
      stagedFiles.set(name, findOne(windowsDownload, name));
    }

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

    if (stagedFiles.size !== expected.length || expected.some((name) => !stagedFiles.has(name))) {
      throw new Error(`Expected release files ${expected.join(', ')}; staged ${[...stagedFiles.keys()].join(', ')}.`);
    }
    const releases = JSON.parse(capture('gh', [
      'api', 'repos/ilovespectra/silo-downloads/releases', '--paginate', '--slurp',
    ])).flat();
    if (releases.some((release) => release.tag_name === `v${version}` && !release.draft)) {
      throw new Error(`Version ${version} was published during this build. Refusing to replace its local assets.`);
    }
    fs.mkdirSync(destination, { recursive: true });
    for (const name of expected) {
      const source = stagedFiles.get(name);
      const target = path.join(destination, name);
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
