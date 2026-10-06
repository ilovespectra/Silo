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
exports.openIndexedShareFile = void 0;
const fs = __importStar(require("fs"));
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
async function openIndexedShareFile(sourcePath, canonicalSourcePath, file, expectedRoot) {
    if (!file ||
        typeof file.path !== "string" ||
        typeof file.relativePath !== "string" ||
        !file.relativePath ||
        path.isAbsolute(file.relativePath) ||
        file.relativePath.split(path.sep).some((part) => part === "..") ||
        file.relativePath.includes("\0") ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !Number.isFinite(file.modified))
        throw new Error("Indexed item is not a safe relative file.");
    const liveSourcePath = await fsPromises.realpath(sourcePath);
    if (path.resolve(liveSourcePath) !== path.resolve(canonicalSourcePath))
        throw new Error("The selected source is no longer mounted at its indexed location.");
    if (expectedRoot) {
        const liveRootStat = await fsPromises.stat(liveSourcePath);
        if (liveRootStat.dev !== expectedRoot.device || liveRootStat.ino !== expectedRoot.inode)
            throw new Error("A different volume is mounted at the selected source location.");
    }
    const lexicalRoot = path.resolve(sourcePath);
    const candidatePath = path.resolve(lexicalRoot, file.relativePath);
    if (!isWithin(lexicalRoot, candidatePath) ||
        path.resolve(file.path) !== candidatePath)
        throw new Error("Indexed item does not belong to the selected source.");
    const resolvedPath = await fsPromises.realpath(candidatePath);
    if (!isWithin(canonicalSourcePath, resolvedPath))
        throw new Error("Indexed item resolves outside the selected source.");
    const pathStat = await fsPromises.stat(resolvedPath);
    if (!pathStat.isFile())
        throw new Error("Indexed item is not a regular file.");
    if (pathStat.size !== file.size ||
        Math.abs(pathStat.mtimeMs - file.modified) > 1)
        throw new Error("Indexed item changed since Silo last indexed it.");
    const handle = await fsPromises.open(resolvedPath, fs.constants.O_RDONLY);
    try {
        const handleStat = await handle.stat();
        const currentPath = await fsPromises.realpath(candidatePath);
        const currentPathStat = await fsPromises.stat(currentPath);
        if (!isWithin(canonicalSourcePath, currentPath) ||
            handleStat.dev !== currentPathStat.dev ||
            handleStat.ino !== currentPathStat.ino ||
            !handleStat.isFile() ||
            handleStat.size !== file.size ||
            Math.abs(handleStat.mtimeMs - file.modified) > 1)
            throw new Error("Indexed item changed while it was being opened.");
        return {
            path: resolvedPath,
            handle,
            size: handleStat.size,
            modified: handleStat.mtimeMs,
        };
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}
exports.openIndexedShareFile = openIndexedShareFile;
