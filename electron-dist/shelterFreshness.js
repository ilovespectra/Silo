"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatShelterAge = exports.getWorstShelterFreshness = exports.getShelterFreshness = void 0;
const freshnessOrder = {
    unknown: 0,
    green: 1,
    yellow: 2,
    orange: 3,
    red: 4,
    "blinking-red": 5,
};
function getShelterFreshness(verifiedAt, now = Date.now()) {
    if (!Number.isFinite(verifiedAt) || !verifiedAt || verifiedAt > now)
        return "unknown";
    const age = now - verifiedAt;
    const day = 24 * 60 * 60 * 1000;
    if (age <= 7 * day)
        return "green";
    if (age <= 30 * day)
        return "yellow";
    if (age <= 183 * day)
        return "orange";
    if (age <= 365 * day)
        return "red";
    return "blinking-red";
}
exports.getShelterFreshness = getShelterFreshness;
function getWorstShelterFreshness(verifiedTimes, now = Date.now()) {
    return verifiedTimes
        .map((verifiedAt) => getShelterFreshness(verifiedAt, now))
        .sort((left, right) => freshnessOrder[right] - freshnessOrder[left])[0] ?? "unknown";
}
exports.getWorstShelterFreshness = getWorstShelterFreshness;
function formatShelterAge(verifiedAt, now = Date.now()) {
    if (!Number.isFinite(verifiedAt) || !verifiedAt || verifiedAt > now)
        return "Never verified";
    const age = now - verifiedAt;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (age < minute)
        return "Verified just now";
    if (age < hour) {
        const minutes = Math.floor(age / minute);
        return `Verified ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    if (age < day) {
        const hours = Math.floor(age / hour);
        return `Verified ${hours} hour${hours === 1 ? "" : "s"} ago`;
    }
    const days = Math.floor(age / day);
    return `Verified ${days} day${days === 1 ? "" : "s"} ago`;
}
exports.formatShelterAge = formatShelterAge;
