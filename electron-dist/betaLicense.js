"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyBetaActivationCode = exports.createBetaActivationCode = exports.createBetaActivationRequestMailto = exports.BETA_ACTIVATION_REQUEST_EMAIL = exports.parseBetaRequestCode = exports.createBetaRequestCode = void 0;
const crypto_1 = require("crypto");
const REQUEST_CODE_PREFIX = "SILO-BETA-REQUEST-1";
const ACTIVATION_CODE_PREFIX = "SILO-BETA-LIFETIME-1";
const INSTALLATION_ID_PATTERN = /^[a-f0-9]{32}$/;
function createBetaRequestCode(installationId) {
    if (!INSTALLATION_ID_PATTERN.test(installationId))
        throw new Error("Invalid Silo installation ID.");
    return `${REQUEST_CODE_PREFIX}.${installationId}`;
}
exports.createBetaRequestCode = createBetaRequestCode;
function parseBetaRequestCode(requestCode) {
    const match = new RegExp(`^${REQUEST_CODE_PREFIX}\\.([a-f0-9]{32})$`).exec(requestCode.trim());
    return match?.[1] ?? null;
}
exports.parseBetaRequestCode = parseBetaRequestCode;
exports.BETA_ACTIVATION_REQUEST_EMAIL = "info@balkanbiskits.si";
function createBetaActivationRequestMailto(requestCode) {
    if (!parseBetaRequestCode(requestCode))
        throw new Error("Invalid Silo beta request code.");
    const parameters = new URLSearchParams({
        subject: "Silo lifetime beta activation request",
        body: [
            "Hello,",
            "",
            "I would like to request a free lifetime beta activation for this Silo installation.",
            "",
            `Silo beta request code: ${requestCode}`,
            "",
            "Thank you.",
        ].join("\n"),
    });
    return `mailto:${exports.BETA_ACTIVATION_REQUEST_EMAIL}?${parameters.toString()}`;
}
exports.createBetaActivationRequestMailto = createBetaActivationRequestMailto;
function createBetaActivationCode(requestCode, privateKeyPem, issuedAt = Date.now()) {
    const installationId = parseBetaRequestCode(requestCode);
    if (!installationId)
        throw new Error("Invalid Silo beta request code.");
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 1)
        throw new Error("Invalid beta grant timestamp.");
    const payload = {
        version: 1,
        product: "silo",
        grant: "lifetime-beta",
        installationId,
        issuedAt,
    };
    const payloadText = JSON.stringify(payload);
    const signature = (0, crypto_1.sign)(null, Buffer.from(payloadText, "utf8"), privateKeyPem);
    return [
        ACTIVATION_CODE_PREFIX,
        Buffer.from(payloadText, "utf8").toString("base64url"),
        signature.toString("base64url"),
    ].join(".");
}
exports.createBetaActivationCode = createBetaActivationCode;
function verifyBetaActivationCode(activationCode, publicKeyPem, expectedInstallationId) {
    if (!publicKeyPem.trim() ||
        !INSTALLATION_ID_PATTERN.test(expectedInstallationId) ||
        activationCode.length > 4096)
        return null;
    const [prefix, encodedPayload, encodedSignature, ...extra] = activationCode.trim().split(".");
    if (prefix !== ACTIVATION_CODE_PREFIX ||
        !encodedPayload ||
        !encodedSignature ||
        extra.length > 0 ||
        !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
        !/^[A-Za-z0-9_-]+$/.test(encodedSignature))
        return null;
    try {
        const payloadBytes = Buffer.from(encodedPayload, "base64url");
        const signature = Buffer.from(encodedSignature, "base64url");
        if (payloadBytes.toString("base64url") !== encodedPayload ||
            signature.toString("base64url") !== encodedSignature)
            return null;
        const payloadText = payloadBytes.toString("utf8");
        const value = JSON.parse(payloadText);
        if (typeof value !== "object" ||
            value === null ||
            Array.isArray(value))
            return null;
        const payload = value;
        if (Object.keys(value).length !== 5 ||
            payload.version !== 1 ||
            payload.product !== "silo" ||
            payload.grant !== "lifetime-beta" ||
            payload.installationId !== expectedInstallationId ||
            !Number.isSafeInteger(payload.issuedAt) ||
            (payload.issuedAt ?? 0) < 1 ||
            JSON.stringify(payload) !== payloadText ||
            !(0, crypto_1.verify)(null, payloadBytes, publicKeyPem, signature))
            return null;
        return payload;
    }
    catch {
        return null;
    }
}
exports.verifyBetaActivationCode = verifyBetaActivationCode;
