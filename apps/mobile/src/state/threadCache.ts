/** Session-local snapshots: stale content stays readable until refresh succeeds. */
export class ThreadCache<T> extends Map<string, T> {
  private stale = new Map<string, number>();
  private epoch = 0;

  touch(id: string) {
    if (!this.has(id)) return;
    const value = this.get(id)!;
    super.delete(id);
    super.set(id, value);
  }

  invalidate(id: string) {
    if (this.has(id)) this.stale.set(id, (this.stale.get(id) ?? 0) + 1);
  }

  invalidateAll() {
    this.epoch++;
    for (const id of this.keys()) this.invalidate(id);
  }

  revision(id: string) {
    return `${this.epoch}:${this.stale.get(id) ?? 0}`;
  }

  isStale(id: string) {
    return this.stale.has(id);
  }

  markFresh(id: string, revision: string) {
    if (this.revision(id) !== revision) {
      // A disconnect during an initial load also invalidates its result.
      if (!this.isStale(id)) this.invalidate(id);
      return false;
    }
    this.stale.delete(id);
    return true;
  }

  trim(limit: number, protectedId: (id: string) => boolean) {
    for (const id of this.keys()) {
      if (this.size <= limit) break;
      if (!protectedId(id)) this.delete(id);
    }
  }

  override delete(id: string) {
    this.stale.delete(id);
    return super.delete(id);
  }

  override clear() {
    this.epoch++;
    this.stale.clear();
    super.clear();
  }
}
