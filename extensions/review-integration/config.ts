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
		if (
			!isRecord(entry) ||
			typeof entry.match !== "string" ||
			entry.match.trim().length === 0
		) {
			// Non-empty, because matching is a substring test and every
			// string contains the empty one: an empty match claims every
			// repo there is, which for a mapping carrying a path means
			// every round in every repo reads one directory.
			problems.push(`review.repos[${index}] needs a non-empty "match" string.`);
			continue;
		}
		const providers = stringList(entry.providers);
		// Absolute and non-empty. A relative path is resolved against
		// whatever directory the session happens to be in, which is the
		// thing this field exists to stop mattering, and `~` is the
		// shell's expansion rather than one node does. Both fail far from
		// here and read as "that is not a checkout".
		const said = typeof entry.path === "string" ? entry.path.trim() : "";
		if (said.length > 0 && !said.startsWith("/")) {
			problems.push(
				`review.repos[${index}].path must be an absolute path; "${said}" is relative${said.startsWith("~") ? ", and a leading ~ is the shell's expansion rather than one node performs" : ""}.`,
			);
			continue;
		}
		const path = said.length > 0 ? said : undefined;
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
export async function loadReviewConfig(
	// Named for a test, and defaulted for everybody else. The reader
	// is otherwise reachable only through the one path the whole
	// machine shares, which a test can redirect but not isolate.
	path?: string,
): Promise<LoadedReviewConfig> {
	const problems: string[] = [];
	const loaded = await loadPackageConfig(path);
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
