export type ShelterFreshness =
  | "unknown"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "blinking-red";

const freshnessOrder: Record<ShelterFreshness, number> = {
  unknown: 0,
  green: 1,
  yellow: 2,
  orange: 3,
  red: 4,
  "blinking-red": 5,
};

export function getShelterFreshness(
  verifiedAt: number | null | undefined,
  now = Date.now(),
): ShelterFreshness {
  if (!Number.isFinite(verifiedAt) || !verifiedAt || verifiedAt > now) return "unknown";
  const age = now - verifiedAt;
  const day = 24 * 60 * 60 * 1000;
  if (age <= 7 * day) return "green";
  if (age <= 30 * day) return "yellow";
  if (age <= 183 * day) return "orange";
  if (age <= 365 * day) return "red";
  return "blinking-red";
}

export function getWorstShelterFreshness(
  verifiedTimes: Array<number | null | undefined>,
  now = Date.now(),
): ShelterFreshness {
  return verifiedTimes
    .map((verifiedAt) => getShelterFreshness(verifiedAt, now))
    .sort((left, right) => freshnessOrder[right] - freshnessOrder[left])[0] ?? "unknown";
}

export function formatShelterAge(
  verifiedAt: number | null | undefined,
  now = Date.now(),
): string {
  if (!Number.isFinite(verifiedAt) || !verifiedAt || verifiedAt > now) return "Never verified";
  const age = now - verifiedAt;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (age < minute) return "Verified just now";
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
