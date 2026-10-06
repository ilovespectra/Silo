export interface AudioSort {
  field: "name" | "modified" | "size" | "type" | "source";
  ascending: boolean;
}

interface AudioSortFile {
  name: string;
  path: string;
  modified: number;
  size: number;
  extension: string;
  sourceLabel?: string;
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareAudioFiles(
  first: AudioSortFile,
  second: AudioSortFile,
  sort: AudioSort,
) {
  let comparison = 0;
  switch (sort.field) {
    case "modified":
      comparison = first.modified - second.modified;
      break;
    case "size":
      comparison = first.size - second.size;
      break;
    case "type":
      comparison = collator.compare(first.extension, second.extension);
      break;
    case "source":
      comparison = collator.compare(
        first.sourceLabel || "",
        second.sourceLabel || "",
      );
      break;
    default:
      comparison = collator.compare(first.name, second.name);
  }
  return (
    comparison * (sort.ascending ? 1 : -1) ||
    collator.compare(first.name, second.name) ||
    first.path.localeCompare(second.path)
  );
}
