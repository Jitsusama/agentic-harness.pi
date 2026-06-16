/**
 * Public types for the quest library.
 *
 * A `Quest` is one node in the hierarchy: a top-level
 * quest, a subquest under another quest, or a free-standing
 * sidequest. A `QuestDocument` is one of the four kinds of
 * focused-work artifact (plan, research, brief, report) that
 * lives under a quest's directory.
 */

export type QuestKind = "quest" | "subquest" | "sidequest";

export type QuestStatus =
	| "active"
	| "paused"
	| "blocked"
	| "concluded"
	| "retired";

export type QuestPriority =
	| "driving"
	| "active"
	| "queued"
	| "bench"
	| "someday";

export type DocumentKind = "plan" | "research" | "brief" | "report";

export type DocumentStage =
	| "think"
	| "draft"
	| "build"
	| "concluded"
	| "retired";

/** Alias to an external system entity. */
export interface QuestAlias {
	type: string;
	value: string;
}

/** Lifecycle status of a pi session attached to a quest. */
export type SessionStatus = "active" | "detached";

/**
 * A working tree the quest owns. The tree's path is the
 * canonical identifier; the other fields let `quest show`
 * render useful state without crawling git.
 */
export interface QuestTree {
	/** Absolute path to the tree's working directory. */
	path: string;
	/** Branch checked out in the tree, when applicable. */
	branch?: string;
	/** Origin repo's root, when the provider knows it. */
	repoRoot?: string;
	/**
	 * Id of the tree provider that created this tree. The
	 * prune side uses this to look up the same provider
	 * later, even when registry order has changed.
	 */
	providerId: string;
	/**
	 * Zones loaded into the tree's sparse checkout, when
	 * the provider supports it. The built-in git-worktree
	 * provider leaves this empty; the world dev-tree
	 * provider tracks `tec checkout add` results here.
	 */
	zones?: string[];
	/**
	 * How this tree came to be on the quest. `scaffolded`
	 * means the tool created it (via `tree-add`) and may
	 * auto-prune it on conclude or retire. `adopted` means a
	 * pre-existing tree the quest only references; it is
	 * never auto-pruned. An absent marker (legacy or
	 * hand-registered) is treated as keep, never auto-pruned.
	 */
	origin?: "scaffolded" | "adopted";
}

/**
 * A prune attempt blocked on safety: dirty state, unmerged
 * branch, attached session. Persisted on the quest so the
 * workflow can resume the conversation after a restart.
 *
 * Stored as an array on `QuestFrontMatter.pendingPrune` so
 * a quest can carry several blocked trees at once (a
 * `retire` may surface more than one).
 */
export interface PendingPrune {
	/** Path of the tree the user is trying to prune. */
	path: string;
	/** Human-readable reason: "dirty", "unmerged", etc. */
	reason: string;
	/** When the prune was attempted. ISO 8601. */
	detectedAt: string;
}

/**
 * A pi session that has driven a quest. The session id is the
 * canonical identifier; the other fields are convenience
 * metadata so a `quest show` can render a useful list without
 * having to cross-reference pi's session log.
 */
export interface QuestSession {
	id: string;
	name?: string;
	cwd?: string;
	started?: string;
	status?: SessionStatus;
}

/** Frontmatter for a quest README. */
export interface QuestFrontMatter {
	id: string;
	kind: QuestKind;
	parent: string | null;
	status: QuestStatus;
	priority: QuestPriority;
	rank: number;
	started: string;
	updated: string;
	due?: string;
	eta?: string;
	aliases: QuestAlias[];
	sessions: QuestSession[];
	trees?: QuestTree[];
	pendingPrune?: PendingPrune[];
	/**
	 * Bag of unrecognised top-level frontmatter keys we read
	 * back from disk so we can write them out unchanged. The
	 * README is human-editable; user-added fields survive
	 * round-trip.
	 */
	_extra?: Record<string, unknown>;
	/**
	 * Document id of the plan the agent first drafts on this
	 * quest. The build-stage tree gate consults this so the
	 * "primary plan" definition is deterministic across
	 * file-system orderings.
	 */
	primaryPlanId?: string;
}

/** Frontmatter for a quest document (plan, research, etc.). */
export interface DocumentFrontMatter {
	id: string;
	kind: DocumentKind;
	quest: string;
	stage: DocumentStage;
	updated: string;
	/**
	 * Round counter for a research doc that records repeated
	 * passes against the same subject (e.g. council reviews).
	 * Persisted in frontmatter so consumers don't have to
	 * count headings in the body to know which round they are
	 * appending.
	 */
	rounds?: number;
	/** Subject tag, e.g. "pr-review". Used for round-trip matching. */
	subject?: string;
	/** Bag of unrecognised top-level keys, mirrored from QuestFrontMatter. */
	_extra?: Record<string, unknown>;
}

/** A parsed quest README. */
export interface QuestDoc {
	frontMatter: QuestFrontMatter;
	body: string;
	/** Title from the body's H1, or undefined when absent. */
	title?: string;
}

/** A parsed quest document (plan/research/brief/report). */
export interface QuestDocumentDoc {
	frontMatter: DocumentFrontMatter;
	body: string;
	title?: string;
}

/** A cast bullet parsed out of a quest README's Cast section. */
export interface CastEntry {
	/** Role keyword (e.g. "owner", "reviewer"). Lowercase. */
	role: string;
	/** The person's name or handle as it appears in the bullet. */
	subject: string;
	/** Prose after the subject, including any inline links. */
	prose: string;
}

/** A journey entry parsed out of the Journey section. */
export interface JourneyEntry {
	date: string;
	prose: string;
}
