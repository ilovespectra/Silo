export interface IdentifiedSource {
  id: string;
}

/** Keep optimistic choices visible while an authoritative source refresh is in flight. */
export function reconcilePendingSourceToggles<T extends IdentifiedSource>(
  authoritative: readonly T[],
  current: readonly T[],
  pending: ReadonlyMap<string, unknown>,
  authoritativeIds: ReadonlySet<string> = new Set(),
): T[] {
  const currentById = new Map(current.map((source) => [source.id, source]));
  return authoritative.map((source) =>
    pending.has(source.id) && !authoritativeIds.has(source.id)
      ? currentById.get(source.id) ?? source
      : source,
  );
}
