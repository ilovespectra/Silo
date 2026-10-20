export interface ResolvedAppAsset {
    filePath: string;
    contentType: string;
}
/** Resolve only the renderer's fixed, bundled map assets. */
export declare function resolveAppAssetRequest(requestUrl: string, appPath: string, isPackaged: boolean): ResolvedAppAsset | null;
