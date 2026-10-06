"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAFE_VISUAL_PROMPT = exports.NSFW_VISUAL_PROMPT = exports.fileTextLooksExplicit = exports.containsExplicitTerms = void 0;
const explicitTerms = [
    "nsfw",
    "porn",
    "pornographic",
    "porno",
    "xxx",
    "nudity",
    "nude",
    "nudes",
    "naked",
    "erotic",
    "erotica",
    "hentai",
    "rule 34",
    "rule34",
    "onlyfans",
    "fetish",
    "bdsm",
    "bondage",
    "sex tape",
    "sexual content",
    "explicit content",
    "adult content",
    "adult video",
    "adult image",
    "genitals",
    "genitalia",
    "penis",
    "vagina",
    "vulva",
    "clitoris",
    "erection",
    "masturbation",
    "intercourse",
    "orgasm",
    "cumshot",
    "sexting",
    "topless",
    "uncensored nude",
    "pinup nude",
];
const normalizedTerms = explicitTerms.map((term) => term.toLowerCase());
function containsExplicitTerms(value) {
    const normalized = value
        .toLowerCase()
        .replace(/[_.\-/\\]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return normalizedTerms.some((term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "i").test(normalized);
    });
}
exports.containsExplicitTerms = containsExplicitTerms;
function fileTextLooksExplicit(file, metadata) {
    return containsExplicitTerms([
        file.name,
        file.path,
        metadata?.displayName ?? "",
        ...(metadata?.keywords ?? []),
    ].join(" "));
}
exports.fileTextLooksExplicit = fileTextLooksExplicit;
exports.NSFW_VISUAL_PROMPT = "explicit adult sexual content, pornography, exposed genitals, graphic nudity, erotic fetish imagery";
exports.SAFE_VISUAL_PROMPT = "safe non-explicit everyday image, fully clothed people, landscape, object, family-friendly artwork";
