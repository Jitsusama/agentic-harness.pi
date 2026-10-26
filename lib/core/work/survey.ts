/**
 * What a survey verb should look at.
 *
 * `tidy` and `reclaim` ask what a repository has finished with, and
 * that question belongs to a checkout rather than to a held tree. The
 * broker only ever holds trees it cut, so the main checkout, which is
 * exactly where a person stands when they wonder what is spent, could
 * never be the answer: the verb refused with "none are held" and sent
 * them to raw git for the thing it exists to do.
 *
 * The other tree verbs are right to insist on a held tree, because
 * they commit, push and replay. These two report on a repository, and
 * reclaiming acts only on trees the broker does not hold, so neither
 * needs the broker's permission to look.
 */

/** What the caller knows when asking where to survey. */
export interface SurveyRequest {
	/** A held tree's key, or a path inside a checkout. Optional. */
	tree?: string;
	/** The trees this session holds. */
	held: { key: string; path: string }[];
	/** Where the caller is standing. */
	cwd: string;
	/** The working tree root containing a path, or null if there is none. */
	gitRootOf(path: string): string | null;
}

/**
 * Where to survey. `held` says whether this is a tree the broker
 * manages, which is what lets a caller name it by key rather than by
 * path when reporting.
 */
export type SurveyTarget =
	| { ok: true; key: string; path: string; held: boolean }
	| { ok: false; refusal: string };

/** Name what is held, so a typo becomes a correction rather than a guess. */
function heldNames(held: { key: string }[]): string {
	return held.length === 0
		? "none are held"
		: held.map((one) => one.key).join(", ");
}

/**
 * Decide which checkout a survey should read.
 *
 * A named held tree wins, then a named path, then the single held tree
 * if there is exactly one, then the checkout the caller is standing
 * in. Several held trees and no other signal is a question rather than
 * a guess, the same way the acting verbs treat it.
 */
export function surveyTarget(request: SurveyRequest): SurveyTarget {
	const { tree, held, cwd, gitRootOf } = request;

	if (tree) {
		const named = held.find((one) => one.key === tree);
		if (named)
			return { ok: true, key: named.key, path: named.path, held: true };
		const root = gitRootOf(tree);
		if (root) return { ok: true, key: root, path: root, held: false };
		return {
			ok: false,
			refusal: `No held tree called ${tree}, and it is not inside a checkout: ${heldNames(held)}.`,
		};
	}

	if (held.length === 1) {
		const only = held[0] as { key: string; path: string };
		return { ok: true, key: only.key, path: only.path, held: true };
	}

	// Standing in a checkout is a real answer, so it settles a session
	// holding several trees rather than leaving the caller to choose
	// between trees they did not ask about.
	const root = gitRootOf(cwd);
	if (root) return { ok: true, key: root, path: root, held: false };

	return {
		ok: false,
		refusal: `Name the tree to survey, or run this inside a checkout: ${heldNames(held)}.`,
	};
}
