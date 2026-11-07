/**
 * How big a change is, measured rather than claimed, for the PR
 * format's depth: a change of enough changed lines may go deeper inside
 * its sections, and the writer's word for that is never taken.
 *
 * A proposal has no change yet, so its size is the checkout's diff from
 * where its base and head part. An edit has one, and its size is what
 * the backend reports, on the change or, where the change leaves it
 * out as Delta's does, from the provider's own count. Either can fail
 * to say, and then the size is unknown with the reason, which the
 * refusal passes on, rather than a guess that would read as "too
 * small".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Change, ChangesFacet } from "../../../lib/core/review/index.ts";
import type { ChangeSize } from "../../../lib/core/sections/shape.ts";

const INSERTIONS = /(\d+) insertions?\(\+\)/;
const DELETIONS = /(\d+) deletions?\(-\)/;

/** Changed lines from one line of `git diff --shortstat`, 0 for no output. */
function linesOf(shortstat: string): number {
	const added = Number(INSERTIONS.exec(shortstat)?.[1] ?? 0);
	const deleted = Number(DELETIONS.exec(shortstat)?.[1] ?? 0);
	return added + deleted;
}

/**
 * The lines a head changes from where it parts with its base, in the
 * checkout at `cwd`. Each base is tried in turn, so a trunk can be read
 * from its remote-tracking branch first, which is what the change will
 * be compared against once it is up, and from the local branch when
 * there is no remote one.
 */
export async function checkoutSize(
	host: Pick<ExtensionAPI, "exec">,
	cwd: string,
	bases: readonly string[],
	head: string,
): Promise<ChangeSize> {
	for (const base of bases) {
		try {
			const result = await host.exec("git", [
				"-C",
				cwd,
				"diff",
				"--shortstat",
				`${base}...${head}`,
			]);
			if (result.code === 0) return { lines: linesOf(result.stdout) };
		} catch {
			// No git here, or the ref is missing. The next base may still
			// answer, and the last says why none could.
		}
	}
	return {
		unknown: `git could not compare ${bases.join(" or ")} with ${head} in this checkout`,
	};
}

/**
 * The lines a hosted change touches, as its backend reports them: on
 * the change, or else from the changes facet's own count.
 */
export async function hostedSize(
	change: Change,
	provider: string,
	changes?: Pick<ChangesFacet, "size">,
): Promise<ChangeSize> {
	const said = linesSaid(change);
	if (said !== undefined) return { lines: said };
	if (changes?.size) {
		try {
			const counted = linesSaid(await changes.size(change.ref));
			if (counted !== undefined) return { lines: counted };
		} catch (error) {
			return {
				unknown: `the ${provider} provider could not count the lines this change touches: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	return {
		unknown: `the ${provider} provider does not report how many lines this change touches`,
	};
}

/** Added and deleted lines together, when both are said. */
function linesSaid(
	size: Pick<Change, "additions" | "deletions">,
): number | undefined {
	return size.additions === undefined || size.deletions === undefined
		? undefined
		: size.additions + size.deletions;
}
