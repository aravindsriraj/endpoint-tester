/** Shared singleton cache for resolved path parameter values.
 * All endpoint agents share this cache so that e.g. a messageId fetched by
 * GMAIL_GET_MESSAGE is reused by GMAIL_TRASH_MESSAGE without a duplicate list call.
 * Thread-safe in Node/Bun single-threaded event loop.
 */
export class IdCache {
  private cache = new Map<string, string>();

  get(paramName: string): string | undefined {
    return this.cache.get(paramName);
  }

  set(paramName: string, value: string): void {
    this.cache.set(paramName, value);
  }

  has(paramName: string): boolean {
    return this.cache.has(paramName);
  }
}

export const idCache = new IdCache();
