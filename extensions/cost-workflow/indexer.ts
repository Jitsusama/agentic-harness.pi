import {
	createReadStream,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TurnStore } from "@jitsusama/agentic-harness.core/observability";
import { readTurns, SCAN_VERSION } from "../../lib/ledger/index.ts";
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
	writeFileSync(path, JSON.stringify(file), "utf8");
}

async function* linesOf(path: string): AsyncGenerator<string> {
	const reader = createInterface({
		input: createReadStream(path),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of reader) yield line;
}

/**
 * Read every session log into the ledger, skipping those that have not
 * grown since the last pass.
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
			let size: number;
			try {
				size = statSync(path).size;
			} catch {
				continue;
			}
			if (marks[path] === size) {
				skipped += 1;
				continue;
			}

			const buffered: string[] = [];
			for await (const line of linesOf(path)) buffered.push(line);
			const scan = readTurns(name, buffered);
			lines += scan.coverage.lines;
			unparseable += scan.coverage.unparseable;
			await store.recordSession(scan.session);
			const outcome = await store.recordTurns(scan.turns);
			inserted += outcome.inserted;
			duplicates += outcome.duplicates;
			const callOutcome = await store.recordCalls(scan.calls);
			insertedCalls += callOutcome.inserted;
			duplicateCalls += callOutcome.duplicates;
			const droppedOutcome = await store.recordDropped(scan.dropped);
			insertedDropped += droppedOutcome.inserted;
			marks[path] = size;
			scanned += 1;
		}
	}

	saveWatermarks(watermarkPath, marks);
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
		seconds: (Date.now() - started) / 1000,
	};
}
