"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOriginalSoundtrack = exports.ORIGINAL_MEMORY_SOUNDTRACKS = void 0;
const fs_1 = require("fs");
/** Locally synthesized original scores, not recordings or third-party public-domain music. */
exports.ORIGINAL_MEMORY_SOUNDTRACKS = [
    { id: "original-gentle", name: "Quiet Moments", source: "original", rights: "Locally synthesized original instrumental; no third-party recording." },
    { id: "original-bright", name: "Sunny Days", source: "original", rights: "Locally synthesized original instrumental; no third-party recording." },
    { id: "original-energetic", name: "On Our Way", source: "original", rights: "Locally synthesized original instrumental; no third-party recording." },
    { id: "original-dramatic", name: "Wide Horizons", source: "original", rights: "Locally synthesized original instrumental; no third-party recording." },
];
const abortError = () => Object.assign(new Error("Memory export cancelled"), { name: "AbortError" });
/** Writes deterministic PCM in bounded chunks. The caller owns this temporary file. */
async function createOriginalSoundtrack(destination, duration, mood, signal) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) {
        throw new Error("Soundtrack duration must be between 0 and 3600 seconds");
    }
    if (signal?.aborted)
        throw abortError();
    const sampleRate = 24000;
    const samples = Math.ceil(duration * sampleRate);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + samples * 2, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(samples * 2, 40);
    const presets = {
        gentle: { bpm: 72, root: 48, pad: 0.18, arp: 0.04, beat: 0.012, minor: false },
        bright: { bpm: 100, root: 55, pad: 0.14, arp: 0.10, beat: 0.035, minor: false },
        energetic: { bpm: 124, root: 48, pad: 0.10, arp: 0.12, beat: 0.09, minor: false },
        dramatic: { bpm: 84, root: 45, pad: 0.22, arp: 0.065, beat: 0.045, minor: true },
    };
    const preset = presets[mood] || presets.gentle;
    const beatLength = 60 / preset.bpm;
    const chordLength = beatLength * 8;
    const roots = preset.minor ? [0, 8, 3, 10] : [0, 5, 9, 7];
    const frequency = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
    const wave = (hz, time) => Math.sin(2 * Math.PI * hz * time) + 0.18 * Math.sin(4 * Math.PI * hz * time);
    const chord = (index, time) => {
        const root = preset.root + roots[index % roots.length];
        return (wave(frequency(root), time) + wave(frequency(root + (preset.minor ? 3 : 4)), time)
            + wave(frequency(root + 7), time)) / 3;
    };
    const file = await fs_1.promises.open(destination, "wx");
    try {
        await file.writeFile(header);
        const chunk = Buffer.alloc(4096 * 2);
        for (let offset = 0; offset < samples; offset += 4096) {
            if (signal?.aborted)
                throw abortError();
            const length = Math.min(4096, samples - offset);
            for (let i = 0; i < length; i++) {
                const t = (offset + i) / sampleRate;
                const index = Math.floor(t / chordLength);
                const cross = Math.min(1, (t % chordLength) / 0.45);
                const pad = chord(index, t) * cross + chord(Math.max(0, index - 1), t) * (1 - cross);
                const noteStep = Math.floor(t / (beatLength / 2));
                const arpNote = [0, preset.minor ? 3 : 4, 7, 12][noteStep % 4];
                const arpTime = t % (beatLength / 2);
                const arpEnvelope = Math.min(1, arpTime / 0.015) * Math.exp(-arpTime * 9);
                const arp = wave(frequency(preset.root + roots[index % 4] + arpNote + 12), t) * arpEnvelope;
                const beatTime = t % beatLength;
                const kick = Math.sin(2 * Math.PI * (52 * beatTime + 1.5 * (1 - Math.exp(-beatTime * 30))))
                    * Math.exp(-beatTime * 18);
                const shimmer = Math.sin(2 * Math.PI * 5100 * t) * Math.sin(2 * Math.PI * 7237 * t)
                    * Math.exp(-arpTime * 75) * 0.15;
                const envelope = Math.min(1, t / 0.6, Math.max(0, duration - t) / 0.9);
                const value = envelope * (pad * preset.pad + arp * preset.arp + (kick + shimmer) * preset.beat);
                chunk.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2);
            }
            await file.writeFile(chunk.subarray(0, length * 2));
        }
    }
    finally {
        await file.close();
    }
}
exports.createOriginalSoundtrack = createOriginalSoundtrack;
