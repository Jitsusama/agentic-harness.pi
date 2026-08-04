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
 * What a resolution decided, keyed by target. Session-scoped: a
 * binding is about not flipping mid-flight, not about remembering a
 * choice made last week, and the target's own key is enough to
 * re-derive the same answer next time.
 *
 * The repo is remembered alongside the provider because it is part of
 * the answer and cannot be recovered from the target. A provider that
 * maps a checkout onto a hosted repo is the whole point of claiming:
 * replaying the target's own `local:` locator handed that provider a
 * repo it does not serve, so the first call worked and every later one
 * was refused.
 */
const bindings = new Map<string, Binding>();

/** A resolution worth replaying: who serves the target, and as what. */
type Binding = { providerId: string; repo: RepoLocator; via: ResolvedVia };

/**
 * Remember that a target belongs to a provider, and optionally the
 * repo and route it resolved as. Without them the target's own locator
 * stands in, which is right for a caller that knows only the provider.
 */
export function bindTarget(
	target: ReviewTarget,
	providerId: string,
	resolved?: { repo: RepoLocator; via: ResolvedVia },
): void {
	bindings.set(targetKey(target), {
		providerId,
		repo: resolved?.repo ?? repoOf(target),
		via: resolved?.via ?? "config-repo",
	});
}

/** Forget every binding. Intended for tests and lifecycle. */
export function clearTargetBindings(): void {
	bindings.clear();
}

/** The repo a target is about. */
function repoOf(target: ReviewTarget): RepoLocator {
	return target.kind === "proposal" ? target.change.repo : target.repo;
}

/**
 * Bind what was resolved and hand back that same answer.
 *
 * One statement, because the defect this replaced was a memo and a
 * reply that disagreed: every site stored the provider and returned a
 * repo the memo never kept. Going through here, what is remembered is
 * by construction what was said.
 */
function remember(
	target: ReviewTarget,
	resolved: { provider: ReviewProvider; repo: RepoLocator; via: ResolvedVia },
): TargetResolution {
	bindTarget(target, resolved.provider.id, {
		repo: resolved.repo,
		via: resolved.via,
	});
	return { resolved: true, ...resolved };
}

/** What a target was bound to, if its provider is still here. */
function bound(
	target: ReviewTarget,
): { provider: ReviewProvider; binding: Binding } | undefined {
	const binding = bindings.get(targetKey(target));
	if (!binding) return undefined;
	const provider = getReviewProvider(binding.providerId);
	return provider ? { provider, binding } : undefined;
}

/** Provider ids config pins to this repo, in order. */
function mappedIds(
	target: ReviewTarget,
	context: ResolveContext | undefined,
): string[] {
	const repo = repoOf(target);
	// The probe's remotes count here too. A pin written against a remote URL,
	// which is the spelling somebody reaches for first, could not match a local
	// target at all: the locator minted for one carries no remote, so the only
	// strings on offer were a `local:` key and a path.
	const haystacks = [
		repo.key,
		repo.localPath ?? "",
		repo.remoteUrl ?? "",
		...(context?.probe?.remoteUrls ?? []),
	];
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
	context?: ResolveContext,
): { provider: ReviewProvider; repo: RepoLocator } | undefined {
	const repo = repoOf(target);
	// The caller's probe wins where there is one, because it is what somebody
	// actually went and looked at: the engine reads every remote out of the
	// checkout and passes them down. Reconstructing a probe from the target
	// instead throws that away, and for a local target it throws away all of
	// it, since the locator the engine mints there carries a path and no
	// remote. Every provider was then asked to claim a checkout with no
	// remotes, which only a provider claiming anything local can answer, so a
	// hosted repo resolved to plain git and lost its authoring facet with it.
	const probe = context?.probe ?? {
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
		// A binding is a decision already taken, so it replays that decision
		// whole: the same provider, the same repo, and the route that found
		// them. Re-deriving any part of it here is how the answer drifted.
		return {
			resolved: true,
			provider: remembered.provider,
			repo: remembered.binding.repo,
			via: remembered.binding.via,
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
		// The change names its own provider, so nothing was guessed.
		return remember(target, {
			provider,
			repo: target.change.repo,
			via: "config-repo",
		});
	}

	const tried: string[] = [];
	const ids = mappedIds(target, context);
	const mapped = ids
		.map((id) => getReviewProvider(id))
		.filter((provider): provider is ReviewProvider => provider !== undefined);
	const byConfig = claimRepo(mapped, target, tried, context);
	if (byConfig) return remember(target, { ...byConfig, via: "config-repo" });

	const remaining = listReviewProviders().filter(
		(provider) => !tried.includes(provider.id),
	);
	const byClaim = claimRepo(remaining, target, tried, context);
	if (byClaim) return remember(target, { ...byClaim, via: "claim" });

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
