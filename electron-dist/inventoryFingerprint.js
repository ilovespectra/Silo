"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryFingerprint = void 0;
const crypto_1 = require("crypto");
/** Order-independent metadata fingerprint for inventory freshness checks. */
class InventoryFingerprint {
    constructor() {
        this.xorA = 0;
        this.xorB = 0;
        this.sumA = 0;
        this.sumB = 0;
        this.count = 0;
    }
    add(relativePath, size, modified) {
        const input = `${relativePath.replace(/\\/g, "/")}\0${Math.max(0, Math.trunc(size))}\0${Math.trunc(modified)}`;
        let first = 0x811c9dc5;
        let second = 0x9e3779b9;
        for (let index = 0; index < input.length; index += 1) {
            const code = input.charCodeAt(index);
            first = Math.imul(first ^ code, 0x01000193);
            second = Math.imul(second ^ code, 0x85ebca6b);
        }
        this.xorA = (this.xorA ^ first) >>> 0;
        this.xorB = (this.xorB ^ second) >>> 0;
        this.sumA = (this.sumA + first) >>> 0;
        this.sumB = (this.sumB + second) >>> 0;
        this.count += 1;
    }
    finish() {
        return (0, crypto_1.createHash)("sha256")
            .update(`${this.count}:${this.xorA}:${this.xorB}:${this.sumA}:${this.sumB}`)
            .digest("hex");
    }
}
exports.InventoryFingerprint = InventoryFingerprint;
