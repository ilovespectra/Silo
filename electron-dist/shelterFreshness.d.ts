export type ShelterFreshness = "unknown" | "green" | "yellow" | "orange" | "red" | "blinking-red";
export declare function getShelterFreshness(verifiedAt: number | null | undefined, now?: number): ShelterFreshness;
export declare function getWorstShelterFreshness(verifiedTimes: Array<number | null | undefined>, now?: number): ShelterFreshness;
export declare function formatShelterAge(verifiedAt: number | null | undefined, now?: number): string;
