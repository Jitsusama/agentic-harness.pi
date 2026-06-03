/**
 * Public types for the quest library.
 *
 * A `Quest` is one node in the hierarchy: a top-level
 * quest, a subquest under another quest, or a free-standing
 * sidequest. A `QuestDocument` is one of the four kinds of
 * focused-work artifact (plan, research, brief, report) that
 * lives under a quest's directory.
 */

import type { IdPrefix } from "../internal/quest/id.js";

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
}

/**
 * A prune attempt blocked on safety: dirty state, unmerged
 * branch, attached session. Persisted on the quest so the
 * workflow can resume the conversation after a restart.
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
	pendingPrune?: PendingPrune;
}

/** Frontmatter for a quest document (plan, research, etc.). */
export interface DocumentFrontMatter {
	id: string;
	kind: DocumentKind;
	quest: string;
	stage: DocumentStage;
	updated: string;
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

/** Map from ID prefix to document kind. Useful for routing. */
export const PREFIX_TO_KIND: Record<IdPrefix, QuestKind | DocumentKind> = {
	QEST: "quest",
	PLAN: "plan",
	RSCH: "research",
	BRIF: "brief",
	RPRT: "report",
};
