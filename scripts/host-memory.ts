/**
 * What memory each host and each of its conversations' children take, as
 * the host's memory answer says it: the host's own Pss and heap, then a
 * line each conversation, with the median and total Pss of the children
 * read. It is the live measure of each conversation's own process,
 * changing nothing; what a child starts, as a tool's shell, is its own
 * process and not counted.
 * Node runs it as it stands, stripping the types:
 *
 *   node scripts/host-memory.ts [attended|background|KIND:SESSION]...
 *
 * Without a kind it reads both hosts. KIND:SESSION reads that
 * conversation's child on its own socket instead, for its own heap, Pss
 * and each of V8's spaces, a reading as cheap as the host's own and with
 * none of a heap snapshot's pause. A child listens in its slot, which an
 * open names afresh, so the child is found by asking: the slot named by
 * the id first, then those whose file says they hold it, then the rest,
 * until one says it runs that conversation. One that doesn't answer is
 * said and the next is read; exits 1 when any wasn't read, 0 otherwise.
 *
 *   node scripts/host-memory.ts --snapshot [--keep-raw] KIND:SESSION
 *
 * writes a heap snapshot of the process that conversation runs in, asked
 * of its host, which passes it to the child, and says where it went. The
 * write stops that process's thread for seconds, so a busy conversation
 * refuses it. The raw file holds what the process holds, secrets among
 * them, so it is written for its owner alone, in a hidden folder, and the
 * host's journal names this script as who asked for it. The host sums it
 * by type, figures only, into a summary beside that folder; this waits for
 * the summary, prints its figures as a short table, then removes the raw
 * file, since this has summed it. With --keep-raw the raw file is kept,
 * for a retainers read; remove it once read. Either way it says which.
 * The host removes any raw file or summary left more than 2 hours before
 * its next snapshot. A large heap takes a while to write and sum, so this
 * waits up to SNAPSHOT_WAIT_MS for both; one that gives up says the file
 * may still be coming, and keeps a raw file whose summary never came. A
 * host from before summaries says none is coming, and its raw file is
 * kept for its asker to remove.
 */

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
	childFolder,
	type HostKind,
	hostKey,
	hostRealm,
	hostSocketPath,
} from "../host/service/address.ts";
import { slotHolds, slotOf, slotsIn } from "../host/service/child-units.ts";
import { controlRequest } from "../host/service/client.ts";
import { SNAPSHOT_KEPT_MS } from "../host/service/heap-snapshot.ts";
import {
	type HeapRow,
	type HeapSummary,
	parseHeapSummary,
} from "../host/service/heap-summary.ts";
import {
	type MemoryAnswer,
	parseHeapSnapshotResult,
	parseMemoryResult,
} from "../host/service/protocol.ts";
import { isSessionId } from "../lib/core/session/roster.ts";
import { runtimeDir as loginRuntimeDir } from "../lib/internal/paths.ts";
import { printable } from "./where-sessions-run.ts";

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = 1024 * BYTES_PER_KIB;
const MS_PER_HOUR = 60 * 60 * 1000;
/**
 * How long a snapshot is waited for. The write's length grows with the
 * heap, and the 30 s every other request waits could give up on a large
 * one still being written.
 */
export const SNAPSHOT_WAIT_MS = 10 * 60 * 1000;
/** How often a summary not yet written is looked for again. */
const SUMMARY_POLL_MS = 250;
/** How many of a summary's rows by type and name are printed. */
const SUMMARY_ROWS_SHOWN = 15;
const SIZE_WIDTH = "  99999.9 MiB".length;
const COUNT_WIDTH = "  999999999".length;

/** `bytes` in whole MiB, or "unread" where nothing was read. */
function mib(bytes: number | undefined): string {
	return bytes === undefined
		? "unread"
		: `${Math.round(bytes / BYTES_PER_MIB)} MiB`;
}

/** A heap as used of its limit, in MiB, or "unread". */
function heapOf(heap: MemoryAnswer["own"]["heap"]): string {
	return heap === undefined
		? "unread"
		: `${Math.round(heap.used / BYTES_PER_MIB)} of ${mib(heap.limit)}`;
}

/** The middle of `values`, the mean of the middle two where they're even. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const half = Math.floor(sorted.length / 2);
	const upper = sorted[half] ?? 0;
	return sorted.length % 2 === 1
		? upper
		: ((sorted[half - 1] ?? 0) + upper) / 2;
}

/**
 * Each of V8's spaces a process said, largest first, as used of held in
 * MiB, then what it holds outside the heap; why none, where its heap was
 * read without them; and nothing where no heap was read.
 */
function spacesOf(heap: MemoryAnswer["own"]["heap"]): string[] {
	if (heap === undefined) return [];
	if (heap.spaces === undefined)
		return ["  spaces: not said, by an install older than this script"];
	const spaces = [...heap.spaces]
		.sort((a, b) => b.used - a.used)
		.map(
			({ name, used, size }) =>
				`${printable(name)} ${Math.round(used / BYTES_PER_MIB)} of ${mib(size)}`,
		);
	return [
		`  spaces: ${spaces.join(", ")}; external ${mib(heap.external)}, array buffers ${mib(heap.arrayBuffers)}`,
	];
}

const STATE_WIDTH = "parked  ".length;
const READING_WIDTH = "unread    ".length;
const HEAP_WIDTH = "9999 of 9999 MiB  ".length;
const HEARD_WIDTH = "2026-11-24T08:00:00.000Z  ".length;

/**
 * A host's own memory and its children's Pss, then a line each
 * conversation: its Pss, its heap and when the host heard it, its state
 * and its id. A reading the host couldn't take reads "unread", never 0.
 */
export function describeMemory(kind: string, answer: MemoryAnswer): string[] {
	const read = answer.sessions.flatMap(({ pss }) =>
		pss === undefined ? [] : [pss],
	);
	const children =
		read.length === 0
			? "no child's Pss read"
			: `a child's Pss read for ${read.length} of ${answer.sessions.length} conversations, median ${mib(median(read))}, total ${mib(read.reduce((sum, each) => sum + each, 0))}`;
	return [
		`${kind}: host Pss ${mib(answer.own.pss)}, heap ${heapOf(answer.own.heap)}; ${children}`,
		...spacesOf(answer.own.heap),
		...answer.sessions.map(
			({ sessionId, state, pss, heap }) =>
				`  Pss ${mib(pss).padEnd(READING_WIDTH)}heap ${heapOf(heap).padEnd(HEAP_WIDTH)}${(heap?.at ?? "").padEnd(HEARD_WIDTH)}${state.padEnd(STATE_WIDTH)}${sessionId}`,
		),
	];
}

/**
 * One conversation's child's own memory, as it answered for itself: its
 * Pss and heap, then each of its heap's spaces.
 */
export function describeChild(label: string, answer: MemoryAnswer): string[] {
	return [
		`${label}: Pss ${mib(answer.own.pss)}, heap ${heapOf(answer.own.heap)}`,
		...spacesOf(answer.own.heap),
	];
}

/** Why `error` happened, printable. */
function why(error: unknown): string {
	return printable(error instanceof Error ? error.message : String(error));
}

/** What a host, or one conversation's child, was asked to read. */
interface Asked {
	readonly kind: HostKind;
	readonly session?: string;
}

/** `word` as a host's kind, or a kind and a session's id, or none. */
export function askedOf(word: string): Asked | undefined {
	const [kind, session, ...rest] = word.split(":");
	if (kind !== "attended" && kind !== "background") return undefined;
	if (session === undefined) return { kind };
	if (rest.length > 0 || !isSessionId(session)) return undefined;
	return { kind, session };
}

/** What a socket's process answered for its memory, or undefined where none did. */
export type AskMemory = (socket: string) => Promise<MemoryAnswer | undefined>;

/**
 * The memory answer of the child in `folder` that runs `session`, asked
 * of the slot named by its id first, then of those whose file says they
 * hold it, then of the rest; undefined when none says it runs it.
 */
export async function childRunning(
	folder: string,
	key: string,
	session: string,
	ask: AskMemory,
): Promise<MemoryAnswer | undefined> {
	const wanted = session.toLowerCase();
	const named = slotOf(folder, key, session);
	const holding: string[] = [];
	const rest: string[] = [];
	for (const slot of await slotsIn(folder, key)) {
		if (slot.name.toLowerCase() === named.name.toLowerCase()) continue;
		const holds = (await slotHolds(slot))?.toLowerCase();
		(holds === wanted ? holding : rest).push(slot.socket);
	}
	for (const socket of [named.socket, ...holding, ...rest]) {
		const answer = await ask(socket);
		const runs = answer?.sessions.some(
			({ sessionId }) => sessionId.toLowerCase() === wanted,
		);
		if (runs) return answer;
	}
	return undefined;
}

/** A heap snapshot's answer as a line: where it went, its size and its pause. */
export function describeSnapshot(
	answer: ReturnType<typeof parseHeapSnapshotResult>,
): string {
	return `${answer.sessionId}: a heap snapshot of ${mib(answer.bytes)}, written in ${answer.tookMs} ms, to ${printable(answer.file)}`;
}

/**
 * Why `label` got no snapshot. A request that gave up waiting can't know
 * whether the write still runs, so it says where the file would come and
 * when the host removes it.
 */
export function describeSnapshotFailure(label: string, error: unknown): string {
	const said = why(error);
	const late = said.includes("timed out")
		? `; the host may still be writing it into its heap-snapshots folder, where the next snapshot removes it once ${SNAPSHOT_KEPT_MS / MS_PER_HOUR} hours old`
		: "";
	return `${label}: no snapshot: ${said}${late}`;
}

/** `bytes` in MiB to a tenth, so a summary's small rows read as more than 0. */
function tenthsOfMib(bytes: number): string {
	return `${(bytes / BYTES_PER_MIB).toFixed(1)} MiB`;
}

/** A summary's row as a line of its table: its self size, its count, its kind and name. */
function rowOf({ type, name, count, selfSize }: HeapRow): string {
	const named = name === undefined ? type : `${type}: ${printable(name)}`;
	return `  ${tenthsOfMib(selfSize).padStart(SIZE_WIDTH)}${String(count).padStart(COUNT_WIDTH)}  ${named}`;
}

/**
 * A summary's figures as a short table: its nodes, their self size and
 * its large strings, then each kind, then the largest rows by kind and
 * name; the summary file holds the rest.
 */
export function describeSummary(summary: HeapSummary): string[] {
	const header = `  ${"self size".padStart(SIZE_WIDTH)}${"count".padStart(COUNT_WIDTH)}  `;
	const shown = summary.byTypeAndName.slice(0, SUMMARY_ROWS_SHOWN);
	return [
		`  ${summary.nodes} nodes, ${tenthsOfMib(summary.selfSize)} in all; strings of ${summary.largeStrings.atLeast / BYTES_PER_KIB} KiB or more: ${summary.largeStrings.count}, ${tenthsOfMib(summary.largeStrings.selfSize)}`,
		`${header}kind`,
		...summary.byType.map(rowOf),
		`${header}kind and name, the largest ${shown.length} of ${summary.byTypeAndName.length}`,
		...shown.map(rowOf),
	];
}

/**
 * The summary at `file` once it is written whole, looked for again every
 * `pollMs` until `deadline`; undefined when none came by then.
 */
async function summaryBy(
	file: string,
	deadline: number,
	pollMs: number,
): Promise<HeapSummary | undefined> {
	for (;;) {
		const summary = await readFile(file, "utf8")
			.then((text) => parseHeapSummary(JSON.parse(text)))
			// Not there yet, or not yet written whole: looked for again.
			.catch(() => undefined);
		if (summary !== undefined) return summary;
		const left = deadline - Date.now();
		if (left <= 0) return undefined;
		await delay(Math.min(pollMs, left));
	}
}

/** What asking for a snapshot said, and whether it did all it set out to. */
export interface SnapshotTold {
	readonly lines: readonly string[];
	/** False when no summary came, or the raw file couldn't be removed. */
	readonly done: boolean;
}

/** How a snapshot is asked for, beyond where. */
export interface SnapshotAsk {
	/** Keep the raw file once summed, for a retainers read; it is removed otherwise. */
	readonly keepRaw?: boolean;
	/** How long the request and the summary may take together. */
	readonly waitMs?: number;
	/** How often a summary not yet written is looked for again. */
	readonly pollMs?: number;
}

/**
 * The summary of the snapshot `answer` names, as lines, then the raw file
 * removed, or kept where `keepRaw` asks or no summary came by `deadline`.
 */
async function summed(
	answer: ReturnType<typeof parseHeapSnapshotResult>,
	deadline: number,
	{ keepRaw = false, pollMs = SUMMARY_POLL_MS }: SnapshotAsk,
): Promise<SnapshotTold> {
	const raw = printable(answer.file);
	const said = [describeSnapshot(answer)];
	if (answer.summary === undefined)
		return {
			lines: [
				...said,
				"  no summary: the host runs code from before summaries, so the raw file is kept; remove it once read",
			],
			done: true,
		};
	const summary = await summaryBy(answer.summary, deadline, pollMs);
	if (summary === undefined)
		return {
			lines: [
				...said,
				`  no summary came to ${printable(answer.summary)} in time, so the raw file is kept; the host's journal says whether its sum failed`,
			],
			done: false,
		};
	said.push(...describeSummary(summary));
	if (keepRaw)
		return {
			lines: [
				...said,
				`  kept the raw snapshot at ${raw}, as --keep-raw asked; remove it once read, or the host does once ${SNAPSHOT_KEPT_MS / MS_PER_HOUR} hours old`,
			],
			done: true,
		};
	try {
		await rm(answer.file, { force: true });
	} catch (error) {
		return {
			lines: [
				...said,
				`  could not remove the raw snapshot at ${raw}: ${why(error)}`,
			],
			done: false,
		};
	}
	return {
		lines: [
			...said,
			`  removed the raw snapshot at ${raw}, since this summed it; --keep-raw keeps one for a retainers read`,
		],
		done: true,
	};
}

/** The flag that keeps a snapshot's raw file once summed. */
const KEEP_RAW = "--keep-raw";

/** Who this script tells a host asks for a snapshot, for its journal. */
export const SNAPSHOT_ASKER = "scripts/host-memory.ts";

/**
 * The heap snapshot the host on `socket` has written of `sessionId`'s
 * process and its summary, then what became of its raw file, or why not,
 * waiting up to `waitMs` for all of it. A host not yet restarted onto
 * code that takes who asks refuses the request unread, having done
 * nothing, so it is asked once more without.
 */
export async function snapshotAt(
	socket: string,
	sessionId: string,
	asked: SnapshotAsk = {},
): Promise<SnapshotTold> {
	const waitMs = asked.waitMs ?? SNAPSHOT_WAIT_MS;
	const deadline = Date.now() + waitMs;
	const ask = (by?: string) =>
		controlRequest(
			socket,
			{
				v: 1,
				id: randomUUID(),
				op: "heap-snapshot",
				sessionId,
				...(by === undefined ? {} : { by }),
			},
			waitMs,
		);
	let reply = await ask(SNAPSHOT_ASKER);
	if (!reply.ok && reply.error.code === "invalid_request") reply = await ask();
	if (!reply.ok) throw new Error(`it refused: ${reply.error.message}`);
	return summed(parseHeapSnapshotResult(reply.result), deadline, asked);
}

/** What the process on `socket` answers for its memory, or why not. */
async function memoryAt(socket: string): Promise<MemoryAnswer> {
	const reply = await controlRequest(socket, {
		v: 1,
		id: randomUUID(),
		op: "memory",
	});
	if (!reply.ok) throw new Error(`it refused: ${reply.error.message}`);
	return parseMemoryResult(reply.result);
}

/** The lines for one host or child, or why it couldn't be read. */
async function readOne(
	realm: string,
	{ kind, session }: Asked,
	runtimeDir: string,
): Promise<string[]> {
	if (session === undefined)
		return describeMemory(
			kind,
			await memoryAt(hostSocketPath(realm, kind, runtimeDir)),
		);
	const key = hostKey(realm, kind);
	const answer = await childRunning(
		childFolder(key, runtimeDir),
		key,
		session,
		(socket) =>
			memoryAt(socket).catch(
				// A slot with no child listening, or one that refuses, runs
				// nothing this can read: the next slot is asked.
				() => undefined,
			),
	);
	if (answer === undefined)
		throw new Error("no child listening says it runs that conversation");
	return describeChild(`${kind} child ${session}`, answer);
}

/**
 * Write a snapshot for the conversation the words name, printing its
 * summary and what became of its raw file; exits 1 where it wasn't
 * written, summed or removed as asked.
 */
async function snapshotOne(words: readonly string[]): Promise<void> {
	const keepRaw = words.includes(KEEP_RAW);
	const [word, ...rest] = words.filter((each) => each !== KEEP_RAW);
	const one = word === undefined || rest.length > 0 ? undefined : askedOf(word);
	if (one?.session === undefined)
		throw new Error(
			`Usage: node scripts/host-memory.ts --snapshot [${KEEP_RAW}] KIND:SESSION`,
		);
	const runtimeDir = loginRuntimeDir();
	if (!runtimeDir)
		throw new Error(
			"No runtime folder: neither AGENTS_RUNTIME_DIR nor XDG_RUNTIME_DIR is set, and on a Mac getconf named no cache folder",
		);
	const socket = hostSocketPath(hostRealm(process.env), one.kind, runtimeDir);
	try {
		const told = await snapshotAt(socket, one.session, { keepRaw });
		console.log(told.lines.join("\n"));
		if (!told.done) process.exitCode = 1;
	} catch (error) {
		console.log(describeSnapshotFailure(`${one.kind}:${one.session}`, error));
		process.exitCode = 1;
	}
}

if (import.meta.main && process.argv[2] === "--snapshot") {
	await snapshotOne(process.argv.slice(3));
} else if (import.meta.main) {
	const asked = process.argv.slice(2);
	const reads: Asked[] =
		asked.length > 0 ? [] : [{ kind: "attended" }, { kind: "background" }];
	for (const word of asked) {
		const one = askedOf(word);
		if (one === undefined)
			throw new Error(
				"Usage: node scripts/host-memory.ts [attended|background|KIND:SESSION]...",
			);
		reads.push(one);
	}
	const realm = hostRealm(process.env);
	const runtimeDir = loginRuntimeDir();
	if (!runtimeDir)
		throw new Error(
			"No runtime folder: neither AGENTS_RUNTIME_DIR nor XDG_RUNTIME_DIR is set, and on a Mac getconf named no cache folder",
		);
	let unread = false;
	for (const one of reads) {
		const label =
			one.session === undefined ? one.kind : `${one.kind}:${one.session}`;
		try {
			console.log((await readOne(realm, one, runtimeDir)).join("\n"));
		} catch (error) {
			unread = true;
			console.log(`${label}: not read: ${why(error)}`);
		}
	}
	process.exitCode = unread ? 1 : 0;
}
