/**
 * Guardian-side glue for sending a shell command to the tool that can
 * reach the repo it names.
 *
 * `gh pr create` is the wrong instrument wherever something other than
 * GitHub hosts the changes: it reaches a mirror that has never heard of
 * them, and answers with "Could not resolve to a PullRequest with the
 * number of ...", which reads as a wrong number rather than as the wrong
 * system. A skill description helps somebody who wonders whether another
 * tool exists; this is for the case where nobody wondered.
 *
 * Only for creating. A create uses the branch in this checkout, so the
 * checkout's provider is the right question to ask. An edit names a
 * change that may live in another repo entirely, `-R` and all, so the
 * skills cover that in words rather than this guessing at it.
 *
 * Blocks once and relents on a repeat, the same machinery the title,
 * section and prose gates use, so it cannot loop and somebody who means
 * `gh` still gets it on the second try.
 */

import { decideGate, type GateDeps } from "../../gate/index.js";
import type { GuardianResult } from "../../guardian/types.js";
import { resolveRepo } from "../../review/index.js";

/** What the gate needs to know about the command and where it runs. */
export interface RedirectSubject {
	/** "create" or "edit"; only a create is redirected. */
	action: string;
	/** The directory the command would run in. */
	cwd: string | undefined;
	/** How to ask git about the checkout. */
	exec:
		| ((
				command: string,
				args: string[],
		  ) => Promise<{ code: number; stdout: string; stderr: string }>)
		| undefined;
}

/** One reason a command was sent elsewhere. */
interface RedirectViolation {
	readonly kind: "gh-redirect";
	readonly found: string;
}

/**
 * Redirect a create to the review tools when a provider serves this
 * checkout. Returns a block, or undefined to let the command through.
 */
export async function runRedirectGate(
	deps: GateDeps,
	subject: RedirectSubject,
): Promise<GuardianResult> {
	if (subject.action !== "create") return undefined;
	const provider = await serving(subject);
	if (!provider) return undefined;

	const violations: RedirectViolation[] = [
		{ kind: "gh-redirect", found: provider },
	];
	const decision = decideGate(
		violations,
		deps.readSignatures(),
		() => explain(provider),
		"You have asked for this twice, so it goes through as written. ",
		`gh-pr-create:${provider}`,
	);
	if (decision.action === "block") {
		deps.persistSignature(decision.signature);
		return { block: true, reason: decision.message };
	}
	// On relent the caller has said twice that they mean `gh`. Fall through
	// to the human review gate rather than blocking again.
	return undefined;
}

/** What to say instead. */
function explain(provider: string): string {
	return [
		`This checkout is served by the ${provider} provider, not by GitHub,`,
		"so a change created with `gh pr create` would be opened on a mirror",
		"that nothing reads, or refused outright. Later `gh` commands cannot",
		'see such a change at all: they answer "Could not resolve to a',
		'PullRequest with the number of ...", which reads as a wrong number',
		"and is not one.",
		"",
		"Use `review_offer propose` instead. It resolves this repo to",
		`${provider}, holds the title and body to the same conventions this`,
		"gate does, and answers with the change's number and URL.",
		"",
		"Read the review-guide skill. If you truly mean `gh`, run it again",
		"and it will go through to the review panel.",
	].join("\n");
}

/**
 * The provider that serves this checkout and can open a change, if any.
 *
 * Undefined whenever the question cannot be answered: no directory, no
 * exec, no remote, nothing registered, or a provider that cannot author.
 * A guardian that cannot tell must not redirect, since blocking a
 * command for a reason that does not hold is worse than allowing it.
 */
async function serving(subject: RedirectSubject): Promise<string | undefined> {
	const { cwd, exec } = subject;
	if (!cwd || !exec) return undefined;

	let remote: string | undefined;
	try {
		const result = await exec("git", [
			"-C",
			cwd,
			"remote",
			"get-url",
			"origin",
		]);
		remote = result.code === 0 ? result.stdout.trim() : undefined;
	} catch {
		// Not a repo, or no git. Nothing to compare, so nothing to say.
		return undefined;
	}
	if (!remote) return undefined;

	const resolved = resolveRepo({ repoRoot: cwd, remoteUrls: [remote] });
	if (!resolved.resolved) return undefined;
	// A provider that cannot open a change is no redirect at all, and the
	// plain git provider claims every checkout.
	if (!resolved.provider.capabilities(resolved.repo).authoring?.propose) {
		return undefined;
	}
	return resolved.provider.id;
}
