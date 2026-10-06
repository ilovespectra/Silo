/** Common audio codecs, containers, sample formats, and tracker/module formats. */
export const AUDIO_EXTENSIONS = new Set([
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

export function audioExtension(fileName: string) {
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 ? baseName.slice(dot).toLowerCase() : "";
}

export function isAudioFile(fileName: string, mimeType?: string | null) {
  const group = mimeType?.split("/")[0];
  if (group === "video" || group === "image") return false;
  return group === "audio" || AUDIO_EXTENSIONS.has(audioExtension(fileName));
}
