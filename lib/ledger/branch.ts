import { isResumeText } from "../compaction/resume.ts";
import type {
	CompactionFacts,
	TurnFacts,
	TurnPrecedent,
} from "../core/observability/index.ts";
import { isAutomatedText } from "../internal/automated.ts";
import { LOADED_MESSAGE } from "../internal/reload/loaded.ts";
import {
	SERVED_ENTRY,
	type Served,
	servedFrom,
} from "../internal/session/served.ts";

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
 * change starts a new cache. A reload comes after the prompt changes it
 * may bring, which say more exactly what changed; whether one happened
 * is kept beside the precedent, as `reloaded`.
 */
const PRECEDENCE: readonly Exclude<TurnPrecedent, "nothing">[] = [
	"compaction",
	"model",
	"tools",
	"system",
	"reload",
	"typed",
	"resume",
	"results",
];

/** A compaction's facts, open until the log says whether its run resumed. */
export type OpenCompaction = {
	-readonly [K in keyof CompactionFacts]: CompactionFacts[K];
};

/**
 * What a branch has seen since its last billed turn. One is kept per
 * entry and inherited through `parentId`, since a log is a tree: reading
 * in line order would carry a sibling branch's history into this one.
 */
export interface BranchState {
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
	/** Who the session last said served it, kept across turns. */
	readonly served: Served | null;
	/** The account that served the last billed turn, when known. */
	readonly lastAccount: string | null;
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
	served: null,
	lastAccount: null,
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
	private readonly states: Map<string, BranchState>;

	/** Walk from the log's start, or on from each entry's state a walk left. */
	constructor(from?: ReadonlyMap<string, BranchState>) {
		this.states = new Map(from);
	}

	/** Each entry's state so far, for a later walk to carry on from. */
	soFar(): ReadonlyMap<string, BranchState> {
		return this.states;
	}

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
	if (entry.type === "custom" && entry.customType === SERVED_ENTRY) {
		const served = servedFrom(entry.data);
		return { after: served ? { ...before, served } : before, step: {} };
	}
	if (entry.type === "custom_message") {
		const seen =
			entry.customType === LOADED_MESSAGE ? noting(before, "reload") : before;
		return {
			after: {
				...seen,
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
		reloaded: follows ? before.seen.has("reload") : null,
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
		...servedFacts(before, follows),
	};
	const after: BranchState = billed
		? {
				...before,
				lastAccount: before.served?.account ?? null,
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
	// Any other turn the harness started, a background job reporting, is
	// that work's results arriving, inside the run somebody typed.
	if (isAutomatedText(textOf(message.content))) {
		return {
			after: { ...noting(before, "results"), addedChars: added },
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
		reloaded: before.lastTurnAt === null ? null : before.seen.has("reload"),
		gapMs:
			at !== null && before.lastTurnAt !== null ? at - before.lastTurnAt : null,
		newTokens: null,
		stopReason: null,
		thinkingChars: null,
		textChars: null,
		runId: before.runId,
		runTurn: before.runId === null ? null : before.runTurns,
		...servedFacts(before, false),
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

/**
 * Who served a turn, and whether another account did than the billed turn
 * before, when it `follows` one and both accounts are known.
 */
function servedFacts(
	before: BranchState,
	follows: boolean,
): Pick<
	TurnFacts,
	"servedBackend" | "servedAccount" | "servedEdge" | "accountChanged"
> {
	const account = before.served?.account ?? null;
	return {
		servedBackend: before.served?.backend ?? null,
		servedAccount: account,
		servedEdge: before.served?.edge ?? null,
		accountChanged:
			follows && account !== null && before.lastAccount !== null
				? account !== before.lastAccount
				: null,
	};
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
