"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMemoryDurationAllowed = exports.getDefaultMemoryDuration = exports.getMemoryDurationBounds = exports.selectMemoryPhotoCandidates = exports.MEMORY_MAGIC_SCORE_THRESHOLD = exports.MEMORY_DEFAULT_SELECTION_COUNT = exports.MEMORY_EXPORT_LIMITS = exports.MEMORY_DURATION_SECONDS = void 0;
exports.MEMORY_DURATION_SECONDS = 60;
exports.MEMORY_EXPORT_LIMITS = { minCount: 1, maxCount: 24, minDuration: exports.MEMORY_DURATION_SECONDS, maxDuration: exports.MEMORY_DURATION_SECONDS };
exports.MEMORY_DEFAULT_SELECTION_COUNT = 20;
exports.MEMORY_MAGIC_SCORE_THRESHOLD = 90;
function selectMemoryPhotoCandidates(candidates) {
    const ranked = candidates.slice().sort((first, second) => {
        const firstMagic = typeof first.magicScore === "number" && Number.isFinite(first.magicScore) ? first.magicScore : -1;
        const secondMagic = typeof second.magicScore === "number" && Number.isFinite(second.magicScore) ? second.magicScore : -1;
        return secondMagic - firstMagic || second.score - first.score;
    });
    const preferred = ranked.filter((candidate) => candidate.magicScore !== undefined &&
        Number.isFinite(candidate.magicScore) && candidate.magicScore >= exports.MEMORY_MAGIC_SCORE_THRESHOLD);
    const fallback = ranked.filter((candidate) => !preferred.includes(candidate));
    const target = Math.min(exports.MEMORY_EXPORT_LIMITS.maxCount, Math.max(exports.MEMORY_DEFAULT_SELECTION_COUNT, preferred.length));
    return [...preferred, ...fallback].slice(0, target);
}
exports.selectMemoryPhotoCandidates = selectMemoryPhotoCandidates;
function getMemoryDurationBounds(_count) {
    return { min: exports.MEMORY_DURATION_SECONDS, max: exports.MEMORY_DURATION_SECONDS };
}
exports.getMemoryDurationBounds = getMemoryDurationBounds;
function getDefaultMemoryDuration(_count) {
    return exports.MEMORY_DURATION_SECONDS;
}
exports.getDefaultMemoryDuration = getDefaultMemoryDuration;
function isMemoryDurationAllowed(_count, duration) {
    return Number.isFinite(duration) && duration === exports.MEMORY_DURATION_SECONDS;
}
exports.isMemoryDurationAllowed = isMemoryDurationAllowed;
