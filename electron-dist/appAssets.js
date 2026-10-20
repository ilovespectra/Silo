"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAppAssetRequest = void 0;
const path = __importStar(require("path"));
const APP_ASSETS = {
    "countries-50m.geojson": "application/geo+json",
    "countries.geojson": "application/geo+json",
    "earth-blue-marble.jpg": "image/jpeg",
    "earth-night.jpg": "image/jpeg",
    "us-states.geojson": "application/geo+json",
};
/** Resolve only the renderer's fixed, bundled map assets. */
function resolveAppAssetRequest(requestUrl, appPath, isPackaged) {
    let request;
    try {
        request = new URL(requestUrl);
    }
    catch {
        return null;
    }
    if (request.protocol !== "silo-asset:" ||
        request.hostname !== "local" ||
        request.username ||
        request.password ||
        request.port ||
        request.search ||
        request.hash)
        return null;
    let fileName;
    try {
        fileName = decodeURIComponent(request.pathname.slice(1));
    }
    catch {
        return null;
    }
    if (!Object.prototype.hasOwnProperty.call(APP_ASSETS, fileName))
        return null;
    const contentType = APP_ASSETS[fileName];
    if (request.pathname !== `/${fileName}`)
        return null;
    return {
        filePath: path.join(appPath, isPackaged ? "build" : "public", fileName),
        contentType,
    };
}
exports.resolveAppAssetRequest = resolveAppAssetRequest;
