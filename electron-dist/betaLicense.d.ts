export interface BetaActivationPayload {
    version: 1;
    product: "silo";
    grant: "lifetime-beta";
    installationId: string;
    issuedAt: number;
}
export interface BetaActivationInfo {
    requestCode: string;
    requestEmail: string;
    available: boolean;
}
export interface BetaActivationResult {
    status: "activated" | "invalid" | "unavailable" | "already-licensed" | "error";
    message: string;
    license?: {
        isLicensed: boolean;
        licenseType?: "beta" | "purchase";
        signature?: string;
        verifiedAt?: number;
    };
}
export declare function createBetaRequestCode(installationId: string): string;
export declare function parseBetaRequestCode(requestCode: string): string | null;
export declare const BETA_ACTIVATION_REQUEST_EMAIL = "info@balkanbiskits.si";
export declare function createBetaActivationRequestMailto(requestCode: string): string;
export declare function createBetaActivationCode(requestCode: string, privateKeyPem: string, issuedAt?: number): string;
export declare function verifyBetaActivationCode(activationCode: string, publicKeyPem: string, expectedInstallationId: string): BetaActivationPayload | null;
