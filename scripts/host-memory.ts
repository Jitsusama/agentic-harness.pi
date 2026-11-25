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
 * none of a heap snapshot's pause. One that doesn't answer is said and
 * the next is read; exits 1 when any wasn't read, 0 otherwise.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	childFolder,
	type HostKind,
	hostKey,
	hostRealm,
	hostSocketPath,
} from "../host/service/address.ts";
import { controlRequest } from "../host/service/client.ts";
import {
	type MemoryAnswer,
	parseMemoryResult,
} from "../host/service/protocol.ts";
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
 * MiB, then what it holds outside the heap; none where it said none.
 */
function spacesOf(heap: MemoryAnswer["own"]["heap"]): string[] {
	if (heap?.spaces === undefined) return [];
	const spaces = [...heap.spaces]
		.sort((a, b) => b.used - a.used)
		.map(
			({ name, used, size }) =>
				`${name} ${Math.round(used / BYTES_PER_MIB)} of ${mib(size)}`,
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

/** Why `error` happened, printable. */
function why(error: unknown): string {
	return printable(error instanceof Error ? error.message : String(error));
}

/** What a host, or one conversation's child, was asked to read. */
interface Asked {
	readonly kind: HostKind;
	readonly session?: string;
}

const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** `word` as a host's kind, or a kind and a session's id, or none. */
export function askedOf(word: string): Asked | undefined {
	const [kind, session, ...rest] = word.split(":");
	if (kind !== "attended" && kind !== "background") return undefined;
	if (session === undefined) return { kind };
	if (rest.length > 0 || !SESSION_ID.test(session)) return undefined;
	return { kind, session };
}

/** The lines for one host or child, or why it couldn't be read. */
async function readOne(
	realm: string,
	{ kind, session }: Asked,
	runtimeDir: string,
): Promise<string[]> {
	const socket =
		session === undefined
			? hostSocketPath(realm, kind, runtimeDir)
			: join(childFolder(hostKey(realm, kind), runtimeDir), `${session}.sock`);
	const reply = await controlRequest(socket, {
		v: 1,
		id: randomUUID(),
		op: "memory",
	});
	if (!reply.ok) throw new Error(`it refused: ${reply.error.message}`);
	const label = session === undefined ? kind : `${kind} child ${session}`;
	return describeMemory(label, parseMemoryResult(reply.result));
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
