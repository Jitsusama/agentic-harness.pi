/**
 * The cache prices a demotion is weighed at, from the active model's
 * own rates rather than a table that goes stale when a provider
 * reprices.
 *
 * pi bills a one-hour cache write at twice base input against the
 * model's own five-minute write rate, and only asks for one on the
 * Anthropic API. The write price is what makes a mid-prompt change
 * expensive, so getting it right under the retention actually in force
 * is the whole point: at one hour it is twenty times a read.
 */

export interface CachePrices {
	readonly readPrice: number;
	readonly writePrice: number;
}

/** The only API pi requests one-hour retention on. */
const LONG_RETENTION_API = "anthropic-messages";

/** What pi bills a one-hour cache write at, as a multiple of base input. */
const LONG_WRITE_MULTIPLE = 2;

/**
 * Read and write prices per token for a model, or nothing when the model
 * reports no cache read price, since a payback test divides by it.
 */
export function cachePrices(
	rates: {
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly input: number;
	},
	api: string,
	retention: string | undefined,
): CachePrices | undefined {
	if (!(rates.cacheRead > 0)) return undefined;
	const long = retention === "long" && api === LONG_RETENTION_API;
	return {
		readPrice: rates.cacheRead,
		writePrice: long ? rates.input * LONG_WRITE_MULTIPLE : rates.cacheWrite,
	};
}
