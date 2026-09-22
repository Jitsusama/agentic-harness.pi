import { createHash } from "node:crypto";
import type {
	RunCost,
	RunTokens,
	TurnKind,
	TurnRecord,
} from "@jitsusama/agentic-harness.core/observability";
import { SessionCollector } from "./session.js";
import type { LedgerScan } from "./types.js";

/** Width of a stored content address. 96 bits is ample for a corpus of
 * a few million turns and keeps the index small. */
const DIGEST_CHARS = 24;

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
	const session = new SessionCollector(sessionId);
	let count = 0;
	let parsed = 0;
	let unparseable = 0;
	let billable = 0;
	let unmetered = 0;

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

		if (entry.type === "session") {
			session.observeHeader(entry);
			continue;
		}

		if (entry.customType === "quest-workflow") {
			const data = asRecord(entry.data);
			if (data) session.observeWorkflow(data);
			continue;
		}

		const turn = turnFrom(sessionId, entry);
		if (!turn) continue;
		session.observeTurn(turn.timestamp);
		turns.push(turn);
		if (turn.cost) billable += 1;
		else unmetered += 1;
	}

	return {
		turns,
		coverage: { lines: count, parsed, unparseable, billable, unmetered },
		session: session.record(),
	};
}

function turnFrom(
	sessionId: string,
	entry: Record<string, unknown>,
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
		typeof message?.model === "string" ? (message.model as string) : "";

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
