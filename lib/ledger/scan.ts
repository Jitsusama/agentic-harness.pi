import { createHash } from "node:crypto";
import type {
	RunCost,
	RunTokens,
	TurnKind,
	TurnRecord,
} from "@jitsusama/agentic-harness.core/observability";
import { SessionCollector } from "./session.js";
import type { DroppedCallRecord, LedgerScan, ToolCallRecord } from "./types.js";

/** Width of a stored content address. 96 bits is ample for a corpus of
 * a few million turns and keeps the index small. */
const DIGEST_CHARS = 24;

/**
 * What this scan extracts, as a number. Bump it whenever `readTurns`
 * starts extracting something it did not before, or extracts something
 * differently: an index built by an older scan is then read again in
 * full, which is idempotent, rather than trusted as complete because
 * the log it came from has not grown.
 *
 * 1: turns, sessions, tool calls, dropped calls, verifier kinds and the
 * model a compaction ran under.
 */
export const SCAN_VERSION = 1;

interface RawUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	totalTokens?: number;
	cost?: Record<string, number | undefined>;
}

/**
 * Read billable turns out of a session log's lines.
 *
 * Every line is offered to the parser and every outcome is counted, so a
 * malformed line costs one entry rather than the remainder of the file.
 * Both places a turn can carry usage are read: assistant turns hold it
 * under `message`, and compactions hold it at the top level beside
 * `type`.
 */
export function readTurns(
	sessionId: string,
	lines: Iterable<string>,
): LedgerScan {
	const turns: TurnRecord[] = [];
	// Keyed by call id so a result can find the call it answers. A call
	// whose result never arrives stays in the list with an unknown
	// result rather than being dropped: the call still happened.
	const calls = new Map<string, MutableCall>();
	// The order every entry with an id was seen in, which is what makes a
	// compaction's firstKeptEntryId comparable to a call's own entry:
	// entry ids are not sortable strings, but the log's own line order is
	// the session's real timeline.
	const entryOrder = new Map<string, number>();
	// Compaction boundaries in the order they happened. A boundary only
	// ever moves forward, so the first one after a call's order is the
	// one compaction that actually dropped it.
	const boundaries: Array<{
		order: number;
		entryId: string;
		timestamp: string;
	}> = [];
	const session = new SessionCollector(sessionId);
	let count = 0;
	let parsed = 0;
	let unparseable = 0;
	let billable = 0;
	let unmetered = 0;
	// A CompactionEntry carries no model field of its own, so without
	// this every compaction turn's model would be empty, with nothing
	// for a later join to a model's billed rate to join on.
	let lastModel = "";

	for (const line of lines) {
		count += 1;
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value !== "object" || value === null) {
				unparseable += 1;
				continue;
			}
			entry = value as Record<string, unknown>;
		} catch {
			// A truncated or interleaved write. Counted, never fatal: one
			// unreadable line once reduced a corpus-wide total to a tenth
			// of the truth by aborting the pipeline that met it.
			unparseable += 1;
			continue;
		}
		parsed += 1;
		if (typeof entry.id === "string" && !entryOrder.has(entry.id)) {
			entryOrder.set(entry.id, entryOrder.size);
		}

		if (entry.type === "session") {
			session.observeHeader(entry);
			continue;
		}

		if (entry.customType === "quest-workflow") {
			const data = asRecord(entry.data);
			if (data) session.observeWorkflow(data);
			continue;
		}

		const message = asRecord(entry.message);
		if (message?.role === "toolResult") {
			absorbResult(calls, message);
			continue;
		}

		const turn = turnFrom(sessionId, entry, lastModel);
		if (!turn) continue;
		if (turn.kind === "assistant" && turn.model) lastModel = turn.model;
		session.observeTurn(turn.timestamp);
		turns.push(turn);
		if (turn.cost) billable += 1;
		else unmetered += 1;
		collectCalls(calls, sessionId, turn.entryId, turn.timestamp, message);
		if (turn.kind === "compaction" && turn.firstKeptEntryId) {
			const order = entryOrder.get(turn.firstKeptEntryId);
			// An entry this scan never saw cannot be placed on the
			// timeline, so nothing is dropped on its account rather than
			// guessed at.
			if (order !== undefined) {
				boundaries.push({
					order,
					entryId: turn.entryId,
					timestamp: turn.timestamp,
				});
			}
		}
	}

	return {
		turns,
		calls: [...calls.values()],
		dropped: droppedCallsOf(sessionId, calls, entryOrder, boundaries),
		coverage: { lines: count, parsed, unparseable, billable, unmetered },
		session: session.record(),
	};
}

/**
 * Which calls each compaction dropped: a call is dropped by the first
 * boundary whose kept entry comes after it, since a boundary only ever
 * moves forward and the earliest one to pass a call is the one that
 * actually superseded it.
 */
function droppedCallsOf(
	sessionId: string,
	calls: ReadonlyMap<string, MutableCall>,
	entryOrder: ReadonlyMap<string, number>,
	boundaries: readonly { order: number; entryId: string; timestamp: string }[],
): DroppedCallRecord[] {
	if (boundaries.length === 0) return [];
	const ordered = [...boundaries].sort((a, b) => a.order - b.order);
	const dropped: DroppedCallRecord[] = [];
	for (const call of calls.values()) {
		const callOrder = entryOrder.get(call.entryId);
		if (callOrder === undefined) continue;
		const boundary = ordered.find((b) => b.order > callOrder);
		if (!boundary) continue;
		dropped.push({
			callDigest: call.digest,
			sessionId,
			droppedAtEntryId: boundary.entryId,
			droppedAtTimestamp: boundary.timestamp,
		});
	}
	return dropped;
}

function turnFrom(
	sessionId: string,
	entry: Record<string, unknown>,
	/**
	 * The most recently seen assistant model in this session, used when
	 * an entry carries no model of its own. Only a compaction entry does
	 * this today, since a CompactionEntry has no model field to read.
	 */
	fallbackModel: string,
): TurnRecord | null {
	const kind = kindOf(entry);
	if (!kind) return null;
	const message = asRecord(entry.message);
	const usage = asRecord(
		kind === "compaction" ? entry.usage : message?.usage,
	) as RawUsage | null;

	const entryId = typeof entry.id === "string" ? entry.id : "";
	const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
	const model =
		typeof message?.model === "string"
			? (message.model as string)
			: fallbackModel;

	return {
		entryId,
		sessionId,
		timestamp,
		kind,
		model,
		tokens: tokensFrom(usage),
		cost: costFrom(usage),
		cacheWrite1h: usage?.cacheWrite1h ?? 0,
		droppedBefore:
			kind === "compaction" && typeof entry.tokensBefore === "number"
				? entry.tokensBefore
				: null,
		firstKeptEntryId:
			typeof entry.firstKeptEntryId === "string"
				? entry.firstKeptEntryId
				: null,
		digest: digestOf(entryId, timestamp, kind, usage),
	};
}

/**
 * Which turns are billable at all. An assistant turn and a compaction
 * both cost money; a user message, a tool result and a state change do
 * not. Enumerated rather than filtered, so a new entry type is ignored
 * by omission instead of silently swept into a total.
 */
function kindOf(entry: Record<string, unknown>): TurnKind | null {
	if (entry.type === "compaction") return "compaction";
	const message = asRecord(entry.message);
	if (message?.role === "assistant") return "assistant";
	return null;
}

function tokensFrom(usage: RawUsage | null): RunTokens {
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const cacheWrite = usage?.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
	};
}

/** Null when the entry reported no cost, which is not the same as free. */
function costFrom(usage: RawUsage | null): RunCost | null {
	const cost = usage?.cost;
	if (!cost || typeof cost.total !== "number") return null;
	return {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
		total: cost.total,
	};
}

/**
 * Address a turn by what it is rather than where it was found. Forking a
 * session copies entries verbatim, ids included, so the same turn appears
 * in several files and a naive count bills it more than once.
 */
function digestOf(
	entryId: string,
	timestamp: string,
	kind: TurnKind,
	usage: RawUsage | null,
): string {
	const canonical = JSON.stringify([
		entryId,
		timestamp,
		kind,
		usage?.cost?.total ?? null,
		usage?.totalTokens ?? null,
	]);
	return createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, DIGEST_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

/** A call being assembled: made on one entry, answered on a later one. */
type MutableCall = {
	-readonly [K in keyof ToolCallRecord]: ToolCallRecord[K];
};

/**
 * Arguments that name a file. Only these three tools declare one; bash
 * is larger than all of them together and declares nothing, so what it
 * touches is absent here rather than guessed at from a command line.
 */
const PATH_ARG = "path";

/**
 * Command substrings that mark a verifier of each kind, checked against
 * the raw command text at scan time, before that text is digested away.
 * Drawn from a census of the real corpus rather than guessed: `go test`
 * and `go build` dominate it, and every entry here was seen there.
 */
const VERIFIER_PATTERNS: ReadonlyArray<{
	kind: "test" | "build" | "typecheck" | "lint";
	matches: readonly string[];
}> = [
	{
		kind: "test",
		matches: [
			"go test",
			"cargo test",
			"pytest",
			"rspec",
			"vitest",
			"jest",
			"npm test",
			"npm run test",
			"pnpm test",
			"pnpm run test",
		],
	},
	{
		kind: "build",
		matches: [
			"go build",
			"cargo build",
			"npm run build",
			"pnpm build",
			"pnpm run build",
			"make ",
		],
	},
	{
		kind: "typecheck",
		matches: ["tsc ", "tsc--", "npm run typecheck", "pnpm typecheck", "mypy"],
	},
	{
		kind: "lint",
		matches: [
			"eslint",
			"biome",
			"golangci-lint",
			"rubocop",
			"ruff",
			"npm run lint",
			"pnpm lint",
			"pnpm run lint",
		],
	},
];

/**
 * Which kind of verifier a bash command ran, if any. A command matching
 * more than one kind, the shape of a chained gate running lint, a
 * typecheck and a test suite under one exit code, is `verify` rather
 * than a pick of one: one exit code cannot support the precision of
 * naming a single kind.
 */
function classifyVerifier(
	name: string,
	command: unknown,
): "test" | "build" | "typecheck" | "lint" | "verify" | null {
	if (name !== "bash" || typeof command !== "string") return null;
	const kinds = new Set<string>();
	for (const { kind, matches } of VERIFIER_PATTERNS) {
		if (matches.some((m) => command.includes(m))) kinds.add(kind);
	}
	if (kinds.size === 0) return null;
	if (kinds.size > 1) return "verify";
	const [only] = kinds;
	return only as "test" | "build" | "typecheck" | "lint";
}

/** Take every tool call an assistant turn made. */
function collectCalls(
	into: Map<string, MutableCall>,
	sessionId: string,
	entryId: string,
	timestamp: string,
	message: Record<string, unknown> | null,
): void {
	const content = message?.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		const b = asRecord(block);
		if (b?.type !== "toolCall") continue;
		const callId = typeof b.id === "string" ? b.id : "";
		const name = typeof b.name === "string" ? b.name : "?";
		const args = asRecord(b.arguments);
		const declared = args?.[PATH_ARG];
		const command = args?.command;
		into.set(callId, {
			// The tool's name is inside the address, so the same arguments
			// to two different tools are two different calls.
			digest: digestText(JSON.stringify([entryId, callId, name, b.arguments])),
			sessionId,
			entryId,
			callId,
			timestamp,
			name,
			argsDigest: digestText(JSON.stringify([name, b.arguments ?? null])),
			path: typeof declared === "string" ? declared : null,
			resultChars: null,
			resultDigest: null,
			isError: null,
			verifierKind: classifyVerifier(name, command),
		});
	}
}

/** Attach a result to the call it answers. */
function absorbResult(
	into: Map<string, MutableCall>,
	message: Record<string, unknown>,
): void {
	const callId =
		typeof message.toolCallId === "string" ? message.toolCallId : "";
	const call = into.get(callId);
	if (!call) return;
	const text = textOf(message.content);
	call.resultChars = text.length;
	call.resultDigest = digestText(text);
	call.isError = message.isError === true;
}

/** The text blocks of a result, joined. Images are sized, not digested. */
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

function digestText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, DIGEST_CHARS);
}
