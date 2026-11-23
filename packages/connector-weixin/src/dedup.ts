import { ConnectorValidationError } from "@dsh-connector/core";
import { DEFAULT_DEDUP_CACHE_SIZE } from "./constants";

/**
 * Bounded FIFO set used for deterministic in-memory deduplication of WeChat `MsgId` / `message_id`
 * values and self-sent message loop prevention.
 */
export class BoundedIdSet {
  private readonly items = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_DEDUP_CACHE_SIZE) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new ConnectorValidationError("BoundedIdSet maxEntries must be a positive integer.");
    }
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    const normalized = id.trim();
    return normalized.length > 0 && this.items.has(normalized);
  }

  /**
   * Records `id` if not already present.
   * Returns `true` when newly inserted, or `false` when blank or already present.
   */
  add(id: string): boolean {
    const normalized = id.trim();
    if (normalized.length === 0 || this.items.has(normalized)) {
      return false;
    }

    if (this.items.size >= this.maxEntries) {
      const oldest = this.items.values().next();
      if (!oldest.done) {
        this.items.delete(oldest.value);
      }
    }

    this.items.add(normalized);
    return true;
  }

  clear(): void {
    this.items.clear();
  }
}
