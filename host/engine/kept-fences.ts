/**
 * The fences each conversation's holds were told before they ended, as a
 * park ends one while its `&` commands run on, dated by the latest end.
 * They count again once the conversation is held again, for the day a
 * park's notes spare what it kept (left-running.ts), and then go. A close
 * for good keeps them too, since its reap can fail or miss a command
 * that cleared its marker, and reading loose costs only a refused carry.
 * The notes outlive a restart and these don't, so an earlier host's
 * count as unfenced for the rest of their day (before). SessionHost reads
 * them (session-host.ts).
 */
import type { FenceKind } from "../../lib/mesh/presence.ts";
import { STRAY_FOR_MS } from "./carried-shells.ts";

/** How tight each fence holds a session's tools. */
const TIGHTNESS: Readonly<Record<FenceKind, number>> = {
	none: 0,
	fence: 1,
	strict: 2,
};

/** The looser of two fences, where an unsaid one is no fence yet. */
export function loosest(
	kept: FenceKind | undefined,
	told: FenceKind | undefined,
): FenceKind | undefined {
	if (kept === undefined) return told;
	if (told === undefined) return kept;
	return TIGHTNESS[told] < TIGHTNESS[kept] ? told : kept;
}

/**
 * How long a kept fence counts: a park's day, and ten minutes more. The
 * park's notes are written before its fence is dated, so the day alone
 * outlasts them; the ten minutes are slack for the reap, which reads its
 * own clock apart from the hold that reads this.
 */
export const KEPT_FOR_MS = STRAY_FOR_MS + 10 * 60_000;

type Kept = { readonly fence: FenceKind; readonly at: number };

/** What each conversation's parks left running under, each kept for its day. */
export class KeptFences {
	private readonly kept = new Map<string, readonly Kept[]>();

	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/**
	 * Keep the fence `id`'s hold was told, if it was told one, for what
	 * it left running, and each fence an earlier hold or host left that is still within its
	 * day, all dated now: this end's notes name every process still
	 * carrying the conversation's marker, whichever hold started it, so
	 * each gets a new day to be spared (left-running.ts), and so must the
	 * fence it ran under.
	 */
	keep(id: string, fence: FenceKind | undefined): void {
		for (const each of [...this.kept.keys()]) this.live(each);
		const fences = new Set((this.kept.get(id) ?? []).map((left) => left.fence));
		if (fence) fences.add(fence);
		if (fences.size === 0) return;
		const at = this.now();
		this.kept.set(
			id,
			[...fences].map((each) => ({ fence: each, at })),
		);
	}

	/** The loosest fence `id` left running within its day, if any. */
	fenceOf(id: string): FenceKind | undefined {
		return this.live(id).reduce<FenceKind | undefined>(
			(found, left) => loosest(found, left.fence),
			undefined,
		);
	}

	/**
	 * Count what `from` left running as `to`'s too, each on its own day,
	 * as pi replaces one conversation with another.
	 */
	inherit(from: string, to: string): void {
		const left = this.live(from);
		if (left.length === 0) return;
		this.kept.set(to, [...this.live(to), ...left]);
	}

	/**
	 * What an earlier host's parks kept running, or its restart carried,
	 * by when each session's was noted (left-running.ts, carried-shells.ts):
	 * the notes outlive a restart, but the fence each ran under doesn't, so
	 * until the latest one's day ends each counts as unfenced, the loosest
	 * it could have been.
	 */
	before(noted: ReadonlyMap<string, number>): void {
		for (const [id, at] of noted) {
			const earlier = this.kept.get(id) ?? [];
			const unfenced = earlier.find((left) => left.fence === "none");
			const latest = Math.max(at, unfenced?.at ?? at);
			this.kept.set(id, [
				...earlier.filter((left) => left.fence !== "none"),
				{ fence: "none", at: latest },
			]);
		}
	}

	/** Each conversation counted as unfenced, and when that ends. */
	unfencedUntil(): ReadonlyMap<string, number> {
		const until = new Map<string, number>();
		for (const id of [...this.kept.keys()]) {
			const unfenced = this.live(id).find((left) => left.fence === "none");
			if (unfenced) until.set(id, unfenced.at + KEPT_FOR_MS);
		}
		return until;
	}

	/** `id`'s fences still within their day, forgetting the rest. */
	private live(id: string): readonly Kept[] {
		const now = this.now();
		const left = (this.kept.get(id) ?? []).filter(
			(each) => now - each.at < KEPT_FOR_MS,
		);
		if (left.length > 0) this.kept.set(id, left);
		else this.kept.delete(id);
		return left;
	}
}
