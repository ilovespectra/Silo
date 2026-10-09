export declare const LIFETIME_PAYMENT_ADDRESS = "89Y6dpvpfTCBZjw2Xcb3KVVFTebdbGpzWTNEPMWEuMyu";
export declare const LIFETIME_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export declare const LIFETIME_PAYMENT_MICRO_USDC = 25000000n;
export declare const LIFETIME_CARD_PAYMENT_MINIMUM_MICRO_USDC = 23750000n;
export declare function encodeSolanaPayReference(bytes: Uint8Array): string;
export declare function isSolanaPayReference(value: string): boolean;
export declare function createLifetimeSolanaPayUri(reference: string): string;
export type LifetimePaymentStatus = "verified" | "pending" | "invalid" | "error" | "already-licensed";
export interface LifetimeLicenseState {
    isLicensed: boolean;
    licenseType?: "purchase" | "beta";
    signature?: string;
    verifiedAt?: number;
}
export interface LifetimePaymentVerification {
    status: LifetimePaymentStatus;
    message: string;
    license?: LifetimeLicenseState;
}
export declare function isSolanaTransactionSignature(value: string): boolean;
export declare function verifyParsedLifetimePayment(signature: string, rpcResponse: unknown, minimumPaymentMicroUsdc?: bigint): LifetimePaymentVerification;
