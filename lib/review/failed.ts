/**
 * What a failure against a hosted change should say.
 *
 * A provider's own error is about its own request, which is the right thing
 * for it to report and not enough to act on. `gh: Not Found (HTTP 404)` is the
 * example that prompted this: it named neither the change, nor the provider
 * asked for it, nor the one setting that decides which provider gets asked.
 *
 * The missing fact is how the provider came to own the reference. A shape like
 * `owner/repo#n` belongs to no system in particular, so a reference resolved
 * by claim landed on whichever provider recognized the shape first, and a
 * not-found there is as likely to mean the wrong system as a missing change.
 * Resolved from config, the same not-found means what it says.
 */

import type { RepoLocator } from "./change.js";
import type { ResolvedVia } from "./resolve.js";

/** Just enough of a bound target to explain a failure against it. */
export interface FailureContext {
	provider: { id: string };
	repo: RepoLocator;
	via: ResolvedVia;
}

/**
 * True when a message reads like the system was asked about something it does
 * not have.
 *
 * Deliberately narrow. A 422 is the backend understanding the request and
 * rejecting its contents, which is a real answer about a real change, and
 * decorating it with "you may be on the wrong system" would be wrong and
 * would train a reader to skip the decoration when it counts.
 */
export function readsAsMissing(message: string): boolean {
	const lowered = message.toLowerCase();
	return (
		lowered.includes("not found") ||
		lowered.includes("404") ||
		lowered.includes("could not resolve to") ||
		lowered.includes("no such")
	);
}

/**
 * A failure message with the context needed to act on it.
 *
 * Takes the message as thrown rather than composing one, since whatever threw
 * already said what it was attempting, and a second prefix in front of that
 * reads like two failures.
 *
 * Adds nothing when the failure is not a not-found, and nothing when config
 * already decided the provider, since a pin cannot be the advice when a pin
 * is what got us here.
 */
export function explainFailure(
	message: string,
	context: FailureContext,
): string {
	const stated = message;
	if (!readsAsMissing(message)) return stated;
	if (context.via !== "claim") return stated;

	const owned = context.repo.key.split(":").slice(1).join(":");
	const named = owned === "" ? context.repo.key : owned;
	return [
		stated,
		"",
		`The ${context.provider.id} provider was asked, because it recognized the shape of that reference rather than because anything said ${named} is served there.`,
		`If another system serves ${named}, pin it under review.repos, or name the change by its url.`,
	].join("\n");
}
