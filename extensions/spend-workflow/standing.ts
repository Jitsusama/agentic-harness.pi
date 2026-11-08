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
	/**
	 * Characters later system messages declared again while the session
	 * was still starting, before its third answer: a tool under a name
	 * already declared, or a section that replaces one already sent. The
	 * prefix keeps both copies, so each turn reads them again until a
	 * compaction, as every session a quest spawn started did from 3 to 4
	 * November 2026. A tool or section declared for the first time, as a
	 * tool loaded on demand is, is not counted: that is wanted, not a copy.
	 */
	readonly redeclared: number;
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

/** A tool declaration's name, when it carries one. */
function toolName(tool: unknown): string | undefined {
	if (typeof tool !== "object" || tool === null || !("name" in tool)) {
		return undefined;
	}
	return typeof tool.name === "string" ? tool.name : undefined;
}

/** The longest a log is read looking for its system message. */
const MOST_LINES = 50;

/** The longest a log is read past it for what start declared again. */
const MOST_LINES_AFTER = 200;

/** The answers by which a session counts as started. */
const STARTED_AFTER_ANSWERS = 3;

/** Characters a system message declares: its tools, then its sections. */
function declared(message: NonNullable<LogLine["message"]>): {
	readonly tools: unknown[];
	readonly pieces: Record<string, number>;
} {
	const tools = message.toolsAdded ?? [];
	const pieces: Record<string, number> = {
		declarations: JSON.stringify(tools).length,
	};
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		if (typeof value === "string") pieces[name] = value.length;
	}
	return { tools, pieces };
}

/**
 * Characters a later system message sends of what the prefix already
 * holds: a tool under a name already declared, and a section replacing
 * one already sent, which pi sends whole. Tools and sections new to the
 * session are left out.
 */
function declaredAgain(
	message: NonNullable<LogLine["message"]>,
	toolsHeld: ReadonlySet<string>,
	sectionsHeld: ReadonlySet<string>,
): number {
	const tools = (message.toolsAdded ?? [])
		.filter((tool) => {
			const name = toolName(tool);
			return name !== undefined && toolsHeld.has(name);
		})
		.reduce<number>((sum, tool) => sum + JSON.stringify(tool).length, 0);
	const sections = Object.entries(message.sections ?? {})
		.filter(
			([name, value]) => typeof value === "string" && sectionsHeld.has(name),
		)
		.reduce<number>((sum, [, value]) => sum + String(value).length, 0);
	return tools + sections;
}

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
	let first: ReturnType<typeof declared> | undefined;
	let readAfter = 0;
	let answers = 0;
	let redeclared = 0;
	// Every name the prefix already holds a copy of: removing a tool or
	// replacing a section leaves the old copy where it was.
	const toolsHeld = new Set<string>();
	const sectionsHeld = new Set<string>();
	const standing = (): StandingPrompt | undefined =>
		first && {
			session: session ?? path,
			repo: repoOf(cwd) ?? cwd,
			tools: first.tools.length,
			pieces: first.pieces,
			redeclared,
		};
	try {
		for await (const text of lines) {
			if (!first && ++read > MOST_LINES) return undefined;
			if (first && ++readAfter > MOST_LINES_AFTER) break;
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
			if (line.type === "compaction") break;
			if (line.message?.role === "assistant") {
				if (first && ++answers >= STARTED_AFTER_ANSWERS) break;
				continue;
			}
			if (line.message?.role !== "system") continue;
			const message = declared(line.message);
			if (first)
				redeclared += declaredAgain(line.message, toolsHeld, sectionsHeld);
			else first = message;
			for (const tool of message.tools) {
				const name = toolName(tool);
				if (name) toolsHeld.add(name);
			}
			for (const name of Object.keys(message.pieces)) sectionsHeld.add(name);
		}
		return standing();
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
	/** How many of its sessions declared something again as they started. */
	readonly redeclaring: number;
	/** The median characters those sessions declared again. */
	readonly redeclared: number;
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
		const again = members.map((m) => m.redeclared).filter((size) => size > 0);
		out.push({
			repo,
			sessions: members.length,
			redeclaring: again.length,
			redeclared: median(again),
			total: median(
				members.map((m) => Object.values(m.pieces).reduce((a, b) => a + b, 0)),
			),
			pieces,
		});
	}
	return out.sort((a, b) => b.total - a.total);
}
