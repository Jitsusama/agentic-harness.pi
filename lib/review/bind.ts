/**
 * Binding a target to a provider, and keeping it bound.
 *
 * Resolution is allowed to be clever once. After that it has
 * to be boring: if a specialist provider registers halfway
 * through a review, the draft already open must not silently
 * change which backend it is about to post to. So the first
 * answer is remembered against the target's key and reused
 * until the provider it named goes away.
 */

import type { RepoLocator, ReviewTarget } from "./change.js";
import { targetKey } from "./keys.js";
import type { ReviewProvider } from "./provider.js";
import { getReviewProvider, listReviewProviders } from "./register.js";
import type { ResolveContext, ResolvedVia } from "./resolve.js";

/**
 * The answer for a whole target.
 *
 * Carries how the provider was arrived at, because a later failure against it
 * reads differently depending on the answer: claimed by shape is a guess that
 * happened to win, and mapped by config is a decision somebody made.
 */
export type TargetResolution =
	| {
			resolved: true;
			provider: ReviewProvider;
			repo: RepoLocator;
			via: ResolvedVia;
	  }
	| { resolved: false; tried: string[]; message: string };

/**
 * Target key to provider id. Session-scoped: a binding is
 * about not flipping mid-flight, not about remembering a
 * choice made last week, and the target's own key is enough
 * to re-derive the same answer next time.
 */
const bindings = new Map<string, string>();

/** Remember that a target belongs to a provider. */
export function bindTarget(target: ReviewTarget, providerId: string): void {
	bindings.set(targetKey(target), providerId);
}

/** Forget every binding. Intended for tests and lifecycle. */
export function clearTargetBindings(): void {
	bindings.clear();
}

/** The repo a target is about. */
function repoOf(target: ReviewTarget): RepoLocator {
	return target.kind === "proposal" ? target.change.repo : target.repo;
}

/** The provider a target was bound to, if it is still here. */
function bound(target: ReviewTarget): ReviewProvider | undefined {
	const id = bindings.get(targetKey(target));
	return id ? getReviewProvider(id) : undefined;
}

/** Provider ids config pins to this repo, in order. */
function mappedIds(
	target: ReviewTarget,
	context: ResolveContext | undefined,
): string[] {
	const repo = repoOf(target);
	const haystacks = [repo.key, repo.localPath ?? "", repo.remoteUrl ?? ""];
	const mapping = context?.config?.repos?.find((entry) =>
		haystacks.some((value) => value.includes(entry.match)),
	);
	return mapping?.providers ?? [];
}

/**
 * Ask providers to claim the target's repo, in the order
 * given, and take the first that does.
 */
function claimRepo(
	providers: ReviewProvider[],
	target: ReviewTarget,
	tried: string[],
): { provider: ReviewProvider; repo: RepoLocator } | undefined {
	const repo = repoOf(target);
	const probe = {
		repoRoot: repo.localPath,
		remoteUrls: repo.remoteUrl ? [repo.remoteUrl] : [],
	};
	for (const provider of providers) {
		tried.push(provider.id);
		const claimed = provider.claimRepo(probe);
		if (claimed) return { provider, repo: claimed };
	}
	return undefined;
}

/**
 * Resolve a whole target to the provider that owns it.
 *
 * A hosted change already names its provider, so that is the
 * answer. A local target has to be claimed by repo, config
 * first and then claim order. Either way the answer is
 * remembered, so the next call cannot land somewhere else.
 */
export function resolveTarget(
	target: ReviewTarget,
	context?: ResolveContext,
): TargetResolution {
	const remembered = bound(target);
	if (remembered) {
		// A binding is a decision already taken, so it reports as one. What is
		// remembered here is the answer, not the argument that produced it.
		return {
			resolved: true,
			provider: remembered,
			repo: repoOf(target),
			via: "config-repo",
		};
	}

	if (target.kind === "proposal") {
		const provider = getReviewProvider(target.change.provider);
		if (!provider) {
			return {
				resolved: false,
				tried: [],
				message:
					`This change belongs to the ${target.change.provider} ` +
					"provider, which is not registered. Load the package that " +
					"provides it, or map the repo to another provider under " +
					"review.repos.",
			};
		}
		bindTarget(target, provider.id);
		// The change names its own provider, so nothing was guessed.
		return {
			resolved: true,
			provider,
			repo: target.change.repo,
			via: "config-repo",
		};
	}

	const tried: string[] = [];
	const ids = mappedIds(target, context);
	const mapped = ids
		.map((id) => getReviewProvider(id))
		.filter((provider): provider is ReviewProvider => provider !== undefined);
	const byConfig = claimRepo(mapped, target, tried);
	if (byConfig) {
		bindTarget(target, byConfig.provider.id);
		return { resolved: true, ...byConfig, via: "config-repo" };
	}

	const remaining = listReviewProviders().filter(
		(provider) => !tried.includes(provider.id),
	);
	const byClaim = claimRepo(remaining, target, tried);
	if (byClaim) {
		bindTarget(target, byClaim.provider.id);
		return { resolved: true, ...byClaim, via: "claim" };
	}

	const absent = ids.filter((id) => !getReviewProvider(id));
	const missing =
		absent.length > 0
			? ` Config names ${absent.join(", ")} for this repo, but no ` +
				"provider registered under that id."
			: "";
	return {
		resolved: false,
		tried,
		message:
			"No review provider claimed this repo. Pin it under " +
			`review.repos, or register a provider that recognizes it.${missing}`,
	};
}
