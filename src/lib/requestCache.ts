/** Short lived, read-only cache shared by pages, including concurrent requests. */
export class RequestCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  private pending = new Map<string, Promise<T>>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private listening = false;
  private readonly release = () => this.clear();
  constructor(private readonly ttl: number, private readonly capacity = 100) {}

  peek(key: string, allowExpired = false): T | undefined {
    const entry = this.entries.get(key);
    return entry && (allowExpired || entry.expires > Date.now()) ? entry.value : undefined;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.pending.delete(key);
    this.scheduleExpiry();
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
    this.scheduleExpiry();
  }

  load(key: string, fetch: () => Promise<T>): Promise<T> {
    this.prune();
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
        this.scheduleExpiry();
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (typeof window !== "undefined") {
      if (this.entries.size && !this.listening) {
        window.addEventListener("slh-release-scenes", this.release);
        this.listening = true;
      } else if (!this.entries.size && this.listening) {
        window.removeEventListener("slh-release-scenes", this.release);
        this.listening = false;
      }
    }
    if (!this.entries.size) return;
    const expires = Math.min(...Array.from(this.entries.values(), entry => entry.expires));
    this.expiryTimer = setTimeout(() => { this.prune(); this.scheduleExpiry(); }, Math.max(1, expires - Date.now()));
  }
}
