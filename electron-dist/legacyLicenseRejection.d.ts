export declare function isLegacyLicenseRejected(statePath: string, signature: string): Promise<boolean>;
export declare function persistLegacyLicenseRejection(statePath: string, signature: string, rejectedAt?: number): Promise<void>;
