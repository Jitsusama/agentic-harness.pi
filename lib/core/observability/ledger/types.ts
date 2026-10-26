import type { RunCost, RunTokens } from "../types.ts";

/**
 * What a turn was billed for: a turn of the agent, the summary of a
 * compaction, or a side call, which is one an extension made to a model
 * off the agent's loop and recorded on an entry of its own, such as
 * classifying the conversation's paragraphs.
 */
export type TurnKind = "assistant" | "compaction" | "side";

/**
 * One billable turn read out of a session log.
 *
 * `cost` is null when the entry carried no usage. That is deliberately
 * distinct from zero: a turn whose provider died before reporting cost an
 * unknown amount, and recording it as free understates every total it
 * appears in.
 */
export interface TurnRecord {
	readonly entryId: string;
	readonly sessionId: string;
	/** ISO 8601, as the log wrote it. */
	readonly timestamp: string;
	readonly kind: TurnKind;
	/** Resolved model id, or empty when the entry did not say. */
	readonly model: string;
	/**
	 * The thinking level the turn ran at, as the log last set it before
	 * the turn, or null when the log never said. Unknown is not a level:
	 * guessing the harness default would put spend on a setting that may
	 * not have been in force.
	 */
	readonly thinkingLevel: string | null;
	readonly tokens: RunTokens;
	/** Null when unmetered. Never coerced to zero. */
	readonly cost: RunCost | null;
	/** Cache writes billed at the one-hour rate, for retention accounting. */
	readonly cacheWrite1h: number;
	/** Compaction only: resident tokens before the cut. */
	readonly droppedBefore: number | null;
	/** Compaction only: the first entry the cut kept, which bounds what it dropped. */
	readonly firstKeptEntryId: string | null;
	/**
	 * Content address of the turn's billable identity. Equal across forked
	 * sessions, which is what lets a corpus-wide total deduplicate the
	 * roughly ten percent of entries that forking copies verbatim.
	 */
	readonly digest: string;
	/**
	 * What the log says about the turn beyond its bill: what came before
	 * it, how long after, and the run it belongs to. Absent when the
	 * harness reading the log does not derive these, which the ledger
	 * keeps as unknown rather than zero.
	 */
	readonly facts?: TurnFacts;
	/** Compaction only: how the summary was written and what surrounded it. */
	readonly compaction?: CompactionFacts;
	/**
	 * The quest in force where the turn sits in its log: its id, null when
	 * the log says none was loaded, and absent when the harness reading
	 * the log does not say. A session moves between quests and puts them
	 * down, so booking a turn to the session's last quest charges one
	 * quest for another's work, and work done after an unload to neither.
	 * Absent falls back to the session's quest.
	 */
	readonly quest?: string | null;
	/**
	 * The document focused where the turn sits, such as a plan's id, in
	 * the same three states as `quest`, with no fallback: a session's
	 * last document is no guess at an earlier turn's.
	 */
	readonly document?: string | null;
}

/**
 * What stood between a turn and the billed turn before it on its branch,
 * reduced to the one that best explains a cache miss. When several
 * apply, the first in this order wins: a compaction, a model change, a
 * change to the tool set, a change to the system prompt, a typed
 * message, a message the harness sent to resume a run, tool results,
 * and nothing at all.
 */
export type TurnPrecedent =
	| "compaction"
	| "model"
	| "tools"
	| "system"
	| "typed"
	| "resume"
	| "results"
	| "nothing";

/**
 * Facts about one turn that the log holds but its usage does not. Every
 * field is null when the log could not say, never a guess.
 */
export interface TurnFacts {
	/** Null for the first billed turn on its branch. */
	readonly precededBy: TurnPrecedent | null;
	/** Milliseconds since the billed turn before it on its branch. */
	readonly gapMs: number | null;
	/**
	 * Tokens new to the prompt since that turn, estimated from what was
	 * added to the conversation in between and the previous turn's own
	 * output. A cache write well beyond this is a miss.
	 */
	readonly newTokens: number | null;
	/** Why the model stopped, as the provider said. */
	readonly stopReason: string | null;
	/** Characters of thinking the turn produced. */
	readonly thinkingChars: number | null;
	/** Characters of visible text the turn produced. */
	readonly textChars: number | null;
	/**
	 * The run the turn belongs to: everything from one typed message to
	 * the next, named by the entry of the message that started it.
	 */
	readonly runId: string | null;
	/**
	 * An assistant turn's position in its run, from one. A compaction's is
	 * how many turns the run had made before it.
	 */
	readonly runTurn: number | null;
}

/** How a compaction's summary was written and what surrounded it. */
export interface CompactionFacts {
	/** Written ahead of the trigger or on the spot, as the harness said. */
	readonly written: string | null;
	/** Which summariser wrote it. */
	readonly summariser: string | null;
	/** How long the summary took to write. */
	readonly summaryMs: number | null;
	/** How long the session waited on it. */
	readonly waitedMs: number | null;
	/** Characters in the summary. */
	readonly summaryChars: number | null;
	/** Whether a request in flight was stopped to compact. */
	readonly abortedRequest: boolean | null;
	/**
	 * Whether the harness resumed the run afterwards. Null until the log
	 * shows the next message, since an unfinished log cannot say.
	 */
	readonly resumed: boolean | null;
	/** Milliseconds since the last typed message. */
	readonly sinceTypedMs: number | null;
}

/** The rows a read-only ledger query returned, in column order. */
export interface QueryAnswer {
	readonly columns: readonly string[];
	readonly rows: readonly Record<string, unknown>[];
}

/**
 * One tool call, addressed by what it asked rather than what it got
 * back, with no bytes of either kept.
 *
 * The digests are what make repetition visible: a call whose arguments
 * digest to something already asked in the same session asked a
 * question that session's context could already answer. That is waste
 * with no value judgement in it, which is what makes it safe to act on.
 */
export interface ToolCallRecord {
	/** Content address of the call, stable across a forked log. */
	readonly digest: string;
	readonly sessionId: string;
	/** The assistant entry that made the call. */
	readonly entryId: string;
	/** The call's own id, which its result names. */
	readonly callId: string;
	readonly timestamp: string;
	readonly name: string;
	/** Digest of the arguments, never the arguments. */
	readonly argsDigest: string;
	/**
	 * What kind of verifier this call ran, if it ran one at all. Classified
	 * from the command text at scan time, before that text is digested
	 * away, so this is the one place any of it survives, and only as a
	 * category. A chained gate running more than one kind is `verify`
	 * rather than a pick of one, since one exit code cannot support the
	 * precision of naming a single kind.
	 */
	readonly verifierKind: VerifierKind | null;
	/** The file the call declared, when it declared one. */
	readonly path: string | null;
	/** Characters the result came back with, or null if it never came. */
	readonly resultChars: number | null;
	/** Digest of the result text, or null if it never came. */
	readonly resultDigest: string | null;
	/** Whether the result came back an error. Null when it never came. */
	readonly isError: boolean | null;
}

/**
 * What kind of verifier a call ran. `verify` names a chained gate that
 * ran more than one kind under a single exit code, which is a category
 * of its own rather than a guess at which one kind mattered.
 */
export type VerifierKind = "test" | "build" | "typecheck" | "lint" | "verify";

/** How a kind of verifier fared across every call classified as it. */
export interface VerifierOutcome {
	readonly kind: VerifierKind;
	readonly passed: number;
	readonly failed: number;
	/** Calls whose result never arrived, so pass or fail is unknown. */
	readonly unknown: number;
}

/**
 * How real compactions compare against the payback test, replayed over
 * turns already in the ledger rather than watched live. `evaluable`
 * excludes a compaction with no turn after it (nothing to measure
 * retention from) or whose model has no derivable rate yet.
 */
export interface PaybackReplay {
	readonly compactions: number;
	readonly evaluable: number;
	/** The test would also have fired. */
	readonly agreed: number;
	/** The test would have declined what actually happened. */
	readonly disagreed: number;
}

/**
 * A tool call a compaction dropped from context, and where it happened.
 *
 * Recorded at the compaction rather than guessed at later, because the
 * boundary a compaction drew is known precisely then and only then: the
 * entry it names as first kept is a fact about that one event, not
 * something a later query could reconstruct from the calls alone.
 */
export interface DroppedCallRecord {
	/** The call that was dropped, addressing the same row in tool_calls. */
	readonly callDigest: string;
	readonly sessionId: string;
	/** The compaction entry that dropped it. */
	readonly droppedAtEntryId: string;
	readonly droppedAtTimestamp: string;
}

/**
 * Which calls a repeat or regret query is about, and what counts as a
 * file changing underneath them. Both lists are the caller's, because
 * which tools retrieve and which ones write is a fact about a harness's
 * tool set, not about the ledger.
 */
export interface CallScope {
	/**
	 * Tools whose result is information, so asking again means the
	 * information was needed again. Absent means every tool, which also
	 * counts re-issued actions and so overstates both measures.
	 */
	readonly retrieval?: readonly string[];
	/**
	 * Tools that change the file a call declares. A read repeated after one
	 * of these touched the same path fetched something new, so it is
	 * neither a repeat nor a regret. Absent means no call is treated as a
	 * write.
	 */
	readonly writers?: readonly string[];
}

/**
 * A dropped call that was asked again afterward: the earlier answer was
 * discarded and the same question was put a second time. No claim about
 * whether the second asking was necessary, only that it happened.
 * Counted once per dropped call, at its first re-ask.
 */
export interface Regret {
	readonly name: string;
	readonly argsDigest: string;
	readonly sessionId: string;
	readonly droppedAtTimestamp: string;
	readonly reAskedAtTimestamp: string;
	readonly resultChars: number | null;
}

/**
 * Regret with its denominator, since a count of re-asks means nothing
 * without how many drops it could have been out of.
 */
export interface RegretReport {
	/** Dropped calls within the scope asked about. */
	readonly inScope: number;
	/** Those of them asked again after the drop, earliest re-ask first. */
	readonly reAsked: Regret[];
}

/**
 * Arguments asked more than once inside one session, and what the
 * repeats weighed.
 */
export interface RepeatedCall {
	readonly argsDigest: string;
	readonly name: string;
	/** How many times these arguments were asked. */
	readonly asked: number;
	/** How many of those were repeats, so one less than asked. */
	readonly repeated: number;
	/** Characters the repeats re-admitted to the context. */
	readonly repeatedChars: number;
	/** Repeats with no verifier since the last ask: the waste bucket. */
	readonly rework: number;
	/** Characters the rework repeats re-admitted. */
	readonly reworkChars: number;
	/**
	 * Repeats that are themselves a verifier, or that follow one run
	 * since the last ask: the model checking its work, which is cost of
	 * quality rather than waste.
	 */
	readonly appraisal: number;
	/** Characters the appraisal repeats re-admitted. */
	readonly appraisalChars: number;
}

/**
 * What a session log says about itself.
 *
 * Every field but the id may be absent, and absent is kept rather than
 * guessed: attributing spend to a repo or a quest the log never named
 * would charge work that did not incur it.
 */
export interface SessionRecord {
	readonly sessionId: string;
	/** The working directory the log named, if it named one. */
	readonly cwd: string | null;
	/** The repo that directory belongs to, derived from it. */
	readonly repo: string | null;
	/** The quest the session was working under, if any. */
	readonly quest: string | null;
	/** Timestamp of the earliest billed turn. */
	readonly firstSeen: string | null;
	/** Timestamp of the latest billed turn. */
	readonly lastSeen: string | null;
}
