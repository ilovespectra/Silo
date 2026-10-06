/* Real FFmpeg integration tests; no Electron startup, downloads, or persistent build output. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const sharp = require('sharp');
const ffmpeg = require('ffmpeg-static');

// Compile only the owned modules in memory. The main tsconfig does not include standalone exports yet.
const previous = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  assert.ok(['memoryExporter.ts', 'memoryMusic.ts', 'memoryTypes.ts'].includes(path.basename(filename)));
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true },
    fileName: filename,
  });
  module._compile(result.outputText, filename);
};
const { MemoryExporter } = require('../src/memoryExporter.ts');
const { createOriginalSoundtrack, ORIGINAL_MEMORY_SOUNDTRACKS } = require('../src/memoryMusic.ts');
if (previous) require.extensions['.ts'] = previous;
else delete require.extensions['.ts'];

async function run(args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-threads', '2', '-filter_threads', '2', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code && !allowFailure) reject(new Error(stderr));
      else resolve({ stdout: Buffer.concat(chunks), stderr, code });
    });
  });
}

async function frame(file, seconds) {
  const { stdout } = await run(['-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-threads', '2', 'pipe:1']);
  return sharp(stdout).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

function pixel(image, x, y) {
  const offset = (y * image.info.width + x) * image.info.channels;
  return [...image.data.subarray(offset, offset + 3)];
}

function redCentroid(image) {
  let count = 0;
  let x = 0;
  let y = 0;
  for (let row = 0; row < image.info.height; row++) {
    for (let column = 0; column < image.info.width; column++) {
      const [r, g, b] = pixel(image, column, row);
      if (r > 140 && g < 90 && b < 90) { count++; x += column; y += row; }
    }
  }
  assert.ok(count > 0, 'Motion marker is visible');
  return { x: x / count, y: y / count };
}

async function audio(file) {
  const { stdout } = await run(['-ss', '1', '-i', file, '-t', '1', '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1']);
  const samples = Array.from({ length: stdout.length / 2 }, (_, i) => stdout.readInt16LE(i * 2) / 32768);
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  let real = 0;
  let imaginary = 0;
  samples.forEach((sample, index) => {
    real += sample * Math.cos(2 * Math.PI * 880 * index / 24000);
    imaginary += sample * Math.sin(2 * Math.PI * 880 * index / 24000);
  });
  return { rms, tone: 2 * Math.hypot(real, imaginary) / samples.length };
}

async function main() {
  assert.ok(ffmpeg && fs.existsSync(ffmpeg), 'Installed ffmpeg-static is required');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'memory-export-test-'));
  const deps = { ffmpegPath: () => ffmpeg, resolveLocalPath: async value => value, dimensions: { width: 640, height: 360 } };
  const soundtrack = { name: 'Original test score', source: 'original' };
  const suggestion = { id: 'test-memory', title: 'Test', description: '', query: '', mood: 'bright', orientation: 'landscape', media: [], createdAt: 0 };
  const options = { suggestionId: suggestion.id, count: 3, duration: 60, orientation: 'auto', soundtrackId: 'original-bright', originalAudio: 0.35 };
  const media = (file, type = 'image', extra = {}) => ({ path: file, name: path.basename(file), type, modified: 0, ...extra });
  const leftovers = async () => (await fsp.readdir(directory)).filter(name => name.startsWith('.memory-export-'));
  try {
    const images = [];
    for (const color of ['red', 'green', 'blue']) {
      const file = path.join(directory, `${color}.jpg`);
      await run(['-f', 'lavfi', '-i', `color=c=${color}:s=640x360`, '-frames:v', '1', '-threads', '2', '-update', '1', file]);
      images.push(file);
    }
    // A large colourful border proves fitted content remains visible without zoom or crop.
    const border = path.join(directory, 'border.png');
    await run(['-f', 'lavfi', '-i', 'color=c=red:s=640x360', '-vf', 'drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=14', '-frames:v', '1', '-threads', '2', '-update', '1', border]);
    suggestion.media = images.map(file => media(file));
    const originalBytes = await Promise.all(images.map(file => fsp.readFile(file)));
    const movie = path.join(directory, 'three slides.mp4');
    const progress = [];
    let prepared = 0;
    await new MemoryExporter({ ...deps, prepareImage: async file => { prepared++; return file; } }).render(suggestion, options, soundtrack, movie, event => progress.push(event));
    assert.equal(prepared, 3);
    assert.equal(progress.at(-1).phase, 'complete');
    for (const phase of ['preparing', 'rendering', 'mixing', 'complete']) assert.ok(progress.some(event => event.phase === phase));
    assert.ok(progress.some(event => event.phase === 'rendering' && event.completed % 1 > 0), 'FFmpeg progress parsed');
    const inspection = await run(['-i', movie], true);
    assert.match(inspection.stderr, /Video: h264/);
    assert.match(inspection.stderr, /640x360/);
    assert.match(inspection.stderr, /24 fps/);
    assert.match(inspection.stderr, /Audio: aac/);
    assert.match(inspection.stderr, /Duration: 00:01:00\./);
    const a = pixel(await frame(movie, 10), 320, 180);
    const b = pixel(await frame(movie, 30), 320, 180);
    const c = pixel(await frame(movie, 50), 320, 180);
    assert.ok(a[0] > 180 && a[1] < 30 && a[2] < 30);
    assert.ok(b[1] > 90 && b[0] < 30 && b[2] < 30);
    assert.ok(c[2] > 180 && c[0] < 30 && c[1] < 30);
    for (const t of [20, 40]) assert.ok(Math.max(...pixel(await frame(movie, t), 320, 180)) < 25, 'Actual fade through black');
    const earlyFrame = await frame(movie, 0.7);
    for (const [x, y] of [[0, 0], [639, 0], [0, 359], [639, 359]])
      assert.ok(pixel(earlyFrame, x, y)[0] > 150, 'Still images fill all four frame corners without letterbox bars');
    assert.ok((await audio(movie)).rms > 0.015, 'Original background score is audible');
    assert.deepEqual(await leftovers(), []);
    for (let i = 0; i < images.length; i++) assert.deepEqual(await fsp.readFile(images[i]), originalBytes[i]);
    console.log('PASS: real one-minute H264/AAC movie, progress, 24fps, framing, fades, music, source preservation');

    const motionStill = path.join(directory, 'motion-marker.png');
    await run(['-f', 'lavfi', '-i', 'color=c=black:s=640x360', '-vf', 'drawbox=x=90:y=55:w=100:h=100:color=red:t=fill', '-frames:v', '1', '-threads', '2', '-update', '1', motionStill]);
    const motionMedia = Array.from({ length: 4 }, (_, index) => media(motionStill, 'image', { modified: index }));
    suggestion.media = motionMedia;
    const steadyMovie = path.join(directory, 'steady-framing.mp4');
    await new MemoryExporter(deps).render(suggestion, { ...options, count: 4 }, soundtrack, steadyMovie);
    const earlyMarker = redCentroid(await frame(steadyMovie, 1));
    const lateMarker = redCentroid(await frame(steadyMovie, 14));
    assert.ok(Math.abs(lateMarker.x - earlyMarker.x) < 2, 'Photo framing does not pan or zoom horizontally');
    assert.ok(Math.abs(lateMarker.y - earlyMarker.y) < 2, 'Photo framing does not pan or zoom vertically');
    console.log('PASS: stable, unzoomed framing keeps photos comfortably visible');
    suggestion.media = images.map(file => media(file));

    const borderedMovie = path.join(directory, 'bordered.mp4');
    await new MemoryExporter(deps).render({ ...suggestion, media: [media(border)] }, { ...options, count: 1 }, soundtrack, borderedMovie);
    for (const t of [0.7, 59.3]) {
      const image = await frame(borderedMovie, t);
      for (const [x, y] of [[0, 0], [639, 0], [0, 359], [639, 359]])
        assert.ok(pixel(image, x, y).some(channel => channel > 120), `Frame corner (${x}, ${y}) is filled at ${t}`);
    }
    console.log('PASS: full-frame landscape photos remain uncropped');

    // A portrait photo with a "head" at the very top: it must stay in frame, with a blurred fill at the sides.
    const portrait = path.join(directory, 'portrait-head.png');
    await run(['-f', 'lavfi', '-i', 'color=c=0x2060c0:s=360x640', '-vf', 'drawbox=x=120:y=0:w=120:h=60:color=red:t=fill',
      '-frames:v', '1', '-threads', '2', '-update', '1', portrait]);
    const portraitMovie = path.join(directory, 'portrait.mp4');
    await new MemoryExporter(deps).render({ ...suggestion, media: [media(portrait)] }, { ...options, count: 1 }, soundtrack, portraitMovie);
    for (const t of [0.4, 30, 59.5]) {
      const still = await frame(portraitMovie, t);
      const head = redCentroid(still);
      assert.ok(head.y > 2 && head.y < 60, `Head stays in frame at ${t}s (y ${head.y.toFixed(1)})`);
      for (const [x, y] of [[0, 180], [639, 180]])
        assert.ok(pixel(still, x, y)[2] > 60, `Side of a portrait shows the blurred fill, not black (${t}s)`);
    }
    console.log('PASS: portrait photos are fitted whole over a blurred fill; heads are never cropped');

    const live = path.join(directory, 'live.mp4');
    await run(['-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=24', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', live]);
    const dummy = path.join(directory, 'undecodable-still.heic');
    await fsp.writeFile(dummy, 'not an image: Live Photo must use video first');
    const liveSuggestion = { ...suggestion, media: [media(dummy, 'image', { liveVideoPath: live })] };
    const withAudio = path.join(directory, 'live-audio.mp4');
    const withoutAudio = path.join(directory, 'live-muted.mp4');
    const neverPrepare = { ...deps, prepareImage: async () => { throw new Error('Live Photo should use video first'); } };
    await new MemoryExporter(neverPrepare).render(liveSuggestion, { ...options, count: 1 }, soundtrack, withAudio);
    await new MemoryExporter(neverPrepare).render(liveSuggestion, { ...options, count: 1, originalAudio: 0 }, soundtrack, withoutAudio);
    assert.match((await run(['-i', withAudio], true)).stderr, /Duration: 00:01:00\./, 'One-item movie is still one minute long');
    const liveFrame = await frame(withAudio, 1);
    for (const [x, y] of [[0, 0], [639, 0], [0, 359], [639, 359]])
      assert.ok(pixel(liveFrame, x, y)[1] > 90, 'Video clips cover the full frame without letterbox bars');
    assert.ok((await audio(withAudio)).tone > 0.025, 'Original Live Photo audio retained at 0.35');
    assert.ok((await audio(withoutAudio)).tone < 0.004, 'Original audio knob zero mutes Live Photo');
    const silent = path.join(directory, 'silent.mp4');
    await run(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=24', '-t', '1', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', silent]);
    await new MemoryExporter(deps).render({ ...suggestion, media: [media(silent, 'video')] }, { ...options, count: 1 }, soundtrack, path.join(directory, 'silent-mixed.mp4'));
    console.log('PASS: Live Photo video-first, original-audio attenuation/mute, short video padding, missing audio');

    for (const mood of ['gentle', 'bright', 'energetic', 'dramatic']) {
      const score = path.join(directory, `${mood}.wav`);
      const duplicate = path.join(directory, `${mood}-copy.wav`);
      await createOriginalSoundtrack(score, 1, mood);
      await createOriginalSoundtrack(duplicate, 1, mood);
      const bytes = await fsp.readFile(score);
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.length, 44 + 24000 * 2);
      assert.deepEqual(bytes, await fsp.readFile(duplicate), 'Deterministic original score');
    }
    assert.equal(ORIGINAL_MEMORY_SOUNDTRACKS.length, 4);
    const scoreFiles = await Promise.all(['gentle', 'bright', 'energetic', 'dramatic'].map(mood => fsp.readFile(path.join(directory, `${mood}.wav`))));
    assert.equal(new Set(scoreFiles.map(buffer => buffer.toString('base64'))).size, 4, 'Four distinct moods');
    await assert.rejects(createOriginalSoundtrack(path.join(directory, 'invalid.wav'), Infinity, 'gentle'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createOriginalSoundtrack(path.join(directory, 'aborted.wav'), 1, 'gentle', controller.signal), { name: 'AbortError' });
    const libraryMovie = path.join(directory, 'library.mp4');
    const librarySuggestion = { ...suggestion, media: [media(images[0])], orientation: 'portrait' };
    const libraryTrack = { name: 'Own library test', source: 'library', path: path.join(directory, 'gentle.wav') };
    // Personal-use movies: library songs need no rights flag.
    await new MemoryExporter({ ...deps, dimensions: { width: 360, height: 640 } }).render(
      librarySuggestion, { ...options, count: 1, orientation: 'portrait' }, libraryTrack, libraryMovie);
    const landscapeInspection = (await run(['-i', libraryMovie], true)).stderr;
    assert.match(landscapeInspection, /640x360/, 'Even legacy portrait preferences export landscape');
    assert.match(landscapeInspection, /Duration: 00:01:00\./, 'Single item still renders for one minute');
    const landscapeFrame = await frame(libraryMovie, 1);
    for (const [x, y] of [[0, 0], [639, 0], [0, 359], [639, 359]])
      assert.ok(pixel(landscapeFrame, x, y)[0] > 150, 'Landscape output fills all four corners without bars');
    console.log('PASS: four deterministic streamed music moods, local-library loop without a rights gate, landscape-only export');

    // Totals stay frame-aligned at both ends of the 2–5 second per-item range.
    const small = { ...deps, dimensions: { width: 160, height: 90 } };
    const durationOf = async file => {
      const [, h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec((await run(['-i', file], true)).stderr);
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    };
    for (const count of [7, 24]) {
      const duration = 60;
      const many = { ...suggestion, media: Array.from({ length: count }, (_, i) => media(images[i % images.length])) };
      const target = path.join(directory, `many-${count}-${duration}.mp4`);
      await new MemoryExporter(small).render(many, { ...options, count, duration }, soundtrack, target);
      const actual = await durationOf(target);
      assert.ok(Math.abs(actual - duration) < 0.15, `${count} items honor ${duration}s (got ${actual})`);
    }
    for (const invalid of [{ duration: 5 }, { duration: 16 }, { count: 24, duration: 47 }, { count: 4, duration: 59 },
      { duration: 121 }, { count: 0 }, { count: 25 }, { count: 1.5 }, { duration: NaN }]) {
      await assert.rejects(new MemoryExporter(deps).render(suggestion, { ...options, ...invalid }, soundtrack, path.join(directory, 'invalid.mp4')), /Invalid/);
    }
    console.log('PASS: exactly 60-second exports across 1..24 item bounds');

    await assert.rejects(new MemoryExporter(deps).render(suggestion, options, soundtrack, images[0]), /must not replace original/);
    await assert.rejects(new MemoryExporter(deps).render(suggestion, { ...options, originalAudio: 2 }, soundtrack, movie), /Invalid/);
    const alias = path.join(directory, 'source-alias.mp4');
    await fsp.symlink(images[0], alias);
    await assert.rejects(new MemoryExporter(deps).render(suggestion, options, soundtrack, alias), /must not replace original/);
    const protectedMusic = path.join(directory, 'gentle.wav');
    await assert.rejects(new MemoryExporter(deps).render(suggestion, { ...options, rightsAcknowledged: true }, { name: 'Library', source: 'library', path: protectedMusic }, protectedMusic), /must not replace original/);

    const previousOutput = await fsp.readFile(movie);
    const missingSuggestion = { ...suggestion, media: [media(path.join(directory, 'missing.jpg'))] };
    await assert.rejects(new MemoryExporter(deps).render(missingSuggestion, options, soundtrack, movie), /ENOENT/);
    assert.deepEqual(await fsp.readFile(movie), previousOutput, 'Failure preserves existing destination');
    await assert.rejects(new MemoryExporter({ ...deps, timeoutMs: 1 }).render(suggestion, options, soundtrack, movie), /timed out/);
    assert.deepEqual(await fsp.readFile(movie), previousOutput, 'Timeout preserves existing destination');
    await assert.rejects(new MemoryExporter({ ...deps, ffmpegPath: () => path.join(directory, 'missing-ffmpeg') }).render(suggestion, options, soundtrack, movie), /ENOENT/);
    assert.deepEqual(await leftovers(), [], 'Failed, timed-out, and missing executable jobs cleaned');
    console.log('PASS: input protection, alias protection, validation, timeout, missing executable, atomic failure cleanup');

    const exporter = new MemoryExporter(deps);
    const cancellationProgress = [];
    let cancelledChild = false;
    const cancelledJob = exporter.render(suggestion, options, soundtrack, movie, event => {
      cancellationProgress.push(event);
      if (event.phase === 'rendering' && event.completed > 0 && !cancelledChild) {
        cancelledChild = true;
        exporter.cancel();
      }
    });
    // Lock is taken synchronously; another instance must fail before it launches a child.
    await assert.rejects(new MemoryExporter(deps).render(suggestion, options, soundtrack, movie), /already in progress/);
    await assert.rejects(cancelledJob, { name: 'AbortError' });
    assert.ok(cancelledChild, 'Cancellation occurs during real FFmpeg progress');
    assert.equal(cancellationProgress.at(-1).phase, 'cancelled');
    assert.deepEqual(await fsp.readFile(movie), previousOutput, 'Cancellation preserves existing movie');
    assert.deepEqual(await leftovers(), []);
    exporter.cancel(); // Idle cancellation is harmless.
    await exporter.render({ ...suggestion, media: [media(images[0])] }, { ...options, count: 1 }, soundtrack, movie);
    assert.notDeepEqual(await fsp.readFile(movie), previousOutput, 'Successful reuse atomically replaces confirmed destination');

    // Cancellation during preparation also prevents the next child from starting.
    let release;
    const heldPreparation = new Promise(resolve => { release = resolve; });
    let entered;
    const preparing = new Promise(resolve => { entered = resolve; });
    const held = new MemoryExporter({ ...deps, prepareImage: async file => { entered(); await heldPreparation; return file; } });
    const heldJob = held.render(suggestion, options, soundtrack, path.join(directory, 'preparing.mp4'));
    await preparing;
    held.cancel();
    release();
    await assert.rejects(heldJob, { name: 'AbortError' });
    assert.deepEqual(await leftovers(), []);
    console.log('PASS: process-wide single export, real child cancellation, cleanup, exporter reuse, preparation cancellation');
    console.log('All memory export tests passed.');
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
