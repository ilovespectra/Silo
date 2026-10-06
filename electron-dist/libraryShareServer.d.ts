/// <reference types="node" />
/// <reference types="node" />
import { IndexedShareFile } from "./indexedShareResolver";
export interface LibraryShareSource {
    id: string;
    label: string;
    rootPath: string;
    kind: string;
    available: boolean;
}
interface ShareNetworkInterface {
    address: string;
    netmask: string;
}
export interface LibraryShareServerOptions {
    getSources(): Promise<LibraryShareSource[]>;
    getIndexedFiles(sourceRoots: string[]): IndexedShareFile[];
    search(query: string, sourceRoots: string[]): Promise<IndexedShareFile[]>;
    getThumbnail(filePath: string): Promise<Buffer | null>;
    networkInterface?: ShareNetworkInterface;
}
export interface LibraryShareStatus {
    active: boolean;
    url?: string;
    sources: Array<{
        id: string;
        label: string;
    }>;
}
export declare class LibraryShareServer {
    private readonly options;
    private context;
    constructor(options: LibraryShareServerOptions);
    getStatus(): LibraryShareStatus;
    start(selectedSourceIds: string[]): Promise<LibraryShareStatus>;
    stop(): Promise<void>;
    private currentSources;
    private currentFiles;
    private findItem;
    private handleRequest;
    private safeEqualToken;
    private sendSources;
    private sendItems;
    private publicItem;
    private sendThumbnail;
    private sendMedia;
    private sendArchive;
}
export declare function isValidShareSubnet(address: string, network: ShareNetworkInterface): boolean;
export {};
