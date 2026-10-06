"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryExporter = exports.framedFilter = exports.MemoryExportCancelledError = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const memoryMusic_1 = require("./memoryMusic");
const memoryTypes_1 = require("./memoryTypes");
class MemoryExportCancelledError extends Error {
    constructor() { super("Memory export cancelled"); this.name = "AbortError"; }
}
exports.MemoryExportCancelledError = MemoryExportCancelledError;
// A process-wide lock also prevents overlapping exports through separate instances.
let activeExporter;
const FPS = 24;
const TRANSITION = 0.6;
/** Sequential, bounded-memory movie export. Originals are read-only inputs. */
/**
 * Fits the complete photo inside the 16:9 canvas over a softly blurred fill.
 */
function framedFilter(width, height) {
    const scale = `min(min(${width}/iw,${height}/ih),1)`;
    const smallWidth = Math.max(2, Math.round(width / 8 / 2) * 2);
    const smallHeight = Math.max(2, Math.round(height / 8 / 2) * 2);
    const background = `scale=${smallWidth}:${smallHeight}:force_original_aspect_ratio=increase,crop=${smallWidth}:${smallHeight},boxblur=lr='min(8,min(w,h)/4)':lp=2:cr='min(8,min(cw,ch)/4)':cp=2,eq=brightness=-0.08:saturation=0.85,scale=${width}:${height}`;
    const foreground = `scale=w='trunc(iw*${scale}/2)*2':h='trunc(ih*${scale}/2)*2'`;
    return `split=2[memory_bg][memory_fg];[memory_bg]${background}[memory_blur];[memory_fg]${foreground}[memory_photo];[memory_blur][memory_photo]overlay=x='(W-w)/2':y='(H-h)/2',setsar=1`;
}
exports.framedFilter = framedFilter;
class MemoryExporter {
    constructor(deps) {
        this.deps = deps;
    }
    cancel() {
        this.controller?.abort();
        this.child?.kill("SIGTERM");
    }
    checkCancelled() {
        if (this.controller?.signal.aborted)
            throw new MemoryExportCancelledError();
    }
    async ffmpeg(args, onTime) {
        this.checkCancelled();
        const executable = this.deps.ffmpegPath();
        if (!executable)
            throw new Error("FFmpeg is unavailable");
        await new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(executable, [
                "-hide_banner", "-nostdin", "-y", "-threads", "2", "-filter_threads", "2",
                "-filter_complex_threads", "2", "-progress", "pipe:1", "-nostats", ...args,
            ], { stdio: ["ignore", "pipe", "pipe"] });
            this.child = child;
            // Background priority: rendering must never make the app feel sluggish.
            if (child.pid)
                try {
                    os.setPriority(child.pid, 15);
                }
                catch { /* best effort */ }
            let stderr = "";
            let pending = "";
            let timedOut = false;
            let killTimer;
            const terminate = () => {
                child.kill("SIGTERM");
                if (!killTimer)
                    killTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
            };
            const signal = this.controller.signal;
            signal.addEventListener("abort", terminate, { once: true });
            const deadline = setTimeout(() => { timedOut = true; terminate(); }, this.deps.timeoutMs ?? 300000);
            child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
            child.stdout.on("data", (chunk) => {
                pending = (pending + chunk.toString()).slice(-8192);
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() || "";
                for (const line of lines) {
                    const match = /^out_time_us=(\d+)$/.exec(line);
                    if (match && onTime) {
                        try {
                            onTime(Number(match[1]) / 1000000);
                        }
                        catch { /* Observers cannot break cleanup. */ }
                    }
                }
            });
            let spawnError;
            child.on("error", (error) => { spawnError = error; });
            // Wait for close, not exit: pipes are drained and the child has been reaped before cleanup.
            child.on("close", (code) => {
                clearTimeout(deadline);
                if (killTimer)
                    clearTimeout(killTimer);
                signal.removeEventListener("abort", terminate);
                if (this.child === child)
                    this.child = undefined;
                if (signal.aborted)
                    reject(new MemoryExportCancelledError());
                else if (timedOut)
                    reject(new Error("FFmpeg export timed out"));
                else if (spawnError)
                    reject(spawnError);
                else if (code !== 0)
                    reject(new Error(`FFmpeg failed (${code}): ${stderr}`));
                else
                    resolve();
            });
            if (signal.aborted)
                terminate();
        });
        this.checkCancelled();
    }
    async render(suggestion, options, soundtrack, destination, progress = () => { }) {
        if (activeExporter)
            throw new Error("A memory export is already in progress");
        activeExporter = this;
        this.controller = new AbortController();
        let directory;
        let complete = false;
        let total = 0;
        const emit = (phase, completed, message) => {
            try {
                progress({ phase, suggestionId: suggestion.id, completed, total, message });
            }
            catch { /* UI observer only. */ }
        };
        try {
            if (options.suggestionId !== suggestion.id)
                throw new Error("Memory suggestion does not match export options");
            const { minCount, maxCount } = memoryTypes_1.MEMORY_EXPORT_LIMITS;
            if (!Number.isInteger(options.count) || options.count < minCount || options.count > maxCount) {
                throw new Error(`Invalid memory export count: choose ${minCount} to ${maxCount} photos or clips`);
            }
            if (!(0, memoryTypes_1.isMemoryDurationAllowed)(options.count, options.duration)) {
                throw new Error(`Invalid memory export duration: memories must be ${memoryTypes_1.MEMORY_DURATION_SECONDS} seconds long`);
            }
            if (!Number.isFinite(options.originalAudio) || options.originalAudio < 0 || options.originalAudio > 1) {
                throw new Error("Invalid original audio level");
            }
            const selected = suggestion.media.slice(0, options.count);
            total = selected.length;
            if (!total)
                throw new Error("This memory has no photos or clips to export");
            const configuredDimensions = this.deps.dimensions;
            const { width, height } = configuredDimensions
                ? configuredDimensions.width >= configuredDimensions.height
                    ? configuredDimensions
                    : { width: configuredDimensions.height, height: configuredDimensions.width }
                : { width: 1920, height: 1080 };
            if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 3840 && value % 2 === 0)) {
                throw new Error("Output dimensions must be even integers between 64 and 3840");
            }
            // Honor the chosen total: spread whole frames across items so the movie is within half a frame.
            const totalFrames = Math.round(options.duration * FPS);
            const clipFrames = Array.from({ length: total }, (_, index) => Math.floor(totalFrames / total) + (index < totalFrames % total ? 1 : 0));
            const movieDuration = totalFrames / FPS;
            const output = path.resolve(destination);
            emit("preparing", 0, `Preparing ${total} items; ${movieDuration.toFixed(1)} seconds (${(movieDuration / total).toFixed(2)}s each)`);
            // Resolve all selected sources before writing anything; never let an output replace an input.
            const inputs = [];
            const protectedPaths = new Set();
            const protect = async (source) => {
                const absolute = path.resolve(source);
                protectedPaths.add(absolute);
                protectedPaths.add(await fs_1.promises.realpath(absolute));
            };
            for (const media of selected) {
                this.checkCancelled();
                const original = await this.deps.resolveLocalPath(media.path);
                await protect(original);
                const source = media.liveVideoPath ? await this.deps.resolveLocalPath(media.liveVideoPath) : original;
                await protect(source);
                inputs.push({ source, video: Boolean(media.liveVideoPath) || media.type === "video" });
            }
            let musicPath;
            if (soundtrack.path) {
                musicPath = await this.deps.resolveLocalPath(soundtrack.path);
                await protect(musicPath);
            }
            let existingOutput;
            try {
                existingOutput = await fs_1.promises.realpath(output);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            const canonicalOutput = path.join(await fs_1.promises.realpath(path.dirname(output)), path.basename(output));
            if (protectedPaths.has(output) || protectedPaths.has(canonicalOutput) || (existingOutput && protectedPaths.has(existingOutput))) {
                throw new Error("Export destination must not replace original media or a soundtrack");
            }
            this.checkCancelled();
            directory = await fs_1.promises.mkdtemp(path.join(path.dirname(output), ".memory-export-"));
            const clips = [];
            for (let index = 0; index < inputs.length; index++) {
                this.checkCancelled();
                const input = inputs[index];
                const frames = clipFrames[index];
                const duration = frames / FPS;
                // Short items keep most of their screen time visible.
                const fade = Math.min(TRANSITION, duration * 0.4) / 2;
                const audioFilters = `apad,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${options.originalAudio},afade=t=in:d=${fade},afade=t=out:st=${duration - fade}:d=${fade}`;
                let source = input.source;
                if (!input.video && this.deps.prepareImage) {
                    source = await this.deps.prepareImage(source);
                    await protect(source);
                    if (protectedPaths.has(output) || protectedPaths.has(canonicalOutput) || (existingOutput && protectedPaths.has(existingOutput))) {
                        throw new Error("Export destination must not replace a prepared image");
                    }
                    this.checkCancelled();
                }
                let audio;
                if (input.video && options.originalAudio > 0) {
                    const extracted = path.join(directory, `audio-${index}.wav`);
                    try {
                        await this.ffmpeg(["-i", source, "-map", "0:a:0", "-vn", "-t", String(duration), "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", extracted]);
                        audio = extracted;
                    }
                    catch (error) {
                        // Only missing audio is expected. Decode errors, timeouts, and cancellation remain failures.
                        if (!/Stream map ['"]?0:a:0['"]? matches no streams/i.test(error.message))
                            throw error;
                    }
                }
                // PCM intermediates avoid repeated AAC encoder-delay packets at every join.
                // Only the finished movie encodes AAC; MOV retains exact 24fps video timestamps.
                const clip = path.join(directory, `clip-${index}.mov`);
                clips.push(clip);
                const fit = framedFilter(width, height);
                const visual = `${fit},fps=${FPS},tpad=stop_mode=clone:stop_duration=${duration},trim=end_frame=${frames},setpts=PTS-STARTPTS,fade=t=in:d=${fade},fade=t=out:st=${duration - fade}:d=${fade},format=yuv420p`;
                emit("rendering", index, `Rendering item ${index + 1} of ${total} (fade through black)`);
                await this.ffmpeg([
                    "-threads", "2", ...(!input.video ? ["-loop", "1", "-framerate", String(FPS)] : []), "-i", source,
                    ...(audio ? ["-i", audio] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]),
                    "-map", "0:v:0", "-map", "1:a:0", "-vf", visual, "-af", audioFilters,
                    "-t", String(duration), "-r", String(FPS), "-c:v", "libx264", "-preset", "ultrafast",
                    "-crf", "23", "-threads", "2", "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2",
                    "-map_metadata", "-1", clip,
                ], seconds => emit("rendering", Math.min(total, index + seconds / duration), `Rendering item ${index + 1} of ${total}`));
                if (audio)
                    await fs_1.promises.unlink(audio);
            }
            this.checkCancelled();
            const list = path.join(directory, "clips.txt");
            // Relative generated names avoid quoting issues and never expose arbitrary source paths to the demuxer.
            await fs_1.promises.writeFile(list, clips.map(clip => `file '${path.basename(clip)}'`).join("\n") + "\n");
            const joined = path.join(directory, "joined.mov");
            emit("mixing", total, "Joining clips and preparing soundtrack");
            await this.ffmpeg(["-f", "concat", "-safe", "1", "-i", list, "-c", "copy", joined]);
            if (!musicPath) {
                musicPath = path.join(directory, "original-score.wav");
                await (0, memoryMusic_1.createOriginalSoundtrack)(musicPath, movieDuration, suggestion.mood, this.controller.signal);
            }
            else {
                // Bound a looping library source before mixing: an infinite demuxer inside amix
                // can stall at EOF with some FFmpeg builds, even when the output has -t.
                const boundedMusic = path.join(directory, "library-score.wav");
                await this.ffmpeg(["-stream_loop", "-1", "-i", musicPath, "-vn", "-t", String(movieDuration),
                    "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", boundedMusic]);
                musicPath = boundedMusic;
            }
            this.checkCancelled();
            const finished = path.join(directory, "finished.mp4");
            await this.ffmpeg([
                "-i", joined, "-i", musicPath,
                "-filter_complex", `[1:a:0]volume=0.32,afade=t=in:d=0.6,afade=t=out:st=${movieDuration - 0.9}:d=0.9[score];[0:a:0][score]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]`,
                "-map", "0:v:0", "-map", "[a]", "-t", String(movieDuration), "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k", "-threads", "2", "-movflags", "+faststart", "-map_metadata", "-1", finished,
            ], seconds => emit("mixing", total, `Mixing soundtrack (${Math.min(100, Math.round(seconds / movieDuration * 100))}%)`));
            this.checkCancelled();
            // Same filesystem atomic replacement. Main must confirm overwrites in its save dialog.
            await fs_1.promises.rename(finished, output);
            complete = true;
        }
        catch (error) {
            const cancelled = this.controller.signal.aborted || error.name === "AbortError";
            emit(cancelled ? "cancelled" : "error", 0, error.message);
            if (cancelled)
                throw new MemoryExportCancelledError();
            throw error;
        }
        finally {
            try {
                if (directory)
                    await fs_1.promises.rm(directory, { recursive: true, force: true });
            }
            finally {
                this.controller = undefined;
                activeExporter = undefined;
            }
        }
        if (complete)
            emit("complete", total, "Memory movie exported");
    }
}
exports.MemoryExporter = MemoryExporter;
