import {
	createReadStream,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TurnStore } from "../../lib/core/observability/index.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import { SCAN_VERSION, startScan } from "../../lib/ledger/index.ts";
import {
	carriedFolder,
	carriedFor,
	keepCarried,
	pruneCarried,
} from "./carried.ts";
import type { IndexOutcome } from "./report.ts";

/** Where pi keeps session logs, honouring its own directory override. */
export function sessionsDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	return agentDir
		? join(agentDir, "sessions")
		: join(homedir(), ".pi", "agent", "sessions");
}

/**
 * Byte length of each log at the last pass, so a log that has not grown
 * is not read again. Session logs are append-only, which is what makes a
 * size comparison sufficient and a content hash unnecessary here.
 */
type Watermarks = Record<string, number>;

/**
 * The sizes, and the scan version that read them. A size only proves a
 * log has not grown; it says nothing about whether the scan that read
 * it extracted everything the current one does. Without the version,
 * every log indexed before tool calls were recorded was skipped forever
 * and the live ledger held turns but not a single call.
 */
interface WatermarkFile {
	readonly scanVersion: number;
	readonly sizes: Watermarks;
}

function isWatermarkFile(value: unknown): value is WatermarkFile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.scanVersion === "number" &&
		typeof candidate.sizes === "object" &&
		candidate.sizes !== null
	);
}

/**
 * The sizes worth trusting: those read by the current scan. A file from
 * an older scan, or in the older bare-map format that recorded no
 * version at all, is trusted for nothing, which costs one full
 * re-index, and a re-index is idempotent.
 */
function loadWatermarks(path: string): Watermarks {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isWatermarkFile(parsed)) return {};
		return parsed.scanVersion === SCAN_VERSION ? { ...parsed.sizes } : {};
	} catch {
		// A truncated watermark file costs one full re-index, which is
		// idempotent, so it is not worth failing over.
		return {};
	}
}

function saveWatermarks(path: string, sizes: Watermarks): void {
	const file: WatermarkFile = { scanVersion: SCAN_VERSION, sizes };
	// Written whole, since a file cut short trusts nothing and costs a
	// full re-index of every log.
	writeWhole(path, JSON.stringify(file));
}

/** The byte that ends a line. */
const NEWLINE = 0x0a;

/** A line's text, without the carriage return a CRLF ending leaves. */
function textOf(bytes: Buffer): string {
	const text = bytes.toString("utf8");
	return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * Give `take` each whole line of a log from byte `start`, a line at a
 * time, and answer the byte after the last whole one. A last line not
 * yet ended is left for the pass after it ends, since it may be a write
 * still under way.
 */
async function readLines(
	path: string,
	start: number,
	take: (line: string) => void,
): Promise<number> {
	const input = createReadStream(path, { start });
	let offset = start;
	let unended: Buffer[] = [];
	try {
		for await (const chunk of input) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			let from = 0;
			for (
				let end = bytes.indexOf(NEWLINE, from);
				end !== -1;
				end = bytes.indexOf(NEWLINE, from)
			) {
				const piece = bytes.subarray(from, end);
				const line =
					unended.length > 0 ? Buffer.concat([...unended, piece]) : piece;
				unended = [];
				offset += line.length + 1;
				take(textOf(line));
				from = end + 1;
			}
			if (from < bytes.length) unended.push(bytes.subarray(from));
		}
	} finally {
		// A reader left early leaves its file open unless it is destroyed.
		input.destroy();
	}
	return offset;
}

/**
 * Read every session log into the ledger, skipping those that have not
 * grown since the last pass, and reading a grown one from where the
 * last pass stopped when what that pass carried can be trusted.
 *
 * Logs are streamed a line at a time rather than read whole: the largest
 * here is 1.2 GB, well past the ceiling on a JavaScript string, so
 * anything that reads a file in one piece cannot open it at all.
 */
export async function indexSessionLogs(
	store: TurnStore,
	watermarkPath: string,
	root = sessionsDir(),
): Promise<IndexOutcome> {
	const started = Date.now();
	const marks = loadWatermarks(watermarkPath);
	const folder = carriedFolder(watermarkPath);
	const refused: string[] = [];
	let resumed = 0;
	let files = 0;
	let scanned = 0;
	let skipped = 0;
	let lines = 0;
	let unparseable = 0;
	let inserted = 0;
	let duplicates = 0;
	let insertedCalls = 0;
	let duplicateCalls = 0;
	let insertedDropped = 0;

	if (!existsSync(root)) {
		return {
			files: 0,
			scanned: 0,
			skipped: 0,
			lines: 0,
			unparseable: 0,
			inserted: 0,
			duplicates: 0,
			insertedCalls: 0,
			duplicateCalls: 0,
			insertedDropped: 0,
			resumed: 0,
			refused: [],
			seconds: 0,
		};
	}

	for (const dir of readdirSync(root)) {
		let names: string[];
		try {
			names = readdirSync(join(root, dir));
		} catch {
			// A session directory that vanished between listing and
			// reading is simply gone; nothing to account for.
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			files += 1;
			const path = join(root, dir, name);
			let file: ReturnType<typeof statSync>;
			try {
				file = statSync(path);
			} catch {
				continue;
			}
			const size = file.size;
			if (marks[path] === size) {
				skipped += 1;
				continue;
			}

			const carried = carriedFor(folder, path, file);
			if (carried && "refused" in carried) refused.push(carried.refused);
			const from = carried && "state" in carried ? carried : undefined;
			if (from) resumed += 1;
			const reading = startScan(name, from?.state);
			const offset = await readLines(path, from?.offset ?? 0, reading.feed);
			const scan = reading.take();
			lines += scan.coverage.lines;
			unparseable += scan.coverage.unparseable;
			await store.recordSession(scan.session);
			const outcome = await store.recordTurns(scan.turns);
			inserted += outcome.inserted;
			duplicates += outcome.duplicates;
			const callOutcome = await store.recordCalls(scan.calls);
			insertedCalls += callOutcome.inserted;
			duplicateCalls += callOutcome.duplicates;
			await store.recordInnerCalls(scan.inner);
			await store.recordDeclarations(scan.declarations);
			const droppedOutcome = await store.recordDropped(scan.dropped);
			insertedDropped += droppedOutcome.inserted;
			keepCarried(folder, path, file, offset, reading.carry());
			marks[path] = size;
			scanned += 1;
			// Saved after every log, so a pass cut short (its session ended,
			// a reload, a failure further on) keeps what it read rather than
			// leaving the next one to read it all again.
			saveWatermarks(watermarkPath, marks);
		}
	}

	saveWatermarks(watermarkPath, marks);
	pruneCarried(folder);
	return {
		files,
		scanned,
		skipped,
		lines,
		unparseable,
		inserted,
		duplicates,
		insertedCalls,
		duplicateCalls,
		insertedDropped,
		resumed,
		refused,
		seconds: (Date.now() - started) / 1000,
	};
}
