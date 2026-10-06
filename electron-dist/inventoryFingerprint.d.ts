/** Order-independent metadata fingerprint for inventory freshness checks. */
export declare class InventoryFingerprint {
    private xorA;
    private xorB;
    private sumA;
    private sumB;
    private count;
    add(relativePath: string, size: number, modified: number): void;
    finish(): string;
}
