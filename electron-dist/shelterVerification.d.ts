export { getShelterFreshness } from "./shelterFreshness";
export type { ShelterFreshness } from "./shelterFreshness";
export interface ShelterSourceFile {
    relativePath: string;
    localPath: string;
}
export interface ShelterVerificationResult {
    verified: boolean;
    verifiedFiles: number;
    totalFiles: number;
    missingFiles: number;
    changedFiles: number;
    extraFiles: number;
    error?: string;
}
interface CloneManifest {
    format?: unknown;
    version?: unknown;
    complete?: unknown;
    files?: unknown;
    aliases?: unknown;
}
export declare function readShelterCloneManifest(clonePath: string): Promise<CloneManifest>;
export declare function verifyShelterCloneSource(clonePath: string, sourceId: string, sourceFiles: ShelterSourceFile[]): Promise<ShelterVerificationResult>;
