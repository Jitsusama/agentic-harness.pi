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
 */

import { randomUUID } from "node:crypto";
import {
	childFolder,
	type HostKind,
	hostKey,
	hostRealm,
	hostSocketPath,
} from "../host/service/address.ts";
import { slotHolds, slotOf, slotsIn } from "../host/service/child-units.ts";
import { controlRequest } from "../host/service/client.ts";
import {
	type MemoryAnswer,
	parseMemoryResult,
} from "../host/service/protocol.ts";
import { isSessionId } from "../lib/core/session/roster.ts";
import { runtimeDir as loginRuntimeDir } from "../lib/internal/paths.ts";
import { printable } from "./where-sessions-run.ts";

const BYTES_PER_MIB = 1024 * 1024;

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

if (import.meta.main) {
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
