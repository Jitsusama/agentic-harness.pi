/**
 * The seam between this workflow and the review substrate.
 *
 * pr-workflow was written against GitHub's shape: an owner, a
 * repo and a number. The substrate names a change neutrally, so
 * that one workflow can review a GitHub pull request, a
 * Meteorite pull or a GitLab merge request without knowing
 * which it has.
 *
 * The workflow still stores GitHub's shape, because everything
 * downstream of it still speaks GitHub: the metadata fetch, the
 * thread reads, the buffer URIs. Rather than keep a second
 * representation on state and risk the two disagreeing, the
 * neutral reference is derived on demand, here, from the one
 * that is stored.
 *
 * That inverts when the plumbing moves across: `change` becomes
 * what is stored, `githubViewOf` becomes the only converter
 * left, and every remaining caller of it is a place that still
 * has to be moved.
 */

import type { PRReference } from "../../lib/internal/github/pr-reference.js";
import {
	type ChangeRef,
	githubChange,
	ownerRepoFromKey,
} from "../../lib/review/index.js";
import type { ActivePr } from "./state.js";

/**
 * The neutral reference for a GitHub-shaped one.
 *
 * A PR the workflow parsed is a GitHub PR by construction, so
 * this cannot fail.
 */
export function changeFromGitHubView(reference: PRReference): ChangeRef {
	return githubChange(
		{ key: `github:${reference.owner}/${reference.repo}` },
		String(reference.number),
	);
}

/**
 * The loaded PR as the substrate names it.
 *
 * Use this to display a change or to hand one to a provider.
 * `change.label` is the name to show a person, which spares
 * every caller from formatting `owner/repo#number` again.
 */
export function changeOf(pr: ActivePr): ChangeRef {
	// Absent only on a session recorded before a loaded change
	// carried the system that owns it. Everything loadable then was
	// a GitHub pull request, so reconstructing one is a statement
	// of fact about those entries rather than a default applied to
	// a change whose system is unknown.
	return pr.change ?? changeFromGitHubView(pr.reference);
}

/**
 * A change as owner, repo and number, whoever hosts it.
 *
 * Every provider so far keys a repo as `system:owner/repo`,
 * because that is how the systems themselves name repositories,
 * so this projection is available for all of them. It is what
 * lets the workflow's existing readers go on reading three
 * fields while the identity beside them says which system to
 * address.
 *
 * Null when a key does not carry an owner and repo, or when the
 * change id is not a number. Both are real possibilities for a
 * provider that names things differently, and inventing values
 * for them would be worse than declining.
 */
export function viewOf(change: ChangeRef): PRReference | null {
	const [, slug] = change.repo.key.split(":");
	const [owner, repo] = (slug ?? "").split("/");
	const number = Number(change.id);
	if (!owner || !repo || !Number.isInteger(number)) return null;
	return { owner, repo, number };
}

/**
 * GitHub's view of a neutral reference, or null when the
 * reference belongs to some other provider.
 *
 * Null rather than a throw, so a caller that has not moved onto
 * the substrate can degrade honestly when handed a change
 * GitHub does not own.
 */
export function githubViewOf(change: ChangeRef): PRReference | null {
	const owned = ownerRepoFromKey(change.repo.key);
	const number = Number(change.id);
	if (!owned || !Number.isInteger(number)) return null;
	return { owner: owned.owner, repo: owned.repo, number };
}
