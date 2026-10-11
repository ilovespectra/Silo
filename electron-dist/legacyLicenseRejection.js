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
exports.persistLegacyLicenseRejection = exports.isLegacyLicenseRejected = void 0;
const crypto_1 = require("crypto");
const fsPromises = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
function signatureHash(signature) {
    return (0, crypto_1.createHash)("sha256").update(signature, "utf8").digest("hex");
}
async function isLegacyLicenseRejected(statePath, signature) {
    let raw;
    try {
        raw = await fsPromises.readFile(statePath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
    const saved = JSON.parse(raw);
    if (saved.version !== 1 ||
        typeof saved.signatureSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(saved.signatureSha256) ||
        typeof saved.rejectedAt !== "number" ||
        !Number.isFinite(saved.rejectedAt))
        throw new Error("The saved lifetime-license rejection state is invalid.");
    return saved.signatureSha256 === signatureHash(signature);
}
exports.isLegacyLicenseRejected = isLegacyLicenseRejected;
async function persistLegacyLicenseRejection(statePath, signature, rejectedAt = Date.now()) {
    await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    const rejection = {
        version: 1,
        signatureSha256: signatureHash(signature),
        rejectedAt,
    };
    await fsPromises.writeFile(temporaryPath, JSON.stringify(rejection, null, 2), {
        encoding: "utf8",
        mode: 0o600,
    });
    await fsPromises.rename(temporaryPath, statePath);
}
exports.persistLegacyLicenseRejection = persistLegacyLicenseRejection;
