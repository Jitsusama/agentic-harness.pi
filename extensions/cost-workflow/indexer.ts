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
import { readTurns } from "../../lib/ledger/index.js";
import type { IndexOutcome } from "./report.js";

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

function loadWatermarks(path: string): Watermarks {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null
			? (parsed as Watermarks)
			: {};
	} catch {
		// A truncated watermark file costs one full re-index, which is
		// idempotent, so it is not worth failing over.
		return {};
	}
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

	if (!existsSync(root)) {
		return {
			files: 0,
			scanned: 0,
			skipped: 0,
			lines: 0,
			unparseable: 0,
			inserted: 0,
			duplicates: 0,
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
			marks[path] = size;
			scanned += 1;
		}
	}

	writeFileSync(watermarkPath, JSON.stringify(marks), "utf8");
	return {
		files,
		scanned,
		skipped,
		lines,
		unparseable,
		inserted,
		duplicates,
		seconds: (Date.now() - started) / 1000,
	};
}
