const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');
const { VideoSemanticIndexer, extractMidpointFrame } = require('../electron-dist/videoSemanticIndexer');

const VECTOR_SIZE = 512;

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-video-index-test-'));
  const sourceRoot = path.join(temporaryRoot, 'videos');
  await fs.mkdir(sourceRoot, { recursive: true });
  const videoPath = path.join(sourceRoot, 'midpoint-blue.mp4');
  const framePath = path.join(temporaryRoot, 'midpoint.jpg');
  const storageRoot = path.join(temporaryRoot, 'index');
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=10:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=10:d=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
      '-map', '[v]', '-c:v', 'mpeg4', '-q:v', '2', '-g', '10', videoPath,
    ], { stdio: 'pipe' });

    await extractMidpointFrame(videoPath, framePath, { ffmpegPath });
    const midpoint = await sharp(framePath).resize(1, 1).removeAlpha().raw().toBuffer();
    assert.ok(midpoint[2] > midpoint[0] * 1.4,
      `midpoint should be blue (red=${midpoint[0]}, blue=${midpoint[2]})`);

    const stats = await fs.stat(videoPath);
    const file = {
      name: path.basename(videoPath),
      path: videoPath,
      relativePath: path.basename(videoPath),
      size: stats.size,
      modified: stats.mtimeMs,
      isDirectory: false,
      type: 'video',
      extension: '.mp4',
    };
    const scanSource = async (root, onFile, isCancelled) => {
      if (root === sourceRoot && !isCancelled()) onFile(file);
    };
    const embedFrame = async (imagePath) => {
      const channels = await sharp(imagePath).stats();
      const vector = new Float32Array(VECTOR_SIZE);
      vector[channels.channels[2].mean > channels.channels[0].mean ? 0 : 1] = 1;
      return vector;
    };
    const embedPrompts = async (prompts) => prompts.map((prompt) => {
      const vector = new Float32Array(VECTOR_SIZE);
      vector[prompt.toLowerCase().includes('blue') ? 0 : 1] = 1;
      return vector;
    });
    const createIndexer = () => new VideoSemanticIndexer({
      storageRoot,
      scanSource,
      embedFrame,
      embedPrompts,
      ffmpegPath,
    });

    const firstRun = createIndexer();
    await firstRun.initialize();
    await firstRun.start([sourceRoot]);
    assert.equal(firstRun.getIndexedVideoCount([sourceRoot]), 1,
      'the source video should be indexed');
    assert.equal(firstRun.getProgress().status, 'complete');
    await firstRun.flush();

    const afterRestart = createIndexer();
    await afterRestart.initialize();
    const results = await afterRestart.search('blue', [sourceRoot]);
    assert.equal(results.length, 1, 'the persisted video should be searchable after restart');
    assert.equal(results[0].path, videoPath);
    assert.equal(results[0].type, 'video');
    assert.equal(results[0].extension, '.mp4');
    assert.ok(results[0].confidence > 99, 'the midpoint embedding should match the blue query');
    await afterRestart.flush();
    console.log('Video midpoint extraction, semantic search, and restart persistence passed.');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
