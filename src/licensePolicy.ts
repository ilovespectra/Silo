export function parseVersionParts(value: string): number[] {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return [];
  const digits = trimmed
    .replace(/^v/i, "")
    .split(/[^0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));
  return digits.filter((part) => Number.isFinite(part));
}

export function isVersionAtLeast(version: string, minimumVersion: string): boolean {
  const current = parseVersionParts(version);
  const minimum = parseVersionParts(minimumVersion);
  const maxLength = Math.max(current.length, minimum.length);
  for (let index = 0; index < maxLength; index += 1) {
    const currentPart = current[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (currentPart !== minimumPart) return currentPart > minimumPart;
  }
  return true;
}

export function resolveMinimumLicenseBuildVersion(fallbackVersion = "0.0.0"): string {
  const configured = (
    process.env.SILO_MINIMUM_LICENSE_BUILD_VERSION ||
    process.env.SILO_MINIMUM_BUILD_VERSION ||
    process.env.SILO_MINIMUM_APP_VERSION ||
    ""
  ).trim();
  return configured || fallbackVersion;
}

export function isBuildBlockedByReleaseCutoff(
  currentVersion: string,
  minimumVersion = resolveMinimumLicenseBuildVersion(currentVersion),
): boolean {
  return !isVersionAtLeast(currentVersion, minimumVersion);
}
