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
import type { RepoProbe, ReviewProvider } from "./provider.js";
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
	repo: RepoLocator | undefined,
	probe: RepoProbe | undefined,
	context: ResolveContext | undefined,
): string[] {
	// The probe's remotes count here too. A pin written against a remote URL,
	// which is the spelling somebody reaches for first, could not match a local
	// target at all: the locator minted for one carries no remote, so the only
	// strings on offer were a `local:` key and a path.
	//
	// The repo's own strings are absent when there is no target, which is the
	// bare-checkout case: the probe is then everything known, so its root
	// stands in for the path a locator would have carried.
	const haystacks = [
		repo?.key ?? "",
		repo?.localPath ?? "",
		repo?.remoteUrl ?? "",
		probe?.repoRoot ?? "",
		...(probe?.remoteUrls ?? context?.probe?.remoteUrls ?? []),
	];
	const mapping = context?.config?.repos?.find((entry) =>
		haystacks.some((value) => value.includes(entry.match)),
	);
	return mapping?.providers ?? [];
}

/**
 * Ask providers to claim a repo, in the order given, and take
 * the first that does.
 */
function claimRepo(
	providers: ReviewProvider[],
	probe: RepoProbe,
	tried: string[],
): { provider: ReviewProvider; repo: RepoLocator } | undefined {
	for (const provider of providers) {
		tried.push(provider.id);
		const claimed = provider.claimRepo(probe);
		if (claimed) return { provider, repo: claimed };
	}
	return undefined;
}

/**
 * What a target says about the checkout it covers, for a caller
 * that has no probe.
 *
 * The caller's probe wins where there is one, because it is what somebody
 * actually went and looked at: the engine reads every remote out of the
 * checkout and passes them down. Reconstructing a probe from the target
 * instead throws that away, and for a local target it throws away all of
 * it, since the locator the engine mints there carries a path and no
 * remote. Every provider was then asked to claim a checkout with no
 * remotes, which only a provider claiming anything local can answer, so a
 * hosted repo resolved to plain git and lost its authoring facet with it.
 */
function probeOf(repo: RepoLocator, context?: ResolveContext): RepoProbe {
	return (
		context?.probe ?? {
			repoRoot: repo.localPath,
			remoteUrls: repo.remoteUrl ? [repo.remoteUrl] : [],
		}
	);
}

/** Who serves a repo, or why nobody does. */
export type RepoResolution =
	| {
			resolved: true;
			provider: ReviewProvider;
			repo: RepoLocator;
			via: ResolvedVia;
	  }
	| { resolved: false; tried: string[]; message: string };

/**
 * Resolve a checkout to the provider that serves it, with nothing to
 * review yet.
 *
 * "What can be done here" is a question about a repo, and it is asked
 * before there is a change to ask it about. Answering it through a target
 * meant inventing a base and a head that nobody named.
 *
 * Nothing is remembered. A binding exists so one target cannot change
 * provider mid-flight; pinning the repo instead would decide for every
 * range and stack over it, on the strength of a question that only asked
 * what was possible.
 */
export function resolveRepo(
	probe: RepoProbe,
	context?: ResolveContext,
): RepoResolution {
	return resolveIn(probe, context);
}

/**
 * The claim walk itself: config's pins first, then claim order.
 *
 * One copy, two entry points. A target's repo is resolved exactly the way
 * a bare checkout's is, and only what happens afterwards differs, so the
 * locator comes in as an argument rather than the walk being written twice.
 */
function resolveIn(
	probe: RepoProbe,
	context: ResolveContext | undefined,
	repo?: RepoLocator,
): RepoResolution {
	const tried: string[] = [];
	const ids = mappedIds(repo, probe, context);
	const mapped = ids
		.map((id) => getReviewProvider(id))
		.filter((provider): provider is ReviewProvider => provider !== undefined);
	const byConfig = claimRepo(mapped, probe, tried);
	if (byConfig) return { resolved: true, ...byConfig, via: "config-repo" };

	const remaining = listReviewProviders().filter(
		(provider) => !tried.includes(provider.id),
	);
	const byClaim = claimRepo(remaining, probe, tried);
	if (byClaim) return { resolved: true, ...byClaim, via: "claim" };

	return {
		resolved: false,
		tried,
		message: unclaimed(ids),
	};
}

/** Why nobody claimed a repo, naming a pin that names nobody. */
function unclaimed(ids: string[]): string {
	const absent = ids.filter((id) => !getReviewProvider(id));
	const missing =
		absent.length > 0
			? ` Config names ${absent.join(", ")} for this repo, but no ` +
				"provider registered under that id."
			: "";
	return (
		"No review provider claimed this repo. Pin it under " +
		`review.repos, or register a provider that recognizes it.${missing}`
	);
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

	const repo = repoOf(target);
	const byRepo = resolveIn(probeOf(repo, context), context, repo);
	if (!byRepo.resolved) return byRepo;
	return remember(target, {
		provider: byRepo.provider,
		repo: byRepo.repo,
		via: byRepo.via,
	});
}
