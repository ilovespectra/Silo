"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAudioFile = exports.audioExtension = exports.AUDIO_EXTENSIONS = void 0;
/** Common audio codecs, containers, sample formats, and tracker/module formats. */
exports.AUDIO_EXTENSIONS = new Set([
    ".3ga", ".669", ".8svx", ".aa", ".aac", ".aax", ".ac3", ".act",
    ".adf", ".aif", ".aifc", ".aiff", ".alac", ".amr", ".ape", ".au",
    ".awb", ".caf", ".cda", ".dff", ".dsf", ".dss", ".dvf", ".flac",
    ".gbs", ".gsm", ".it", ".ivs", ".kar", ".m4a", ".m4b", ".m4p",
    ".mka", ".mmf", ".mod", ".mp2", ".mp3", ".mpc", ".mpga", ".mpu",
    ".msv", ".mus", ".oga", ".ogg", ".okt", ".opus", ".ra", ".ram",
    ".rm", ".roq", ".rso", ".s3m", ".shn", ".sid", ".snd", ".spc",
    ".spx", ".tak", ".tta", ".voc", ".vox", ".wav", ".wave", ".wma",
    ".wv", ".weba", ".xm",
]);
function audioExtension(fileName) {
    const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
    const dot = baseName.lastIndexOf(".");
    return dot > 0 ? baseName.slice(dot).toLowerCase() : "";
}
exports.audioExtension = audioExtension;
function isAudioFile(fileName, mimeType) {
    const group = mimeType?.split("/")[0];
    if (group === "video" || group === "image")
        return false;
    return group === "audio" || exports.AUDIO_EXTENSIONS.has(audioExtension(fileName));
}
exports.isAudioFile = isAudioFile;
