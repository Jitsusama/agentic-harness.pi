/**
 * Note which windows here are joined to a session another machine
 * holds, then rewrite the launcher's restore file, as a user timer does
 * each minute (lib/internal/quest/windows-elsewhere.ts). A boot that
 * ends takes the windows with it but not the sessions, which run on, so
 * the next boot reads this note to offer the windows back.
 *
 * It asks each kitty here for its windows and the mycelium node for its
 * sessions. When one of them doesn't answer, the note is left as it
 * stands rather than emptied, since the windows it names may well still
 * be there. Node runs it as it stands, stripping the types:
 *
 *   node scripts/windows-elsewhere.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { refreshRestoreFile } from "../extensions/quest-workflow/session-registry.ts";
import { dataDir, stateDir } from "../lib/internal/paths.ts";
import { currentBootToken } from "../lib/internal/quest/process-liveness.ts";
import {
	nextNote,
	readWindowsNote,
	windowsElsewhere,
	windowsNotePath,
	writeWindowsNote,
} from "../lib/internal/quest/windows-elsewhere.ts";

/** How long one kitty or the node may take to answer. */
const ASK_MS = 5000;

/** The answer a program prints as JSON, or undefined when it gives none. */
function asked(program: string, args: readonly string[]): unknown {
	try {
		const out = execFileSync(program, args, {
			encoding: "utf8",
			timeout: ASK_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return JSON.parse(out);
	} catch {
		// Not installed, not running, or slow: nothing from it this minute.
		return undefined;
	}
}

/** Each kitty's remote-control socket here, `@kitty-<pid>` in the abstract namespace. */
function kittySockets(): string[] {
	let table: string;
	try {
		table = readFileSync("/proc/net/unix", "utf8");
	} catch {
		return [];
	}
	return [...new Set(table.match(/@kitty-\d+(?=\s*$)/gm) ?? [])];
}

const boot = currentBootToken();
const sessions = asked("mycelium", ["sessions"]);
const kitties = kittySockets().map((socket) =>
	asked("kitty", ["@", "--to", `unix:${socket}`, "ls"]),
);
if (
	boot !== undefined &&
	sessions !== undefined &&
	kitties.every((answer) => answer !== undefined)
) {
	const path = windowsNotePath(stateDir("quest-workflow"));
	const windows = windowsElsewhere(kitties, sessions, hostname());
	writeWindowsNote(path, nextNote(readWindowsNote(path), boot, windows));
}
refreshRestoreFile(join(dataDir("quest-workflow"), "quests"));
