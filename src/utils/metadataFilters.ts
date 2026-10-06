export type MetadataFilter = "all" | "yes" | "no";
export interface MetadataFlags {
  people: boolean;
  mapped: boolean;
}

/** Unknown is not equivalent to "no metadata". */
export function matchesMetadataFilters(
  flags: MetadataFlags | undefined,
  people: MetadataFilter,
  location: MetadataFilter,
) {
  if (people === "all" && location === "all") return true;
  if (!flags) return false;
  return (
    (people === "all" || flags.people === (people === "yes")) &&
    (location === "all" || flags.mapped === (location === "yes"))
  );
}
