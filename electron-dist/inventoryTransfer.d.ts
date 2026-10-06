export interface InventoryReference {
    inventoryToken: string;
    total: number;
}
/** Keeps large arrays out of Electron's native value serializer. */
export declare class InventoryTransfers {
    private now;
    private entries;
    constructor(now?: () => number);
    create(files: unknown[], owner: number): InventoryReference;
    read(token: string, offset: number, owner: number): {
        items: unknown[];
        nextOffset: number;
        done: boolean;
    };
    release(token: string, owner: number): void;
    releaseOwner(owner: number): void;
    expire(): void;
}
