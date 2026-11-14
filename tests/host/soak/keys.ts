/**
 * Each hosted key beside plain pi's same one: plain pi's key timed from
 * its prompt's sending to its entry, the same entry a hosted key is
 * timed to, and the steady keys paired, each conversation's first apart
 * from the rest, to tell what the host adds to a key from what pi itself
 * spends.
 */
import {
	type Extent,
	extentOf,
	type Spread,
	spreadOf,
	type TurnRecord,
	type TurnTime,
} from "./report.ts";

/**
 * Plain pi's key for each turn it was sent, by tag: from the prompt's
 * sending to its entry, the same entry a hosted key is timed to, so a
 * hosted key pairs with plain pi's own. Plain pi has no screen, so this
 * is all of a key it can be timed for.
 */
export function plainKeys(
	turns: readonly TurnTime[],
	sent: ReadonlyMap<string, number>,
): Map<string, number> {
	return new Map(
		turns.flatMap(({ tag, promptAt }) => {
			const at = sent.get(tag);
			return at === undefined ? [] : [[tag, promptAt - at]];
		}),
	);
}

/** What hosted cost over plain pi, with its largest, and how many didn't pair. */
export interface PairedExtent extends Extent {
	readonly unpaired: number;
}

/** Keys hosted and plain, and what each hosted one cost over plain pi's same key. */
export interface KeysPaired {
	readonly hosted: Spread;
	readonly plain: Spread;
	/** Hosted's key to its log less plain pi's. */
	readonly paired: PairedExtent;
	/** Hosted's key to its first drawing. */
	readonly drawn: Spread;
	/**
	 * Hosted's key to its first drawing less plain pi's key to its log,
	 * plain pi having no screen, over the keys seen drawn.
	 */
	readonly drawnPaired: PairedExtent;
}

/**
 * The keys outside a wake or a burst, each conversation's first apart
 * from the rest, since a first prompt runs work later ones don't, and
 * each paired against plain pi's same key, to tell what the host adds
 * from what pi itself spends.
 */
export interface KeyPairing {
	readonly first: KeysPaired;
	readonly later: KeysPaired;
}

/** Whether `tag` is a conversation's first turn. */
function isFirst(tag: string): boolean {
	return tag.endsWith("-t0");
}

/** The steady keys of `records`, first and later apart, each paired with plain pi's. */
export function pairKeys(records: readonly TurnRecord[]): KeyPairing {
	const steady = records.filter(
		(one) =>
			one.keyToAcceptedMs !== undefined &&
			one.woke === undefined &&
			one.burst === undefined,
	);
	const over = (
		some: readonly TurnRecord[],
		hostedOf: (one: TurnRecord) => number | undefined,
	): PairedExtent => {
		const costs = some.flatMap((one) => {
			const hosted = hostedOf(one);
			return hosted === undefined || one.plainKeyToAcceptedMs === undefined
				? []
				: [hosted - one.plainKeyToAcceptedMs];
		});
		return { ...extentOf(costs), unpaired: some.length - costs.length };
	};
	const of = (some: readonly TurnRecord[]): KeysPaired => {
		const shown = some.filter((one) => one.keyToDrawnMs !== undefined);
		return {
			hosted: spreadOf(some.flatMap((one) => one.keyToAcceptedMs ?? [])),
			plain: spreadOf(some.flatMap((one) => one.plainKeyToAcceptedMs ?? [])),
			paired: over(some, (one) => one.keyToAcceptedMs),
			drawn: spreadOf(shown.flatMap((one) => one.keyToDrawnMs ?? [])),
			drawnPaired: over(shown, (one) => one.keyToDrawnMs),
		};
	};
	return {
		first: of(steady.filter((one) => isFirst(one.tag))),
		later: of(steady.filter((one) => !isFirst(one.tag))),
	};
}
