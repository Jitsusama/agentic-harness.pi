/**
 * Which provider handles this reference.
 *
 * The order is declared rather than emergent, because the
 * failure mode this replaces is a tool quietly reaching for
 * the wrong backend. Config comes first, since only the user
 * knows which of two backends mirroring the same repo is the
 * real one this week. Then the providers themselves, in claim
 * priority order, so adding a backend never means editing
 * this file. Then the user's own reference shapes, which
 * catch what no provider recognizes. Then a refusal that
 * names the knob to turn: never a default.
 */

import type { ChangeRef } from "./change.js";
import type { ReferenceMapping, RepoMapping, ReviewConfig } from "./config.js";
import type { RepoProbe, ReviewProvider } from "./provider.js";
import { getReviewProvider, listReviewProviders } from "./register.js";

/** How a reference came to be resolved. */
export type ResolvedVia = "config-repo" | "claim" | "config-reference";

/** Why a reference could not be resolved. */
export type ResolutionRefusal = "no-providers" | "unclaimed";

/** What the caller knows when asking. */
export interface ResolveContext {
	config?: ReviewConfig;
	/** The checkout the question was asked from, when there is one. */
	probe?: RepoProbe;
}

/** The answer, resolved or refused with guidance. */
export type Resolution =
	| {
			resolved: true;
			change: ChangeRef;
			provider: ReviewProvider;
			via: ResolvedVia;
	  }
	| {
			resolved: false;
			reason: ResolutionRefusal;
			/** Provider ids that were asked, in order. */
			tried: string[];
			/** What the user can do about it. */
			message: string;
	  };

/** Whether a mapping's match names this checkout. */
function mappingMatches(mapping: RepoMapping, probe: RepoProbe): boolean {
	const haystacks = [probe.repoRoot ?? "", ...(probe.remoteUrls ?? [])];
	return haystacks.some((value) => value.includes(mapping.match));
}

/** Providers a repo mapping names, in the order it names them. */
function mappedProviders(context: ResolveContext | undefined): {
	ids: string[];
	present: ReviewProvider[];
} {
	const probe = context?.probe;
	const mappings = context?.config?.repos;
	if (!probe || !mappings) return { ids: [], present: [] };
	const mapping = mappings.find((entry) => mappingMatches(entry, probe));
	if (!mapping) return { ids: [], present: [] };
	const present: ReviewProvider[] = [];
	for (const id of mapping.providers) {
		const provider = getReviewProvider(id);
		if (provider) present.push(provider);
	}
	return { ids: mapping.providers, present };
}

/** Build a change from a reference mapping that matched. */
function changeFromMapping(
	mapping: ReferenceMapping,
	input: string,
): ChangeRef | undefined {
	const match = new RegExp(mapping.pattern).exec(input);
	if (!match) return undefined;
	const repoKey = match.groups?.repo ?? mapping.repo;
	const id = match.groups?.id ?? match[1];
	if (!repoKey || !id) return undefined;
	// A user-supplied mapping has no provider to ask for a
	// label, and what the person typed is what they will
	// recognize back.
	return {
		provider: mapping.provider,
		repo: { key: repoKey },
		id,
		label: input,
	};
}

/**
 * Ask a list of providers, in order, to claim the reference.
 *
 * Each provider is first asked what it makes of the checkout,
 * and that answer is handed to it along with the reference. A
 * bare number means "in this repo", and only the provider can
 * say whether this repo is one of its own, so a number typed in
 * a gitstream checkout does not become a GitHub pull request.
 */
function firstClaim(
	providers: ReviewProvider[],
	input: string,
	via: ResolvedVia,
	tried: string[],
	probe: RepoProbe | undefined,
): Resolution | undefined {
	for (const provider of providers) {
		tried.push(provider.id);
		const repo = probe ? (provider.claimRepo(probe) ?? undefined) : undefined;
		const change = provider.claimReference(input, repo);
		if (change) return { resolved: true, change, provider, via };
	}
	return undefined;
}

/** The guidance a refusal carries. */
function refusalMessage(absentMapped: string[]): string {
	const parts = [
		"No review provider recognized that reference.",
		"Map its shape under review.references, or pin the repo",
		"under review.repos.",
	];
	if (absentMapped.length > 0) {
		parts.push(
			`Config names ${absentMapped.join(", ")} for this repo, but`,
			"no provider registered under that id.",
		);
	}
	return parts.join(" ");
}

/**
 * Resolve a reference to a change and the provider owning it.
 *
 * A mapped repo gets first refusal, then every provider in
 * claim order, then the user's own reference shapes. Nothing
 * defaults: an unrecognized reference comes back as a refusal
 * naming the knob that would fix it.
 */
export function resolveReference(
	input: string,
	context?: ResolveContext,
): Resolution {
	const providers = listReviewProviders();
	if (providers.length === 0) {
		return {
			resolved: false,
			reason: "no-providers",
			tried: [],
			message:
				"No review provider is registered, so nothing can be " +
				"resolved. Load the review integration, or register a " +
				"provider over the bus.",
		};
	}

	const tried: string[] = [];
	const probe = context?.probe;
	const mapped = mappedProviders(context);
	const byConfig = firstClaim(
		mapped.present,
		input,
		"config-repo",
		tried,
		probe,
	);
	if (byConfig) return byConfig;

	const remaining = providers.filter((p) => !tried.includes(p.id));
	const byClaim = firstClaim(remaining, input, "claim", tried, probe);
	if (byClaim) return byClaim;

	for (const mapping of context?.config?.references ?? []) {
		const provider = getReviewProvider(mapping.provider);
		if (!provider) continue;
		const change = changeFromMapping(mapping, input);
		if (change) {
			return { resolved: true, change, provider, via: "config-reference" };
		}
	}

	const absentMapped = mapped.ids.filter((id) => !getReviewProvider(id));
	return {
		resolved: false,
		reason: "unclaimed",
		tried,
		message: refusalMessage(absentMapped),
	};
}
