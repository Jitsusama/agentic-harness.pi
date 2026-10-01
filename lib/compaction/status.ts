/**
 * How compaction stands right now, gathered from whoever takes part.
 *
 * Compaction is several extensions that never import each other: the
 * workflow and its providers, the selection that adds excerpts, recall
 * that reads what was dropped. Whether they run as designed is spread
 * across all of them, and the session's records only say so after a
 * compaction, which can be hours away. So the status command asks on
 * {@link COMPACTION_STATUS}, and each extension that hears it adds a
 * section of its own. One that is not loaded adds nothing, and that
 * absence is itself the answer.
 *
 * pi's event bus calls listeners synchronously up to their first
 * `await`, so a listener adds its section before doing anything
 * asynchronous, or not at all.
 *
 * The payload is a public contract, so the channel is versioned.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Asked by the status command; each listener adds one section. */
export const COMPACTION_STATUS = "compaction:status:v1";

/** One extension's account of itself. */
export interface StatusSection {
	/** Who answered, by extension or provider id. */
	readonly id: string;
	readonly title: string;
	/** Where the section sits, lowest first. */
	readonly order: number;
	/** Each a `label: value` line, or a plain one. */
	readonly lines: readonly string[];
}

/** What a listener is handed. */
export interface CompactionStatusRequest {
	/** The session's current branch, as `sessionManager.getBranch()` reads it. */
	readonly branch: readonly unknown[];
	/** Where answers go. */
	readonly sections: StatusSection[];
}

/** A compaction on the branch, as much of it as a status needs. */
export interface BranchCompaction {
	readonly summary: string;
	readonly tokensBefore?: number;
	readonly timestamp?: string;
	readonly details: Readonly<Record<string, unknown>>;
}

/** The compactions on a branch, oldest first. */
export function compactionsOn(branch: readonly unknown[]): BranchCompaction[] {
	const found: BranchCompaction[] = [];
	for (const entry of branch) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "compaction" || typeof e.summary !== "string") continue;
		found.push({
			summary: e.summary,
			tokensBefore:
				typeof e.tokensBefore === "number" ? e.tokensBefore : undefined,
			timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined,
			details:
				typeof e.details === "object" && e.details !== null
					? (e.details as Record<string, unknown>)
					: {},
		});
	}
	return found;
}

/** Whether a bus payload is a status request. */
export function isCompactionStatusRequest(
	data: unknown,
): data is CompactionStatusRequest {
	if (typeof data !== "object" || data === null) return false;
	const r = data as Record<string, unknown>;
	return Array.isArray(r.branch) && Array.isArray(r.sections);
}

/**
 * Ask everybody listening how compaction stands, and return their
 * sections in order. A listener that throws loses only its own section.
 */
export function askCompactionStatus(
	bus: Pick<EventBus, "emit">,
	branch: readonly unknown[],
): StatusSection[] {
	const request: CompactionStatusRequest = { branch, sections: [] };
	try {
		bus.emit(COMPACTION_STATUS, request);
	} catch {
		// pi's bus catches what a listener throws; another bus may not,
		// and whatever was added before it threw is still worth showing.
	}
	return [...request.sections].sort((a, b) => a.order - b.order);
}

/**
 * Answer status requests on a bus with a section, built fresh for each
 * request from the branch it carries.
 */
export function answerCompactionStatus(
	bus: Pick<EventBus, "on">,
	section: (branch: readonly unknown[]) => StatusSection | undefined,
): void {
	bus.on(COMPACTION_STATUS, (data: unknown) => {
		if (!isCompactionStatusRequest(data)) return;
		const answer = section(data.branch);
		if (answer) data.sections.push(answer);
	});
}
