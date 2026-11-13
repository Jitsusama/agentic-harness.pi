/**
 * How long the soak's model takes over an answer, at a pace taken from real
 * sessions rather than at once: each answer's time is drawn from a spread
 * through a median and a 90th percentile, keyed by what it answers, so the
 * same answer takes the same time on either side and in every run, and its
 * words arrive in pieces across that time, as a real model streams them.
 */

/** A spread of times: its median and its 90th percentile, in ms. */
export interface TimeSpread {
	readonly p50: number;
	readonly p90: number;
}

/** How a streamed answer's pieces are spaced, as a model's deltas are. */
export const PIECE_EVERY_MS = 50;

/**
 * The longest a time is drawn to be. A tool turn's two answers and its
 * tool then take at most 135 s, inside plain pi's 180 s wait for an event;
 * a week's answers took longer about one time in fifteen.
 */
export const LONGEST_MS = 45_000;

/** The standard normal's 90th percentile, which fixes a spread's width. */
const Z_90 = 1.2815515655446004;

/** Read `P50[,P90]` in ms, or nothing when it isn't given. */
export function paceOf(text: string | undefined): TimeSpread | undefined {
	if (text === undefined || text === "") return undefined;
	const [p50, p90 = p50] = text.split(",").map(Number);
	if (!(p50 > 0) || !(p90 >= p50))
		throw new Error(
			`a pace is P50[,P90] in ms, P50 above 0 and P90 at least P50: ${text}`,
		);
	return { p50, p90 };
}

/**
 * The time drawn from `spread` for `key`, the same for the same key every
 * run: log-normal, as answer times are, through the spread's percentiles.
 */
export function drawn(spread: TimeSpread, key: string): number {
	const sigma = Math.log(spread.p90 / spread.p50) / Z_90;
	const time = spread.p50 * Math.exp(sigma * normal(hashOf(key)));
	return Math.min(LONGEST_MS, Math.round(time));
}

/** FNV-1a's 32-bit offset basis and prime. */
const FNV_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** A 32-bit FNV-1a hash of `key`'s UTF-16 code units. */
function hashOf(key: string): number {
	let hash = FNV_BASIS;
	for (let at = 0; at < key.length; at += 1)
		hash = Math.imul(hash ^ key.charCodeAt(at), FNV_PRIME);
	return hash >>> 0;
}

/** Words cut into `count` pieces, as near equal as they come; none is one. */
export function piecesOf(text: string, count: number): string[] {
	if (text === "") return [text];
	const pieces = Math.max(1, Math.min(count, text.length));
	const size = Math.ceil(text.length / pieces);
	return Array.from({ length: Math.ceil(text.length / size) }, (_, at) =>
		text.slice(at * size, (at + 1) * size),
	);
}

/** The `n`th standard normal draw, by Box and Muller from two uniform ones. */
function normal(n: number): number {
	const first = uniform(2 * n + 1);
	const second = uniform(2 * n + 2);
	return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

/** Mulberry32's increment, and its three mixing multipliers. */
const STEP = 0x6d2b79f5;
const MIX_A = 1;
const MIX_B = 61;
/** One more than the largest unsigned 32-bit value. */
const SPAN = 2 ** 32;

/** A uniform draw in (0, 1], the same for the same seed: one Mulberry32 step. */
function uniform(seed: number): number {
	let t = (seed * STEP) | 0;
	t = Math.imul(t ^ (t >>> 15), t | MIX_A);
	t ^= t + Math.imul(t ^ (t >>> 7), t | MIX_B);
	return (((t ^ (t >>> 14)) >>> 0) + 1) / SPAN;
}
