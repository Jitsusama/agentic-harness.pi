/**
 * Count why pi redrew the whole screen, from the log pi-tui keeps when
 * `PI_TUI_DEBUG_REDRAW=1`, so the fix for the ask dialogs that lose
 * their text while a reply streams in (Joel, 11 November) starts from
 * what happens most rather than from a guess.
 *
 * pi-tui writes a line at each full redraw to `pi-tui-debug.log` in
 * pi's agent folder, as `[<ISO>] fullRender: <reason> (prev=N, new=N,
 * height=N)`, where a reason may carry its own numbers in brackets. The
 * log names no session, so this counts every pi that wrote it, by the
 * reason's words alone. Node runs it as it stands, stripping the types:
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     scripts/redraw-tally.ts [--since <ISO>] [log]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One kind of full redraw, and how often it came. */
interface RedrawKind {
	/** The reason's words, without the numbers it carried. */
	readonly reason: string;
	readonly count: number;
	readonly first: string;
	readonly last: string;
}

/** What the log says about full redraws. */
interface RedrawTally {
	readonly redraws: number;
	/** Lines that weren't a redraw pi-tui wrote, read past. */
	readonly unread: number;
	/** Each kind of redraw, most first. */
	readonly kinds: readonly RedrawKind[];
}

const LINE =
	/^\[(?<at>[^\]]+)\] fullRender: (?<reason>.*?) \(prev=\d+, new=\d+, height=\d+\)$/;

/** Count the full redraws in `log`, from `since` on when given. */
export function tallyRedraws(log: string, since?: string): RedrawTally {
	const kinds = new Map<
		string,
		{ count: number; first: string; last: string }
	>();
	let redraws = 0;
	let unread = 0;
	for (const line of log.split("\n")) {
		if (line.trim() === "") continue;
		const groups = LINE.exec(line)?.groups;
		const at = groups?.at;
		const said = groups?.reason;
		if (at === undefined || said === undefined) {
			unread += 1;
			continue;
		}
		if (since !== undefined && at < since) continue;
		const reason = kindOf(said);
		const kind = kinds.get(reason);
		kinds.set(
			reason,
			kind
				? { ...kind, count: kind.count + 1, last: at }
				: { count: 1, first: at, last: at },
		);
		redraws += 1;
	}
	return {
		redraws,
		unread,
		kinds: [...kinds]
			.map(([reason, kind]) => ({ reason, ...kind }))
			.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
	};
}

/** A reason's words without the numbers it carried, as one kind. */
function kindOf(reason: string): string {
	return reason.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** The tally as lines to read. */
export function formatRedraws(tally: RedrawTally, path: string): string {
	if (tally.redraws === 0)
		return `No full redraws in ${path}. Is PI_TUI_DEBUG_REDRAW=1 set in the pis you watch?\n`;
	const width = Math.max(
		...tally.kinds.map((kind) => String(kind.count).length),
	);
	const lines = [
		`${tally.redraws} full ${tally.redraws === 1 ? "redraw" : "redraws"} in ${path}, by why:`,
		...tally.kinds.map(
			(kind) =>
				`  ${String(kind.count).padStart(width)}  ${percent(kind.count, tally.redraws)}  ${kind.reason}  (last ${kind.last})`,
		),
	];
	if (tally.unread > 0)
		lines.push(`${tally.unread} lines weren't a redraw, and were read past.`);
	return `${lines.join("\n")}\n`;
}

/** A share as a whole percentage, padded to line up. */
function percent(part: number, whole: number): string {
	const ALL = 100;
	return `${String(Math.round((part / whole) * ALL)).padStart(3)}%`;
}

/** Where pi-tui writes the log: pi's agent folder. */
function defaultLog(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
		"pi-tui-debug.log",
	);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--since");
	const since = at >= 0 ? args[at + 1] : undefined;
	const rest = args.filter(
		(_, index) => at < 0 || (index !== at && index !== at + 1),
	);
	const path = rest[0] ?? defaultLog();
	let log = "";
	try {
		log = readFileSync(path, "utf8");
	} catch (error) {
		// No log yet is no redraws yet; any other failure is said.
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	process.stdout.write(formatRedraws(tallyRedraws(log, since), path));
}
