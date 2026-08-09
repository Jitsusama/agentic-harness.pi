/**
 * Reading the `review` section of the package config.
 *
 * Two knobs, both of which exist because guessing which backend
 * owns a repo is worse than being told. A malformed section is
 * reported rather than silently ignored: someone who wrote a
 * mapping and got no mapping deserves to know why.
 */

import { loadPackageConfig } from "../../lib/internal/config/loader.js";
import type {
	ReferenceMapping,
	RepoMapping,
	ReviewConfig,
} from "../../lib/review/index.js";

/** Section key for this extension in the package config. */
export const REVIEW_SLUG = "review";

/** What loading produced, and anything wrong with it. */
export interface LoadedReviewConfig {
	config: ReviewConfig;
	/** Complaints about the section, for the user to see. */
	problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function readRepoMappings(value: unknown, problems: string[]): RepoMapping[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		problems.push("review.repos should be a list of mappings.");
		return [];
	}
	const mappings: RepoMapping[] = [];
	for (const [index, entry] of value.entries()) {
		if (!isRecord(entry) || typeof entry.match !== "string") {
			problems.push(`review.repos[${index}] needs a "match" string.`);
			continue;
		}
		const providers = stringList(entry.providers);
		const path = typeof entry.path === "string" ? entry.path : undefined;
		// One or the other. A mapping used to be a way to pin a provider
		// and nothing else, so an empty list meant an entry that did
		// nothing; now it can also be the only place that says where a
		// repo lives, and saying that is a whole job.
		if (providers.length === 0 && path === undefined) {
			problems.push(
				`review.repos[${index}] needs at least one provider id, or a "path" saying where the repo is checked out.`,
			);
			continue;
		}
		mappings.push({
			match: entry.match,
			providers,
			...(path === undefined ? {} : { path }),
		});
	}
	return mappings;
}

function readReferenceMappings(
	value: unknown,
	problems: string[],
): ReferenceMapping[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		problems.push("review.references should be a list of mappings.");
		return [];
	}
	const mappings: ReferenceMapping[] = [];
	for (const [index, entry] of value.entries()) {
		if (
			!isRecord(entry) ||
			typeof entry.pattern !== "string" ||
			typeof entry.provider !== "string"
		) {
			problems.push(
				`review.references[${index}] needs a "pattern" and a "provider".`,
			);
			continue;
		}
		try {
			new RegExp(entry.pattern);
		} catch (error) {
			problems.push(
				`review.references[${index}] has an unusable pattern: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			continue;
		}
		mappings.push({
			pattern: entry.pattern,
			provider: entry.provider,
			...(typeof entry.repo === "string" ? { repo: entry.repo } : {}),
		});
	}
	return mappings;
}

/** Load the review configuration, reporting anything malformed. */
export async function loadReviewConfig(): Promise<LoadedReviewConfig> {
	const problems: string[] = [];
	const loaded = await loadPackageConfig();
	if (!loaded.ok) {
		return { config: {}, problems: [loaded.error] };
	}
	const section = loaded.config.sections[REVIEW_SLUG];
	if (section === undefined) return { config: {}, problems };
	if (!isRecord(section)) {
		return {
			config: {},
			problems: ["The review config section should be an object."],
		};
	}
	const repos = readRepoMappings(section.repos, problems);
	const references = readReferenceMappings(section.references, problems);
	return {
		config: {
			...(repos.length > 0 ? { repos } : {}),
			...(references.length > 0 ? { references } : {}),
		},
		problems,
	};
}
