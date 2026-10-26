/**
 * The programs a process runs under, nearest first.
 *
 * A terminal's environment variables say which terminal a session is
 * in, and usually that is enough. They also leak: a kitty started from
 * inside wezterm hands `WEZTERM_PANE` to every shell it opens, and a
 * terminal started by a launcher may set nothing at all. The process
 * ancestry says which terminals are really above the session, and in
 * what order, so it settles both.
 *
 * On Linux this is a handful of file reads under `/proc`. On macOS it
 * is one `ps` call, so it is only asked for when the environment
 * leaves the question open.
 */

import { execFile } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { TerminalPlatform } from "../../terminal/types.ts";

const execFileAsync = promisify(execFile);

/** How far up the tree to look. A session is rarely more than a few deep. */
const MAX_DEPTH = 32;

/** How long the macOS process listing may take. */
const PS_TIMEOUT_MS = 2_000;

/**
 * A program name as a terminal driver would know it: the basename,
 * without the leading dot and `-wrapped` suffix a Nix wrapper adds, or
 * the `.app` bundle a macOS path runs inside, lowercased.
 */
export function normaliseProgramName(name: string): string {
	const app = /\/([^/]+)\.app\//i.exec(name);
	const base = app?.[1] ?? basename(name);
	return base
		.replace(/^\.+/, "")
		.replace(/-wrapped$/, "")
		.replace(/^-/, "")
		.toLowerCase();
}

/**
 * The programs above `pid` on Linux, nearest first, read from `/proc`.
 * Stops quietly at the first process it cannot read.
 */
export function linuxAncestry(pid: number = process.pid): string[] {
	const names: string[] = [];
	let current = parentOfLinux(pid);
	for (let depth = 0; current && current > 1 && depth < MAX_DEPTH; depth++) {
		const name = programOfLinux(current);
		if (name) names.push(normaliseProgramName(name));
		current = parentOfLinux(current);
	}
	return names;
}

function parentOfLinux(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name sits in parentheses and may itself hold
		// spaces or parentheses, so read the fields after the last one.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ppid = Number(fields[1]);
		return Number.isInteger(ppid) ? ppid : undefined;
	} catch {
		// The process ended or is not ours to read: the walk stops here.
		return undefined;
	}
}

function programOfLinux(pid: number): string | undefined {
	try {
		return readlinkSync(`/proc/${pid}/exe`);
	} catch {
		// Another user's process hides its exe; its comm is still there.
		try {
			return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
		} catch {
			// Gone between the two reads: nothing to name.
			return undefined;
		}
	}
}

/** The programs above `pid` on macOS, nearest first, from one `ps` call. */
export async function darwinAncestry(
	pid: number = process.pid,
): Promise<string[]> {
	let listing: string;
	try {
		const { stdout } = await execFileAsync(
			"/bin/ps",
			["-A", "-o", "pid=,ppid=,comm="],
			{ timeout: PS_TIMEOUT_MS },
		);
		listing = stdout;
	} catch {
		// No process listing means no ancestry, which only means the
		// environment's word has to stand alone.
		return [];
	}
	return ancestryFromListing(listing, pid);
}

/**
 * The programs above `pid` in a `ps -o pid=,ppid=,comm=` listing,
 * nearest first.
 */
export function ancestryFromListing(listing: string, pid: number): string[] {
	const rows = new Map<number, { ppid: number; comm: string }>();
	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (!match) continue;
		rows.set(Number(match[1]), {
			ppid: Number(match[2]),
			comm: (match[3] ?? "").trim(),
		});
	}
	const names: string[] = [];
	let current = rows.get(pid)?.ppid;
	for (let depth = 0; current && current > 1 && depth < MAX_DEPTH; depth++) {
		const row = rows.get(current);
		if (!row) break;
		names.push(normaliseProgramName(row.comm));
		current = row.ppid;
	}
	return names;
}

/** The ancestry of this process on the given platform, nearest first. */
export async function processAncestry(
	platform: TerminalPlatform,
): Promise<string[]> {
	return platform === "linux" ? linuxAncestry() : darwinAncestry();
}
