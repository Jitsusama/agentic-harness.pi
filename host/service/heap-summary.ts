/**
 * A heap snapshot summed by what its heap is made of, figures only, so
 * whoever asked for one can see where a process's memory goes without
 * opening the raw file, which holds every string the process held: its
 * conversation, and its environment's secrets among them.
 *
 * The summary says how many nodes the heap holds and their total self
 * size, then the largest rows by self size of each node type, and of
 * each type with its constructor or internal name. A kind that is data
 * rather than structure (a string of any kind, a regexp, a number, a
 * bigint or a symbol) is named only by its kind, never by what it holds;
 * so is any kind this doesn't know, since a later V8 may add one whose
 * name is a value. It also counts the strings of LARGE_STRING_BYTES or
 * more and their total size, never their text.
 *
 * A snapshot can be larger than V8's longest string, so the file is read
 * as bytes, a chunk at a time, and never parsed whole: its header is
 * parsed alone, its numeric "nodes" array is scanned number by number,
 * the arrays after it are skipped, and of its "strings" only the names
 * the top rows need are decoded, each cut to NAME_CHARS.
 *
 * Run as a program,
 *
 *   node host/service/heap-summary.ts RAW SUMMARY
 *
 * it writes RAW's summary as JSON to SUMMARY, owner-only and never over a
 * file already there, and exits 1 saying why on stderr when it can't.
 * heap-snapshot.ts runs it so, through sumApart, in a process of its own
 * with a bounded heap, so summing never stops the conversation's thread
 * and none of its memory lands in that conversation's process.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { z } from "zod";

/** How many rows of each table a summary keeps, largest first. */
export const TOP_ROWS = 40;
/** The size from which a string is counted as large. */
export const LARGE_STRING_BYTES = 64 * 1024;
/** The longest name a row keeps, in characters. */
const NAME_CHARS = 100;
/** How much of a name's encoded bytes is read before the rest is skipped. */
const NAME_BYTES_READ = 4096;
/** How much a snapshot's header may take before it isn't one. */
const HEADER_BYTES_MOST = 1024 * 1024;
/** How much of a snapshot is read at a time. */
const CHUNK_BYTES = 1024 * 1024;
/** Only the owner may read a summary, as only the owner may read its snapshot. */
const OWNER_ONLY_FILE = 0o600;
/** The heap a summing process may take, in MiB, whatever the snapshot's size. */
const SUM_HEAP_MIB = 2048;
/** How long a summing process may run before it is ended. */
const SUM_LIMIT_MS = 10 * 60 * 1000;
/** How much of a failed summing process's stderr its failure keeps. */
const REASON_CHARS = 2000;

/**
 * The kinds named beside their constructor or internal name: those whose
 * name says what built them. Every other kind is named alone.
 */
const NAMED_KINDS = new Set([
	"hidden",
	"array",
	"object",
	"code",
	"closure",
	"native",
	"synthetic",
	"object shape",
]);
/** The kinds counted among large strings. */
const STRING_KINDS = new Set([
	"string",
	"concatenated string",
	"sliced string",
]);

const END = -1;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const ZERO = 0x30;
const NINE = 0x39;
const LETTER_U = 0x75;
const DECIMAL = 10;
/** The hex digits after a `\u` escape. */
const UNICODE_ESCAPE_DIGITS = 4;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

const count = z.int().nonnegative();
const row = z.strictObject({
	type: z.string(),
	name: z.string().optional(),
	count,
	selfSize: count,
});
const summary = z.strictObject({
	nodes: count,
	selfSize: count,
	byType: z.array(row),
	byTypeAndName: z.array(row),
	largeStrings: z.strictObject({
		atLeast: count,
		count,
		selfSize: count,
	}),
});
const header = z.object({
	snapshot: z.object({
		meta: z.object({
			node_fields: z.array(z.string()),
			node_types: z.tuple([z.array(z.string())], z.unknown()),
		}),
		node_count: count,
	}),
});

/** What a heap snapshot holds, summed by type, figures only. */
export type HeapSummary = z.infer<typeof summary>;

/** `value` as a summary, as a summing process wrote it; throws on anything else. */
export function parseHeapSummary(value: unknown): HeapSummary {
	return summary.parse(value);
}

/** A snapshot file, read a chunk at a time. */
interface Reader {
	readonly fd: number;
	readonly chunk: Buffer;
	at: number;
	end: number;
}

/** Read the next chunk into `reader`; false at the file's end. */
function refill(reader: Reader): boolean {
	reader.end = readSync(reader.fd, reader.chunk, 0, reader.chunk.length, null);
	reader.at = 0;
	return reader.end > 0;
}

/** The next byte, or END at the file's end. */
function next(reader: Reader): number {
	if (reader.at === reader.end && !refill(reader)) return END;
	return reader.chunk[reader.at++] ?? END;
}

/** The next byte that isn't whitespace, or END. */
function nextSolid(reader: Reader): number {
	for (;;) {
		const byte = next(reader);
		if (!WHITESPACE.has(byte)) return byte;
	}
}

/** Why a file can't be summed: it isn't a snapshot as V8 writes one. */
function malformed(what: string): Error {
	return new Error(`Not a heap snapshot as V8 writes one: ${what}`);
}

/** Read `expected` next, past whitespace, or throw. */
function expect(reader: Reader, expected: number, what: string): void {
	if (nextSolid(reader) !== expected) throw malformed(`expected ${what}`);
}

/**
 * The snapshot's header, its opening `{"snapshot":{...}`, parsed alone,
 * leaving the reader after it.
 */
function readHeader(reader: Reader): z.infer<typeof header> {
	const bytes: number[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (;;) {
		const byte = next(reader);
		if (byte === END) throw malformed("its header never ends");
		if (bytes.length >= HEADER_BYTES_MOST)
			throw malformed("its header is too long");
		bytes.push(byte);
		if (inString) {
			if (escaped) escaped = false;
			else if (byte === BACKSLASH) escaped = true;
			else if (byte === QUOTE) inString = false;
			continue;
		}
		if (byte === QUOTE) inString = true;
		else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++;
		else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
			depth--;
			// Back in the outer object: the snapshot's own object has closed.
			if (depth === 1) break;
			if (depth < 1) throw malformed("its header holds no snapshot");
		}
	}
	const text = `${Buffer.from(bytes).toString("utf8")}}`;
	const parsed = header.safeParse(JSON.parse(text));
	if (!parsed.success) throw malformed("its header says no node fields");
	return parsed.data;
}

/** The next top-level key, past the comma before it, or undefined at the snapshot's end. */
function readKey(reader: Reader): string | undefined {
	const first = nextSolid(reader);
	if (first === CLOSE_BRACE) return undefined;
	if (first !== COMMA) throw malformed("expected a comma between its parts");
	expect(reader, QUOTE, "a key");
	const bytes: number[] = [];
	for (let byte = next(reader); byte !== QUOTE; byte = next(reader)) {
		if (byte === END || bytes.length >= NAME_BYTES_READ)
			throw malformed("a key never ends");
		bytes.push(byte);
	}
	expect(reader, COLON, "a colon after a key");
	return Buffer.from(bytes).toString("utf8");
}

/**
 * Scan an array of whole numbers, its opening bracket already read, as
 * nodes of `width` fields each, handing each node's fields to `onNode`;
 * answers how many nodes there were.
 */
function scanNodes(
	reader: Reader,
	width: number,
	onNode: (fields: Float64Array) => void,
): number {
	const fields = new Float64Array(width);
	let field = 0;
	let value = 0;
	let digits = false;
	let nodes = 0;
	for (;;) {
		if (reader.at === reader.end && !refill(reader))
			throw malformed("its nodes never end");
		const { chunk, end } = reader;
		let at = reader.at;
		while (at < end) {
			const byte = chunk[at++] ?? END;
			if (byte >= ZERO && byte <= NINE) {
				value = value * DECIMAL + (byte - ZERO);
				digits = true;
				continue;
			}
			if (digits) {
				fields[field++] = value;
				value = 0;
				digits = false;
				if (field === width) {
					onNode(fields);
					nodes++;
					field = 0;
				}
			}
			if (byte === CLOSE_BRACKET) {
				reader.at = at;
				if (field !== 0) throw malformed("its last node is cut short");
				return nodes;
			}
			if (byte !== COMMA && !WHITESPACE.has(byte))
				throw malformed("its nodes hold more than whole numbers");
		}
		reader.at = at;
	}
}

/** Skip an array of numbers, nested or not, its opening bracket not yet read. */
function skipArray(reader: Reader): void {
	expect(reader, OPEN_BRACKET, "an array");
	let depth = 1;
	for (;;) {
		if (reader.at === reader.end && !refill(reader))
			throw malformed("an array never ends");
		const { chunk, end } = reader;
		let at = reader.at;
		while (at < end) {
			const byte = chunk[at++] ?? END;
			if (byte === OPEN_BRACKET) depth++;
			else if (byte === CLOSE_BRACKET && --depth === 0) {
				reader.at = at;
				return;
			} else if (byte === QUOTE || byte === OPEN_BRACE)
				throw malformed("an array before its strings holds more than numbers");
		}
		reader.at = at;
	}
}

/** Skip the rest of a string, its opening quote already read. */
function skipString(reader: Reader): void {
	let escaped = false;
	for (;;) {
		if (reader.at === reader.end && !refill(reader))
			throw malformed("a string never ends");
		const { chunk, end } = reader;
		let at = reader.at;
		while (at < end) {
			const byte = chunk[at++] ?? END;
			if (escaped) escaped = false;
			else if (byte === BACKSLASH) escaped = true;
			else if (byte === QUOTE) {
				reader.at = at;
				return;
			}
		}
		reader.at = at;
	}
}

/**
 * The string whose opening quote was just read, decoded from at most
 * NAME_BYTES_READ of its bytes, then cut to NAME_CHARS; the rest is
 * skipped unread. Those bytes hold more than NAME_CHARS characters
 * however they are written (an escape takes at most six), so a name cut
 * short is cut again by characters, and a character split at the cut
 * never shows.
 */
function readName(reader: Reader): string {
	const bytes: number[] = [];
	// How many bytes end outside an escape, so they parse as JSON.
	let whole = 0;
	let afterBackslash = false;
	let hexLeft = 0;
	for (;;) {
		const byte = next(reader);
		if (byte === END) throw malformed("a string never ends");
		if (afterBackslash) {
			afterBackslash = false;
			if (byte === LETTER_U) hexLeft = UNICODE_ESCAPE_DIGITS;
		} else if (hexLeft > 0) hexLeft--;
		else if (byte === QUOTE) break;
		else if (byte === BACKSLASH) afterBackslash = true;
		bytes.push(byte);
		if (!afterBackslash && hexLeft === 0) whole = bytes.length;
		if (bytes.length >= NAME_BYTES_READ) {
			skipRest(reader, afterBackslash);
			bytes.length = whole;
			break;
		}
	}
	const decoded: unknown = JSON.parse(
		`"${Buffer.from(bytes).toString("utf8")}"`,
	);
	if (typeof decoded !== "string") throw malformed("a name isn't a string");
	const characters = [...decoded];
	return characters.length > NAME_CHARS
		? `${characters.slice(0, NAME_CHARS).join("")}...`
		: decoded;
}

/**
 * Skip the rest of a string from inside it. A backslash just read makes
 * the next byte literal, so that one is skipped first, keeping a `\"`
 * from closing it; an escape's hex digits are never a quote.
 */
function skipRest(reader: Reader, afterBackslash: boolean): void {
	if (afterBackslash) next(reader);
	skipString(reader);
}

/**
 * The names at `wanted` of the strings array, its opening bracket already
 * read, each decoded as readName does; the rest are skipped, and the read
 * stops once every one wanted is found.
 */
function readNames(
	reader: Reader,
	wanted: ReadonlySet<number>,
): Map<number, string> {
	const names = new Map<number, string>();
	let index = 0;
	while (names.size < wanted.size) {
		const byte = nextSolid(reader);
		if (byte === COMMA) continue;
		if (byte === CLOSE_BRACKET || byte === END) break;
		if (byte !== QUOTE) throw malformed("its strings hold more than strings");
		if (wanted.has(index)) names.set(index, readName(reader));
		else skipString(reader);
		index++;
	}
	return names;
}

/** A kind's, or a kind and name's, nodes so far. */
interface Tally {
	count: number;
	selfSize: number;
}

/** A row not yet named: its kind, and the index of its name where it has one. */
interface Pending extends Tally {
	readonly type: string;
	readonly nameIndex?: number;
}

/** The largest TOP_ROWS of `rows` by self size, the larger count first on a tie. */
function largest<Row extends Tally>(rows: Row[]): Row[] {
	return rows
		.sort((a, b) => b.selfSize - a.selfSize || b.count - a.count)
		.slice(0, TOP_ROWS);
}

/**
 * Sum the heap snapshot at `file` by type, reading it as bytes, and
 * answer its figures: never a string's text, and of names only those
 * that say what built a node. Throws when the file is no snapshot V8
 * wrote, or ends early.
 */
export function summarizeSnapshot(file: string): HeapSummary {
	const reader: Reader = {
		fd: openSync(file, "r"),
		chunk: Buffer.alloc(CHUNK_BYTES),
		at: 0,
		end: 0,
	};
	try {
		return summarize(reader);
	} finally {
		closeSync(reader.fd);
	}
}

/** The summary of the snapshot `reader` reads from its start. */
function summarize(reader: Reader): HeapSummary {
	const { snapshot } = readHeader(reader);
	const fields = snapshot.meta.node_fields;
	const kinds = snapshot.meta.node_types[0];
	const width = fields.length;
	const typeAt = fields.indexOf("type");
	const nameAt = fields.indexOf("name");
	const sizeAt = fields.indexOf("self_size");
	if (typeAt < 0 || nameAt < 0 || sizeAt < 0)
		throw malformed("its nodes say no type, name or self size");
	const kindOf = (index: number) => kinds[index] ?? `(kind ${index})`;
	const named = kinds.map((kind) => NAMED_KINDS.has(kind));
	const large = kinds.map((kind) => STRING_KINDS.has(kind));
	const byType = new Map<number, Tally>();
	// Keyed by name index times the kinds there are, plus the kind, so a
	// name shared by two kinds makes two rows.
	const byName = new Map<number, Tally>();
	const largeStrings = { atLeast: LARGE_STRING_BYTES, count: 0, selfSize: 0 };
	let selfSize = 0;
	let nodes: number | undefined;
	const add = (tallies: Map<number, Tally>, key: number, size: number) => {
		const tally = tallies.get(key);
		if (tally === undefined) tallies.set(key, { count: 1, selfSize: size });
		else {
			tally.count++;
			tally.selfSize += size;
		}
	};
	for (let key = readKey(reader); key !== undefined; key = readKey(reader)) {
		if (key === "nodes") {
			expect(reader, OPEN_BRACKET, "the nodes array");
			nodes = scanNodes(reader, width, (node) => {
				const type = node[typeAt] ?? 0;
				const size = node[sizeAt] ?? 0;
				selfSize += size;
				add(byType, type, size);
				if (named[type] === true)
					add(byName, (node[nameAt] ?? 0) * kinds.length + type, size);
				if (large[type] === true && size >= LARGE_STRING_BYTES) {
					largeStrings.count++;
					largeStrings.selfSize += size;
				}
			});
			if (nodes !== snapshot.node_count)
				throw malformed(
					`its header says ${snapshot.node_count} nodes, but it holds ${nodes}`,
				);
			continue;
		}
		if (key !== "strings") {
			skipArray(reader);
			continue;
		}
		if (nodes === undefined)
			throw malformed("its strings come before its nodes");
		expect(reader, OPEN_BRACKET, "the strings array");
		const types = largest(
			[...byType].map(([type, tally]) => ({ type: kindOf(type), ...tally })),
		);
		const rows = largest<Pending>([
			...[...byType]
				.filter(([type]) => named[type] !== true)
				.map(([type, tally]) => ({ type: kindOf(type), ...tally })),
			...[...byName].map(([key, tally]) => ({
				type: kindOf(key % kinds.length),
				nameIndex: Math.floor(key / kinds.length),
				...tally,
			})),
		]);
		const names = readNames(
			reader,
			new Set(rows.flatMap(({ nameIndex }) => nameIndex ?? [])),
		);
		return {
			nodes,
			selfSize,
			byType: types,
			byTypeAndName: rows.map(({ type, nameIndex, count, selfSize }) => ({
				type,
				...(nameIndex === undefined
					? {}
					: { name: names.get(nameIndex) ?? "(name unread)" }),
				count,
				selfSize,
			})),
			largeStrings,
		};
	}
	throw malformed("it holds no strings");
}

/** Write `figures` to `into` as JSON, owner-only, never over a file already there. */
export function writeSummary(figures: HeapSummary, into: string): void {
	writeFileSync(into, `${JSON.stringify(figures, null, "\t")}\n`, {
		mode: OWNER_ONLY_FILE,
		flag: "wx",
	});
}

/** How a summing process is run, unless as sumApart runs one. */
export interface SumLimits {
	/** How long it may run before it is ended; SUM_LIMIT_MS unless given. */
	readonly limitMs?: number;
}

/**
 * Sum the snapshot at `raw` into `into` in a node process of its own,
 * started from this one's node with a heap of at most SUM_HEAP_MIB and
 * no environment, and settle once it has: rejected with what it said on
 * stderr when it fails, or once it runs past its limit, when it is ended.
 */
export function sumApart(
	raw: string,
	into: string,
	limits: SumLimits = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				`--max-old-space-size=${SUM_HEAP_MIB}`,
				"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
				import.meta.filename,
				raw,
				into,
			],
			{ env: {}, stdio: ["ignore", "ignore", "pipe"] },
		);
		let said = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			said = `${said}${text}`.slice(-REASON_CHARS);
		});
		const limitMs = limits.limitMs ?? SUM_LIMIT_MS;
		const limit = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(`summing took longer than ${limitMs} ms, so it was ended`),
			);
		}, limitMs);
		child.on("error", (error) => {
			clearTimeout(limit);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(limit);
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`the summing process ended ${code === null ? `by ${signal}` : `with status ${code}`}: ${said.trim() || "it said nothing"}`,
					),
				);
		});
	});
}

if (import.meta.main) {
	const [raw, into, ...rest] = process.argv.slice(2);
	if (raw === undefined || into === undefined || rest.length > 0) {
		process.stderr.write(
			"Usage: node host/service/heap-summary.ts RAW SUMMARY\n",
		);
		process.exitCode = 1;
	} else {
		try {
			writeSummary(summarizeSnapshot(raw), into);
		} catch (error) {
			process.stderr.write(
				`${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		}
	}
}
