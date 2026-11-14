import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
	DeclarationRecord,
	InnerCallRecord,
	RunCost,
	RunTokens,
	SessionRecord,
	TurnKind,
	TurnRecord,
} from "../core/observability/index.ts";
import { BranchWalk } from "./branch.ts";
import { declarationsOf } from "./declarations.ts";
import { GATEWAY_TOOL, gatewayTarget, innerCallsOf } from "./inner.ts";
import { SessionCollector } from "./session.ts";
import type { DroppedCallRecord, LedgerScan, ToolCallRecord } from "./types.ts";

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
 * 2: the thinking level each turn ran at.
 * 3: what preceded each turn, its gap, estimated new tokens, stop
 * reason, output sizes and run, and how each compaction was written and
 * what surrounded it.
 * 4: the quest and document in force at each turn, so spend is booked
 * to the work it was spent on rather than to the session's last quest.
 * 5: whether the harness reloaded before each turn, so a miss a reload's
 * new tool declarations caused is told from one a tool loaded mid-run
 * caused.
 *
 * The calls a script or a gateway call made to other tools, and what
 * each system message declared, are read without a bump: a log that grows is read again in full anyway, so
 * every session working when they landed has them from then on. A bump
 * would read all of a machine's finished logs again (16 GB on 12
 * November 2026) to fill in days nothing measures any more.
 */
export const SCAN_VERSION = 5;

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
 * Every place a turn can carry usage is read: assistant turns hold it
 * under `message`, compactions hold it at the top level beside `type`,
 * and a side call an extension made records it under its custom
 * entry's `data`.
 */
export function readTurns(
	sessionId: string,
	lines: Iterable<string>,
): LedgerScan {
	const scan = startScan(sessionId);
	for (const line of lines) scan.feed(line);
	return scan.take();
}

/**
 * A scan of one log, fed a line at a time, that can stop and carry what
 * it knows to a later pass over the same log once it has grown.
 */
export interface Scan {
	/** Read the log's next line. */
	feed(line: string): void;
	/**
	 * What the lines fed since the last take gave: their turns, calls,
	 * inner calls and declarations, every call a compaction has dropped,
	 * and any compaction turn read earlier whose run has since said
	 * whether it resumed, so the store can fill that in.
	 */
	take(): LedgerScan;
	/** What a later pass needs to carry on from here, after a take. */
	carry(): ScanState;
}

/**
 * What a scan knows of a log so far, from which a later pass carries on
 * as if it had read the lines before. Every entry's inherited level,
 * booking and branch is kept, since any of them can be a later entry's
 * parent, and every call that may still be answered or dropped.
 */
export interface ScanState {
	readonly calls: ReadonlyMap<string, ToolCallRecord>;
	readonly targets: ReadonlyMap<string, string>;
	readonly entryOrder: ReadonlyMap<string, number>;
	readonly boundaries: readonly Boundary[];
	readonly session: SessionRecord;
	readonly lastModel: string;
	readonly levels: ReadonlyMap<string, string | null>;
	readonly bookings: ReadonlyMap<string, Booking>;
	readonly branches: BranchWalk;
	/** Compaction turns whose run has not yet said whether it resumed. */
	readonly unsettled: readonly TurnRecord[];
}

/** A compaction's place on the log's timeline. */
export interface Boundary {
	readonly order: number;
	readonly entryId: string;
	readonly timestamp: string;
}

/**
 * Start a scan of a log, from its first line or, given what an earlier
 * pass carried, from where that pass stopped.
 */
export function startScan(sessionId: string, from?: ScanState): Scan {
	let turns: TurnRecord[] = [];
	// Keyed by call id so a result can find the call it answers. A call
	// whose result never arrives stays in the list with an unknown
	// result rather than being dropped: the call still happened.
	const calls = new Map<string, MutableCall>(
		[...(from?.calls ?? [])].map(([id, call]) => [id, { ...call }]),
	);
	// The calls made since the last take, which are the ones it gives.
	let made = new Set<string>();
	// The tool each gateway call named, by call id, read when the call
	// is made since its arguments are digested away then.
	const targets = new Map(from?.targets);
	let inner: InnerCallRecord[] = [];
	let declarations: DeclarationRecord[] = [];
	// The order every entry with an id was seen in, which is what makes a
	// compaction's firstKeptEntryId comparable to a call's own entry:
	// entry ids are not sortable strings, but the log's own line order is
	// the session's real timeline.
	const entryOrder = new Map(from?.entryOrder);
	// Compaction boundaries in the order they happened. A boundary only
	// ever moves forward, so the first one after a call's order is the
	// one compaction that actually dropped it.
	const boundaries: Boundary[] = [...(from?.boundaries ?? [])];
	const session = new SessionCollector(sessionId, from?.session);
	let count = 0;
	let parsed = 0;
	let unparseable = 0;
	let billable = 0;
	let unmetered = 0;
	// A CompactionEntry carries no model field of its own, so without
	// this every compaction turn's model would be empty, with nothing
	// for a later join to a model's billed rate to join on.
	let lastModel = from?.lastModel ?? "";
	// The thinking level in force at each entry, inherited through its
	// parent. A log is a tree, so reading the last level set in line
	// order would carry a level from an abandoned branch into its
	// sibling; following parentId gives each turn its own branch's.
	const levels = new Map(from?.levels);
	// The quest and document in force at each entry, inherited the same
	// way, so a turn is booked to the work it was done for rather than to
	// whichever quest its session named last.
	const bookings = new Map(from?.bookings);
	// What came before each turn on its own branch, for the same reason.
	const branches = from?.branches ?? new BranchWalk();
	// Read before the last take, and told again once settled.
	let unsettled = [...(from?.unsettled ?? [])];

	function feed(line: string): void {
		count += 1;
		if (!line.trim()) return;
		let entry: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value !== "object" || value === null) {
				unparseable += 1;
				return;
			}
			entry = value as Record<string, unknown>;
		} catch {
			// A truncated or interleaved write. Counted, never fatal: one
			// unreadable line once reduced a corpus-wide total to a tenth
			// of the truth by aborting the pipeline that met it.
			unparseable += 1;
			return;
		}
		parsed += 1;
		if (typeof entry.id === "string" && !entryOrder.has(entry.id)) {
			entryOrder.set(entry.id, entryOrder.size);
		}
		const level = levelAt(levels, entry);
		const booking = bookingAt(bookings, entry);
		const step = branches.step(entry);

		if (entry.type === "session") {
			session.observeHeader(entry);
			return;
		}

		if (entry.customType === "quest-workflow") {
			const data = asRecord(entry.data);
			if (data) session.observeWorkflow(data);
			return;
		}

		const message = asRecord(entry.message);
		if (message?.role === "toolResult") {
			absorbResult(calls, message);
			inner.push(...innerOf(calls, targets, message));
			return;
		}
		if (message?.role === "system") {
			const seq =
				typeof entry.id === "string"
					? (entryOrder.get(entry.id) ?? entryOrder.size)
					: entryOrder.size;
			declarations.push(...declarationsOf(sessionId, seq, entry, message));
			return;
		}

		const read = turnFrom(sessionId, entry, lastModel, level);
		if (!read) return;
		const turn: TurnRecord = { ...read, ...step, ...booking };
		if (turn.kind === "assistant" && turn.model) lastModel = turn.model;
		session.observeTurn(turn.timestamp);
		turns.push(turn);
		if (turn.cost) billable += 1;
		else unmetered += 1;
		collectCalls(
			{ calls, targets, made },
			sessionId,
			turn.entryId,
			turn.timestamp,
			message,
		);
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

	function take(): LedgerScan {
		// A compaction read before is told again once its run says whether
		// it resumed, since the store fills in a fact a held turn lacks.
		const settled = unsettled.filter(
			({ compaction }) => compaction?.resumed !== null,
		);
		unsettled = unsettled.filter(
			({ compaction }) => compaction?.resumed === null,
		);
		const scan: LedgerScan = {
			turns: [...settled, ...turns],
			calls: [...calls.values()].filter(({ callId }) => made.has(callId)),
			inner,
			declarations,
			dropped: droppedCallsOf(sessionId, calls, entryOrder, boundaries),
			coverage: { lines: count, parsed, unparseable, billable, unmetered },
			session: session.record(),
		};
		unsettled.push(
			...turns.filter(({ compaction }) => compaction?.resumed === null),
		);
		turns = [];
		made = new Set();
		inner = [];
		declarations = [];
		count = 0;
		parsed = 0;
		unparseable = 0;
		billable = 0;
		unmetered = 0;
		return scan;
	}

	function carry(): ScanState {
		return {
			calls: stillOpen(calls, entryOrder, boundaries),
			targets,
			entryOrder,
			boundaries,
			session: session.record(),
			lastModel,
			levels,
			bookings,
			branches,
			unsettled,
		};
	}

	return { feed, take, carry };
}

/**
 * The calls a later line can still change: one still awaiting its
 * result, or not yet dropped by a compaction. One answered and dropped
 * has given every row it will, so a scan that carries on needs it no
 * more.
 */
function stillOpen(
	calls: ReadonlyMap<string, MutableCall>,
	entryOrder: ReadonlyMap<string, number>,
	boundaries: readonly Boundary[],
): Map<string, ToolCallRecord> {
	const open = new Map<string, ToolCallRecord>();
	for (const [id, call] of calls) {
		const order = entryOrder.get(call.entryId);
		const dropped =
			order !== undefined && boundaries.some((b) => b.order > order);
		if (call.resultChars === null || !dropped) open.set(id, call);
	}
	return open;
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
	boundaries: readonly Boundary[],
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
	/**
	 * The level the turn's branch last set. A compaction takes it too:
	 * pi runs the summary at the session's thinking level.
	 */
	thinkingLevel: string | null,
): TurnRecord | null {
	const kind = kindOf(entry);
	if (!kind) return null;
	const message = asRecord(entry.message);
	const data = asRecord(entry.data);
	const usage = asRecord(
		kind === "compaction"
			? entry.usage
			: kind === "side"
				? data?.usage
				: message?.usage,
	) as RawUsage | null;

	const entryId = typeof entry.id === "string" ? entry.id : "";
	const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
	const model = modelOf(kind, message, data, fallbackModel);

	return {
		entryId,
		sessionId,
		timestamp,
		kind,
		model,
		thinkingLevel,
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
 * Record and return the thinking level in force at an entry: its own
 * when it sets one, otherwise its parent's, and null when nothing on its
 * branch has said. An entry whose parent this scan never saw starts from
 * null rather than a guess.
 */
function levelAt(
	levels: Map<string, string | null>,
	entry: Record<string, unknown>,
): string | null {
	const inherited =
		typeof entry.parentId === "string"
			? (levels.get(entry.parentId) ?? null)
			: null;
	const level =
		entry.type === "thinking_level_change" &&
		typeof entry.thinkingLevel === "string"
			? entry.thinkingLevel
			: inherited;
	if (typeof entry.id === "string") levels.set(entry.id, level);
	return level;
}

/** The quest and document a turn is booked to; null is none loaded. */
export interface Booking {
	readonly quest: string | null;
	readonly document: string | null;
}

/**
 * Before its branch says otherwise, a turn had nothing loaded. That is
 * also what the session-wide answer gives a log with no quest entry,
 * since quest-workflow is the only thing that names one.
 */
const NOTHING_LOADED: Booking = { quest: null, document: null };

/**
 * The booking in force at an entry: the one a quest-workflow entry
 * states, or its parent's. An unload is stated as a null quest, and it
 * ends the booking there rather than being skipped.
 */
function bookingAt(
	bookings: Map<string, Booking>,
	entry: Record<string, unknown>,
): Booking {
	const inherited =
		typeof entry.parentId === "string"
			? (bookings.get(entry.parentId) ?? NOTHING_LOADED)
			: NOTHING_LOADED;
	const stated =
		entry.customType === "quest-workflow"
			? statedBooking(asRecord(entry.data))
			: undefined;
	const booking = stated ?? inherited;
	if (typeof entry.id === "string") bookings.set(entry.id, booking);
	return booking;
}

/** What a quest-workflow entry says is loaded, or nothing if it says not. */
function statedBooking(
	data: Record<string, unknown> | null,
): Booking | undefined {
	if (!data || !("questId" in data)) return undefined;
	const quest = typeof data.questId === "string" ? data.questId : null;
	const path =
		quest && typeof data.documentPath === "string" ? data.documentPath : null;
	return { quest, document: path ? basename(path, ".md") : null };
}

/**
 * Which turns are billable at all. An assistant turn and a compaction
 * both cost money, and so does a side call: a custom entry an extension
 * recorded a model call's usage on, cost included. A user message, a
 * tool result and a state change do not. Enumerated rather than
 * filtered, so a new entry type is ignored by omission instead of
 * silently swept into a total.
 */
function kindOf(entry: Record<string, unknown>): TurnKind | null {
	if (entry.type === "compaction") return "compaction";
	if (entry.type === "custom") {
		const usage = asRecord(asRecord(entry.data)?.usage);
		return asRecord(usage?.cost) ? "side" : null;
	}
	const message = asRecord(entry.message);
	if (message?.role === "assistant") return "assistant";
	return null;
}

/**
 * The model a turn was billed on. A side call names its own, and never
 * takes the session's, since it is usually a different and much
 * cheaper model; a compaction names none and takes the last one seen.
 */
function modelOf(
	kind: TurnKind,
	message: Record<string, unknown> | null,
	data: Record<string, unknown> | null,
	fallbackModel: string,
): string {
	if (kind === "side") return typeof data?.model === "string" ? data.model : "";
	return typeof message?.model === "string" ? message.model : fallbackModel;
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
	into: {
		readonly calls: Map<string, MutableCall>;
		readonly targets: Map<string, string>;
		readonly made: Set<string>;
	},
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
		const target = name === GATEWAY_TOOL ? gatewayTarget(args) : undefined;
		if (target) into.targets.set(callId, target);
		into.made.add(callId);
		into.calls.set(callId, {
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

/** The calls a result says its call made to other tools. */
function innerOf(
	calls: ReadonlyMap<string, MutableCall>,
	targets: ReadonlyMap<string, string>,
	message: Record<string, unknown>,
): InnerCallRecord[] {
	const callId =
		typeof message.toolCallId === "string" ? message.toolCallId : "";
	const outer = calls.get(callId);
	return outer ? innerCallsOf(outer, message, targets.get(callId)) : [];
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
