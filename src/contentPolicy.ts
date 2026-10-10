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
const explicitTermPatterns = normalizedTerms.map((term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, "i");
});

export function containsExplicitTerms(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[_.\-/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return explicitTermPatterns.some((pattern) => pattern.test(normalized));
}

export function fileTextLooksExplicit(
  file: { name: string; path: string },
  metadata?: { displayName?: string; keywords?: string[] },
) {
  return containsExplicitTerms(
    [
      file.name,
      file.path,
      metadata?.displayName ?? "",
      ...(metadata?.keywords ?? []),
    ].join(" "),
  );
}

export const NSFW_VISUAL_PROMPT =
  "explicit adult sexual content, pornography, exposed genitals, graphic nudity, erotic fetish imagery";
export const SAFE_VISUAL_PROMPT =
  "safe non-explicit everyday image, fully clothed people, landscape, object, family-friendly artwork";
