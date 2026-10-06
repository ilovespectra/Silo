/// <reference types="node" />
import * as fsPromises from "fs/promises";
export interface IndexedShareFile {
    name: string;
    path: string;
    relativePath: string;
    size: number;
    modified: number;
    type: string;
    extension: string;
}
export interface OpenedIndexedShareFile {
    path: string;
    handle: fsPromises.FileHandle;
    size: number;
    modified: number;
}
export interface IndexedShareRootIdentity {
    device: number;
    inode: number;
}
export declare function openIndexedShareFile(sourcePath: string, canonicalSourcePath: string, file: IndexedShareFile, expectedRoot?: IndexedShareRootIdentity): Promise<OpenedIndexedShareFile>;
