/**
 * The sparse checkout a carried tree stood in, carried with it so the
 * tree it arrives as stands in the same one.
 *
 * World's trees check out only the zones their work needs; checked out
 * whole on the other machine, a World tree would write every file World
 * has. So carrying away reads the patterns `git sparse-checkout list`
 * gives, and whether they are cone patterns, and arriving sets them on
 * the tree it cloned before checking out its branch. A tree that was
 * already there keeps the sparse checkout it has.
 */

/** A sparse checkout's patterns, and whether git reads them as cones. */
export interface Sparse {
	readonly cone: boolean;
	readonly patterns: readonly string[];
}

/** git in one tree, answering what it said or nothing when it failed. */
type Ask = (...args: string[]) => Promise<string | undefined>;

/** The sparse checkout the tree `ask` reads stands in; or nothing. */
export async function sparseOf(ask: Ask): Promise<Sparse | undefined> {
	if ((await ask("config", "--get", "core.sparseCheckout")) !== "true") {
		return undefined;
	}
	const listed = await ask("sparse-checkout", "list");
	const patterns = (listed ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (patterns.length === 0 || !patterns.every(isPattern)) return undefined;
	const cone =
		(await ask("config", "--get", "core.sparseCheckoutCone")) === "true";
	return { cone, patterns };
}

/** git run in one tree, answering how it ended. */
type Run = (...args: string[]) => Promise<{ code: number; stderr: string }>;

/** Sets the tree `run` works in to `sparse`; answers why not, or nothing. */
export async function standSparse(
	run: Run,
	sparse: Sparse,
): Promise<string | undefined> {
	const set = await run(
		"sparse-checkout",
		"set",
		sparse.cone ? "--cone" : "--no-cone",
		...sparse.patterns,
	);
	return set.code === 0
		? undefined
		: `git couldn't set its sparse checkout: ${set.stderr.trim()}`;
}

/** A sparse checkout as a done file may carry it, every field checked. */
export function isSparse(value: unknown): value is Sparse {
	if (typeof value !== "object" || value === null) return false;
	const sparse = value as Record<string, unknown>;
	return (
		typeof sparse.cone === "boolean" &&
		Array.isArray(sparse.patterns) &&
		sparse.patterns.length > 0 &&
		sparse.patterns.every(isPattern)
	);
}

/** A pattern no command could read as a flag, on a line of its own. */
function isPattern(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value !== "" &&
		!value.startsWith("-") &&
		!/[\n\r\0]/.test(value)
	);
}
