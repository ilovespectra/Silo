const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  assert.ok(
    ["memoryExporter.ts", "memoryMusic.ts", "memoryTypes.ts"].includes(path.basename(filename)),
  );
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { MemoryExporter } = require("../src/memoryExporter.ts");
const { MEMORY_EXPORT_LIMITS } = require("../src/memoryTypes.ts");
const root = path.resolve(__dirname, "..");
const workPath = path.join(root, "tmp", "windows-memory-runtime-smoke");
const ffmpeg = process.argv[2]
  ? path.resolve(process.argv[2])
  : require("ffmpeg-static");

async function main() {
  assert.ok(fs.statSync(ffmpeg).size > 0, "The selected FFmpeg binary exists");
  fs.mkdirSync(workPath, { recursive: true });
  const outputPath = path.join(workPath, "memory-smoke.mp4");
  const media = [];
  for (let index = 0; index < MEMORY_EXPORT_LIMITS.minCount; index += 1) {
    const imagePath = path.join(workPath, `memory-photo-${index + 1}.jpg`);
    await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: { r: 130 + index, g: 100, b: 80 },
      },
    }).jpeg().toFile(imagePath);
    media.push({ path: imagePath, name: path.basename(imagePath), type: "image", modified: index });
  }

  const suggestion = {
    id: "windows-runtime-smoke",
    title: "Runtime smoke",
    description: "",
    query: "",
    mood: "gentle",
    media,
    createdAt: 0,
  };
  const exporter = new MemoryExporter({
    ffmpegPath: () => ffmpeg,
    resolveLocalPath: async (value) => value,
    dimensions: { width: 320, height: 240 },
  });
  await exporter.render(
    suggestion,
    {
      suggestionId: suggestion.id,
      count: media.length,
      duration: 60,
      soundtrackId: "original-gentle",
      originalAudio: 0,
    },
    { name: "Original gentle score", source: "original" },
    outputPath,
  );

  const movie = await fs.promises.readFile(outputPath);
  assert.equal(movie.toString("ascii", 4, 8), "ftyp", "Memories produced a valid MP4 container");
  assert.ok(movie.length > 20_000, "The rendered memory movie contains encoded media");
  const decoded = spawnSync(ffmpeg, [
    "-hide_banner", "-v", "error", "-nostdin", "-t", "1", "-i", outputPath, "-f", "null", "-",
  ], { stdio: "ignore", timeout: 30000 });
  assert.equal(decoded.error, undefined, decoded.error?.message);
  assert.equal(decoded.status, 0, "The bundled FFmpeg can decode the rendered memory");
  console.log(`Windows memory export rendered and decoded a one-minute MP4 with ${media.length} media items (${movie.length} bytes).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(workPath, { recursive: true, force: true });
  });
