/**
 * The re-expansion half of demote-rather-than-delete: what a demoted
 * result's full text actually was, kept just long enough that asking
 * for it back is answerable, without keeping every demotion for the
 * rest of the process's life.
 *
 * A `Map` already preserves insertion order and re-inserts a re-set key
 * at the end, which is exactly least-recently-set eviction, so there is
 * no separate bookkeeping needed for which entry is oldest.
 */
export class BoundedTextCache {
	private readonly entries = new Map<string, string>();

	constructor(private readonly capacity: number) {}

	set(digest: string, text: string): void {
		this.entries.delete(digest);
		this.entries.set(digest, text);
		if (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}

	get(digest: string): string | undefined {
		return this.entries.get(digest);
	}
}
