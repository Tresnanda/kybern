/** Session-local snapshots: stale content stays readable until refresh succeeds. */
export class ThreadCache<T> extends Map<string, T> {
  private stale = new Map<string, number>();
  private epoch = 0;
  private replay: Map<string, string> | null = null;

  /** Retain only snapshots that were complete before delivery was interrupted. */
  beginReplay() {
    if (this.replay) return;
    const fresh = [...this.keys()].filter((id) => !this.isStale(id));
    this.invalidateAll();
    this.replay = new Map(fresh.map((id) => [id, this.revision(id)]));
  }

  canReplay(id: string) {
    return this.has(id) && this.replay?.get(id) === this.revision(id);
  }

  finishReplay() {
    for (const [id, revision] of this.replay ?? [])
      if (this.has(id)) this.markFresh(id, revision);
    this.replay = null;
  }

  cancelReplay() {
    this.replay = null;
  }

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
    this.replay?.delete(id);
    this.stale.delete(id);
    return super.delete(id);
  }

  override clear() {
    this.replay = null;
    this.epoch++;
    this.stale.clear();
    super.clear();
  }
}
