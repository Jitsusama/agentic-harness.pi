/**
 * Whether a checkout and the repo in play are two different places.
 *
 * The comparison only. Each caller phrases its own sentence, because
 * the same fact means different things: proposing a branch into
 * another repo cannot work at all, while listing another repo's
 * changes works perfectly and answers the wrong question.
 */

import { withoutCredentials } from "../remote/index.js";

/**
 * Both names when the checkout's remote and the repo key disagree, or
 * undefined when they agree or when there is nothing to compare.
 *
 * Silent where silence is right: a local repo names no remote it
 * could have meant instead, a checkout with no origin gives nothing
 * to compare, and a trailing `.git`, a trailing slash or a difference
 * of case are spellings rather than differences.
 *
 * The remote comes back without its credential, because this pair is
 * only ever built to be said out loud. A remote that authenticates
 * inline puts a token where a username goes, and a refusal naming it
 * would print that token into the transcript, into any log kept of
 * it, and into whatever the person reading it pastes somewhere else.
 */
export function repoElsewhere(
	checkoutRemote: string | undefined,
	repoKey: string,
): { checkout: string; repo: string } | undefined {
	// A key is provider:slug, and a slug may contain a colon of its
	// own, so the split is on the first one with the rest rejoined.
	const slug = repoKey.split(":").slice(1).join(":");
	if (slug === "" || repoKey.startsWith("local:")) return undefined;
	if (!checkoutRemote || checkoutRemote === "") return undefined;

	const tidied = withoutCredentials(checkoutRemote)
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
	if (tidied.toLowerCase().includes(slug.toLowerCase())) return undefined;

	return { checkout: tidied, repo: repoKey };
}
