/**
 * What the user gets to decide about provider selection.
 *
 * Two knobs, both of which exist because guessing is worse
 * than asking. A repo mapping pins a repo to a provider with
 * ordered fallbacks, which is what a migration needs: while
 * one repo lives on two backends at once, the person doing
 * the work is the only one who knows which of them is the
 * real one today. A reference mapping teaches the substrate
 * a URL or short form no provider recognizes, so an internal
 * link shape can be adopted without shipping code.
 */

/** Pins a repo to providers, first registered one winning. */
export interface RepoMapping {
	/**
	 * Matched as a substring against the checkout path and
	 * each of its remote URLs. Substring rather than a
	 * pattern because the thing people have to hand is a repo
	 * name, and `Shopify/world` should just work.
	 */
	match: string;
	/**
	 * Provider ids in preference order. Ids that are not
	 * registered are skipped, which is what makes this safe
	 * to write before the provider ships.
	 */
	providers: string[];
	/**
	 * Where this repo is checked out, for reading it.
	 *
	 * Without it, the only repo reviewable from a session is
	 * the one the session is sitting in: a round elsewhere
	 * either reads the wrong project or, since that was
	 * stopped, refuses. Nothing else can supply this, because
	 * which directory holds a repo is a fact about this
	 * machine and no provider knows it.
	 */
	path?: string;
}

/** Teaches the substrate a reference shape. */
export interface ReferenceMapping {
	/**
	 * Regular expression matched against the whole reference.
	 * Named groups `repo` and `id` are read when present.
	 */
	pattern: string;
	/** Provider to hand the match to. */
	provider: string;
	/** Repo key to use when the pattern names no `repo`. */
	repo?: string;
}

/** The `review` section of the package config. */
export interface ReviewConfig {
	repos?: RepoMapping[];
	references?: ReferenceMapping[];
}

/** What parsing the section produced, and anything wrong with it. */
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

/**
 * Parse the `review` section of the package config, reporting
 * anything malformed.
 *
 * Pure: the section is handed in already read, so this has no
 * opinion about where the package config file lives or how it is
 * loaded from disk — that is a host adapter's job.
 */
export function parseReviewSection(section: unknown): LoadedReviewConfig {
	if (section === undefined) return { config: {}, problems: [] };
	if (!isRecord(section)) {
		return {
			config: {},
			problems: ["The review config section should be an object."],
		};
	}
	const problems: string[] = [];
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
