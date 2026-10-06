import { createHash } from "crypto";

/** Order-independent metadata fingerprint for inventory freshness checks. */
export class InventoryFingerprint {
  private xorA = 0;
  private xorB = 0;
  private sumA = 0;
  private sumB = 0;
  private count = 0;

  add(relativePath: string, size: number, modified: number) {
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
    return createHash("sha256")
      .update(`${this.count}:${this.xorA}:${this.xorB}:${this.sumA}:${this.sumB}`)
      .digest("hex");
  }
}
