/**
 * What every turn of a session reads before the conversation starts:
 * its tool declarations and its system prompt's sections, as the first
 * system message of each session log records them.
 *
 * This is the always-on context, paid for again at the cache-read
 * price on every turn. The ledger counts tokens per turn but not what
 * they were spent on, so a 423 KB instruction file or a tool nobody
 * calls only shows as a high average. Reading it from the log makes
 * each piece visible by name.
 */

import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { repoOf } from "../../lib/ledger/index.ts";

/** One session's always-on context, piece by piece, in characters. */
export interface StandingPrompt {
	readonly session: string;
	/**
	 * The repository, as the ledger names it, or the working directory
	 * when the path names none (a checkout outside `src/{host}/{owner}`),
	 * so a heavy one is not lost among sessions that have no repository.
	 */
	readonly repo: string | null;
	readonly tools: number;
	/**
	 * Characters per piece: `declarations` for the tools' schemas, then
	 * each section by its name (pi's own `tools` section is the short list
	 * of tool names, not the declarations).
	 */
	readonly pieces: Readonly<Record<string, number>>;
}

/** A session log's lines, as far as this module reads them. */
interface LogLine {
	type?: string;
	id?: string;
	cwd?: string;
	message?: {
		role?: string;
		sections?: Record<string, unknown>;
		toolsAdded?: unknown[];
	};
}

/** The longest a log is read looking for its system message. */
const MOST_LINES = 50;

/**
 * The always-on context a session started with, or nothing when its
 * log holds no system message in its first lines (an older pi, or a
 * log that is not a session).
 */
export async function standingOf(
	path: string,
): Promise<StandingPrompt | undefined> {
	const lines = createInterface({ input: createReadStream(path) });
	let session: string | undefined;
	let cwd: string | null = null;
	let read = 0;
	try {
		for await (const text of lines) {
			if (++read > MOST_LINES) return undefined;
			let line: LogLine;
			try {
				line = JSON.parse(text) as LogLine;
			} catch {
				continue;
			}
			if (line.type === "session") {
				session = line.id;
				cwd = line.cwd ?? null;
				continue;
			}
			if (line.message?.role !== "system") continue;
			const pieces: Record<string, number> = {};
			const tools = line.message.toolsAdded ?? [];
			pieces.declarations = JSON.stringify(tools).length;
			for (const [name, value] of Object.entries(line.message.sections ?? {})) {
				if (typeof value === "string") pieces[name] = value.length;
			}
			return {
				session: session ?? path,
				repo: repoOf(cwd) ?? cwd,
				tools: tools.length,
				pieces,
			};
		}
		return undefined;
	} finally {
		lines.close();
	}
}

/** Every session log under `dir` written to since `since`. */
export function logsSince(dir: string, since: number): string[] {
	const found: string[] = [];
	let folders: string[];
	try {
		folders = readdirSync(dir);
	} catch {
		return found;
	}
	for (const folder of folders) {
		const inside = join(dir, folder);
		let names: string[];
		try {
			names = readdirSync(inside);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(inside, name);
			try {
				if (statSync(path).mtimeMs >= since) found.push(path);
			} catch {
				// A log removed while listing was never there.
			}
		}
	}
	return found;
}

/** The middle value, or 0 for none. */
function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** A repository's typical always-on context, by its median session. */
export interface StandingByRepo {
	readonly repo: string;
	readonly sessions: number;
	readonly total: number;
	/** The median characters of each piece, largest first. */
	readonly pieces: readonly (readonly [string, number])[];
}

/** Sessions grouped by repository, heaviest typical context first. */
export function byRepo(prompts: readonly StandingPrompt[]): StandingByRepo[] {
	const groups = new Map<string, StandingPrompt[]>();
	for (const prompt of prompts) {
		const repo = prompt.repo ?? "(no repository)";
		groups.set(repo, [...(groups.get(repo) ?? []), prompt]);
	}
	const out: StandingByRepo[] = [];
	for (const [repo, members] of groups) {
		const names = new Set(members.flatMap((m) => Object.keys(m.pieces)));
		const pieces = [...names]
			.map(
				(name) =>
					[name, median(members.map((m) => m.pieces[name] ?? 0))] as const,
			)
			.filter(([, size]) => size > 0)
			.sort((a, b) => b[1] - a[1]);
		out.push({
			repo,
			sessions: members.length,
			total: median(
				members.map((m) => Object.values(m.pieces).reduce((a, b) => a + b, 0)),
			),
			pieces,
		});
	}
	return out.sort((a, b) => b.total - a.total);
}
