/** Short lived, read-only cache shared by pages, including concurrent requests. */
export class RequestCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  private pending = new Map<string, Promise<T>>();
  constructor(private readonly ttl: number, private readonly capacity = 100) {}

  peek(key: string, allowExpired = false): T | undefined {
    const entry = this.entries.get(key);
    return entry && (allowExpired || entry.expires > Date.now()) ? entry.value : undefined;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.pending.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }

  load(key: string, fetch: () => Promise<T>): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = fetch().then((value) => {
      // An invalidated request may finish, but must not replace the newer value.
      if (this.pending.get(key) === request) {
        this.entries.delete(key);
        this.entries.set(key, { value, expires: Date.now() + this.ttl });
        if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }
}
