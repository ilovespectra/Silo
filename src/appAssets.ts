import * as path from "path";

const APP_ASSETS: Record<string, string> = {
  "countries-50m.geojson": "application/geo+json",
  "countries.geojson": "application/geo+json",
  "earth-blue-marble.jpg": "image/jpeg",
  "earth-night.jpg": "image/jpeg",
  "us-states.geojson": "application/geo+json",
};

export interface ResolvedAppAsset {
  filePath: string;
  contentType: string;
}

/** Resolve only the renderer's fixed, bundled map assets. */
export function resolveAppAssetRequest(
  requestUrl: string,
  appPath: string,
  isPackaged: boolean,
): ResolvedAppAsset | null {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    request.protocol !== "silo-asset:" ||
    request.hostname !== "local" ||
    request.username ||
    request.password ||
    request.port ||
    request.search ||
    request.hash
  )
    return null;

  let fileName: string;
  try {
    fileName = decodeURIComponent(request.pathname.slice(1));
  } catch {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(APP_ASSETS, fileName)) return null;
  const contentType = APP_ASSETS[fileName];
  if (request.pathname !== `/${fileName}`) return null;

  return {
    filePath: path.join(appPath, isPackaged ? "build" : "public", fileName),
    contentType,
  };
}
