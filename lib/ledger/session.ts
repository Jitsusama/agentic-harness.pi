import type { SessionRecord } from "@jitsusama/agentic-harness.core/observability";

/** Where a per-host checkout tree begins, as `src/{host}/{owner}/{repo}`. */
const CHECKOUT_MARKER = "/src/";
/** Where a monorepo worktree begins, as `world/trees/{tree}/src/{zone}`. */
const MONOREPO_MARKER = "/world/trees/";
/** Segments naming a repo under the checkout marker: host, owner, name. */
const REPO_SEGMENTS = 3;

/**
 * Name the repo a working directory belongs to, or nothing when the path
 * names none.
 *
 * A monorepo zone is named by the zone rather than the worktree it was
 * cut into, because two trees of the same zone are the same subject and
 * naming the tree would split one zone's spend across every tree ever
 * cut for it.
 */
export function repoOf(cwd: string | null): string | null {
	if (!cwd) return null;

	const monorepo = cwd.indexOf(MONOREPO_MARKER);
	if (monorepo >= 0) {
		const tail = cwd.slice(monorepo + MONOREPO_MARKER.length);
		const zone = tail.split("/src/")[1];
		return zone ? `world/${zone}` : null;
	}

	const checkout = cwd.indexOf(CHECKOUT_MARKER);
	if (checkout >= 0) {
		const parts = cwd
			.slice(checkout + CHECKOUT_MARKER.length)
			.split("/")
			.filter(Boolean);
		if (parts.length >= REPO_SEGMENTS) {
			return parts.slice(0, REPO_SEGMENTS).join("/");
		}
	}

	return null;
}

/**
 * Accumulates what a log says about its session as the log is read, so
 * one pass serves both the turns and their attribution.
 */
export class SessionCollector {
	private cwd: string | null = null;
	private quest: string | null = null;
	private first: string | null = null;
	private last: string | null = null;

	constructor(private readonly sessionId: string) {}

	/**
	 * Take the working directory from a session's header entry. Every log
	 * opens with one, which is what makes attribution complete rather than
	 * limited to the quarter of sessions that also name a quest.
	 */
	observeHeader(entry: Record<string, unknown>): void {
		if (typeof entry.cwd === "string") this.cwd = entry.cwd;
	}

	/**
	 * Take the working directory and quest a workflow entry names. The
	 * last one wins, because a session can be re-pointed at another quest
	 * part way through and the later statement is the current one.
	 */
	observeWorkflow(data: Record<string, unknown>): void {
		if (typeof data.cwd === "string") this.cwd = data.cwd;
		if (typeof data.questId === "string") this.quest = data.questId;
	}

	/** Widen the span to include a billed turn. */
	observeTurn(timestamp: string): void {
		if (!timestamp) return;
		if (!this.first || timestamp < this.first) this.first = timestamp;
		if (!this.last || timestamp > this.last) this.last = timestamp;
	}

	record(): SessionRecord {
		return {
			sessionId: this.sessionId,
			cwd: this.cwd,
			repo: repoOf(this.cwd),
			quest: this.quest,
			firstSeen: this.first,
			lastSeen: this.last,
		};
	}
}
