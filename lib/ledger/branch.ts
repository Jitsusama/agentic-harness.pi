import type {
	CompactionFacts,
	TurnFacts,
	TurnPrecedent,
} from "@jitsusama/agentic-harness.core/observability";
import { isResumeText } from "../compaction/resume.ts";

/**
 * The same rough ratio pi's own compaction estimates with. Good enough
 * to tell a turn that wrote what was new from one that wrote the whole
 * context again, which is all a miss needs.
 */
const CHARS_PER_TOKEN = 4;

/** What an image costs the prompt, in characters of the same estimate. */
const IMAGE_CHARS = 1500 * CHARS_PER_TOKEN;

/**
 * What can stand between two billed turns, in the order that decides
 * which one a turn is said to follow. Earlier explains a miss better:
 * a compaction rewrites the context whatever else happened, and a model
 * change starts a new cache.
 */
const PRECEDENCE: readonly Exclude<TurnPrecedent, "nothing">[] = [
	"compaction",
	"model",
	"tools",
	"system",
	"typed",
	"resume",
	"results",
];

/** A compaction's facts, open until the log says whether its run resumed. */
type OpenCompaction = {
	-readonly [K in keyof CompactionFacts]: CompactionFacts[K];
};

/**
 * What a branch has seen since its last billed turn. One is kept per
 * entry and inherited through `parentId`, since a log is a tree: reading
 * in line order would carry a sibling branch's history into this one.
 */
interface BranchState {
	/** When the last billed turn on this branch ran, in epoch ms. */
	readonly lastTurnAt: number | null;
	/** That turn's output tokens, which the next prompt carries. */
	readonly lastOutput: number;
	/** Characters added to the conversation since, by estimate. */
	readonly addedChars: number;
	/** What stood between that turn and now. */
	readonly seen: ReadonlySet<TurnPrecedent>;
	/** The run under way, and how many turns it has made. */
	readonly runId: string | null;
	readonly runTurns: number;
	/** When somebody last typed, in epoch ms. */
	readonly lastTypedAt: number | null;
	/** Whether the last message was a request stopped in flight. */
	readonly lastAborted: boolean;
	/** A compaction still waiting to learn whether its run resumed. */
	readonly awaiting: OpenCompaction | null;
}

const ROOT: BranchState = {
	lastTurnAt: null,
	lastOutput: 0,
	addedChars: 0,
	seen: new Set(),
	runId: null,
	runTurns: 0,
	lastTypedAt: null,
	lastAborted: false,
	awaiting: null,
};

/** What one entry contributed to the turn it is, if it is one. */
export interface BranchStep {
	readonly facts?: TurnFacts;
	readonly compaction?: CompactionFacts;
}

/**
 * Walks a session log's entries along their branches and says, for each
 * turn, what came before it: the facts a cache miss, a run and a
 * compaction are measured by, none of which the turn's own usage holds.
 */
export class BranchWalk {
	private readonly states = new Map<string, BranchState>();

	/** Take one entry, in log order, and return what it contributed. */
	step(entry: Record<string, unknown>): BranchStep {
		const before =
			typeof entry.parentId === "string"
				? (this.states.get(entry.parentId) ?? ROOT)
				: ROOT;
		const { after, step } = advance(before, entry);
		if (typeof entry.id === "string") this.states.set(entry.id, after);
		return step;
	}
}

function advance(
	before: BranchState,
	entry: Record<string, unknown>,
): { after: BranchState; step: BranchStep } {
	const at = timeOf(entry.timestamp);
	if (entry.type === "compaction") return compacted(before, entry, at);
	if (entry.type === "model_change") {
		// The first model a branch names is not a change: nothing was cached
		// under another one yet.
		if (before.lastTurnAt === null) return { after: before, step: {} };
		return { after: noting(before, "model"), step: {} };
	}
	if (entry.type === "custom_message") {
		return {
			after: {
				...before,
				addedChars: before.addedChars + charsOf(entry.content),
			},
			step: {},
		};
	}
	if (entry.type !== "message") return { after: before, step: {} };

	const message = asRecord(entry.message);
	switch (message?.role) {
		case "assistant":
			return turned(before, message, at);
		case "user":
			return userSaid(before, message, entry, at);
		case "toolResult":
			return {
				after: {
					...noting(before, "results"),
					addedChars: before.addedChars + charsOf(message.content),
					lastAborted: false,
				},
				step: {},
			};
		case "system": {
			const changedTools =
				nonEmpty(message.toolsAdded) || nonEmpty(message.toolsRemoved);
			return {
				after: noting(before, changedTools ? "tools" : "system"),
				step: {},
			};
		}
		default:
			return { after: before, step: {} };
	}
}

function turned(
	before: BranchState,
	message: Record<string, unknown>,
	at: number | null,
): { after: BranchState; step: BranchStep } {
	const usage = asRecord(message.usage);
	const context =
		numberOf(usage?.input) +
		numberOf(usage?.cacheRead) +
		numberOf(usage?.cacheWrite);
	const stopReason =
		typeof message.stopReason === "string" ? message.stopReason : null;
	const runTurn = before.runTurns + 1;
	const aborted =
		(stopReason === "aborted" || stopReason === "error") &&
		typeof message.errorMessage === "string" &&
		message.errorMessage.toLowerCase().includes("abort");
	const [thinkingChars, textChars] = outputChars(message.content);
	const settled = before.awaiting;
	// A run that carried on with no message at all was not resumed by the
	// harness, whatever carried it.
	if (settled && settled.resumed === null) settled.resumed = false;

	// A request that never reached the model sent no prompt, so it has no
	// miss to measure and does not become the turn the next one follows.
	const billed = context > 0 && at !== null;
	const follows = billed && before.lastTurnAt !== null;
	const facts: TurnFacts = {
		precededBy: follows ? precedentOf(before.seen) : null,
		gapMs:
			follows && before.lastTurnAt !== null ? at - before.lastTurnAt : null,
		newTokens: follows
			? Math.round(before.addedChars / CHARS_PER_TOKEN) + before.lastOutput
			: null,
		stopReason,
		thinkingChars,
		textChars,
		runId: before.runId,
		runTurn: before.runId === null ? null : runTurn,
	};
	const after: BranchState = billed
		? {
				...before,
				lastTurnAt: at,
				lastOutput: numberOf(usage?.output),
				addedChars: 0,
				seen: new Set(),
				runTurns: runTurn,
				lastAborted: aborted,
				awaiting: null,
			}
		: { ...before, runTurns: runTurn, lastAborted: aborted, awaiting: null };
	return { after, step: { facts } };
}

function userSaid(
	before: BranchState,
	message: Record<string, unknown>,
	entry: Record<string, unknown>,
	at: number | null,
): { after: BranchState; step: BranchStep } {
	const resume = isResumeText(textOf(message.content));
	if (before.awaiting && before.awaiting.resumed === null) {
		before.awaiting.resumed = resume;
	}
	const added = before.addedChars + charsOf(message.content);
	if (resume) {
		return {
			after: {
				...noting(before, "resume"),
				addedChars: added,
				lastAborted: false,
				awaiting: null,
			},
			step: {},
		};
	}
	// A typed message starts a run. It is named by its entry and its time
	// together, which a fork copies verbatim, so a run split across forked
	// logs is still one run.
	const id = typeof entry.id === "string" ? entry.id : "";
	const stamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
	return {
		after: {
			...noting(before, "typed"),
			addedChars: added,
			runId: `${stamp}#${id}`,
			runTurns: 0,
			lastTypedAt: at,
			lastAborted: false,
			awaiting: null,
		},
		step: {},
	};
}

function compacted(
	before: BranchState,
	entry: Record<string, unknown>,
	at: number | null,
): { after: BranchState; step: BranchStep } {
	const details = asRecord(entry.details);
	const compaction: OpenCompaction = {
		written: stringOf(details?.written),
		summariser: stringOf(details?.summariser),
		summaryMs: finiteOf(details?.summaryMs),
		waitedMs: finiteOf(details?.waitedMs),
		summaryChars:
			typeof entry.summary === "string" ? entry.summary.length : null,
		abortedRequest: before.lastAborted,
		resumed: null,
		sinceTypedMs:
			at !== null && before.lastTypedAt !== null
				? at - before.lastTypedAt
				: null,
	};
	const facts: TurnFacts = {
		precededBy: before.lastTurnAt === null ? null : precedentOf(before.seen),
		gapMs:
			at !== null && before.lastTurnAt !== null ? at - before.lastTurnAt : null,
		newTokens: null,
		stopReason: null,
		thinkingChars: null,
		textChars: null,
		runId: before.runId,
		runTurn: before.runId === null ? null : before.runTurns,
	};
	return {
		after: { ...noting(before, "compaction"), awaiting: compaction },
		step: { facts, compaction },
	};
}

function noting(before: BranchState, precedent: TurnPrecedent): BranchState {
	if (before.seen.has(precedent)) return before;
	return { ...before, seen: new Set([...before.seen, precedent]) };
}

function precedentOf(seen: ReadonlySet<TurnPrecedent>): TurnPrecedent {
	return PRECEDENCE.find((precedent) => seen.has(precedent)) ?? "nothing";
}

/** Characters of thinking and of visible text an assistant message holds. */
function outputChars(content: unknown): [number, number] {
	if (!Array.isArray(content)) return [0, 0];
	let thinking = 0;
	let text = 0;
	for (const block of content) {
		const b = asRecord(block);
		if (b?.type === "thinking" && typeof b.thinking === "string") {
			thinking += b.thinking.length;
		} else if (b?.type === "text" && typeof b.text === "string") {
			text += b.text.length;
		}
	}
	return [thinking, text];
}

/** What a message's content adds to the prompt, images included. */
function charsOf(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		const b = asRecord(block);
		if (b?.type === "text" && typeof b.text === "string")
			chars += b.text.length;
		else if (b?.type === "image") chars += IMAGE_CHARS;
	}
	return chars;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = asRecord(block);
			return b?.type === "text" && typeof b.text === "string" ? b.text : "";
		})
		.join("");
}

function timeOf(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : at;
}

function nonEmpty(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
