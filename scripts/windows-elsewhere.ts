/**
 * Note which windows here are joined to a session another machine
 * holds, then rewrite the launcher's restore file, as a user timer does
 * each minute (lib/internal/quest/reopening/windows-elsewhere.ts). A boot that
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

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { refreshRestoreFile } from "../extensions/quest-workflow/sessions/restore.ts";
import { currentBootToken } from "../lib/internal/boot-token.ts";
import { dataDir, stateDir } from "../lib/internal/paths.ts";
import { askJson } from "../lib/internal/quest/reopening/ask-json.ts";
import { sessionsKittyDoor } from "../lib/internal/quest/reopening/sessions-kitty.ts";
import {
	nextNote,
	readWindowsNote,
	windowsElsewhere,
	windowsNotePath,
	writeWindowsNote,
} from "../lib/internal/quest/reopening/windows-elsewhere.ts";

/**
 * Each kitty's remote-control socket here: `@kitty-<pid>` in the abstract
 * namespace, as kitty.conf names Joel's own, and the sessions kitty's in
 * the runtime folder, since its command line names that one instead.
 */
function kittySockets(): string[] {
	const door = sessionsKittyDoor();
	const sessions = door?.kind === "socket" ? [door.path] : [];
	let table: string;
	try {
		table = readFileSync("/proc/net/unix", "utf8");
	} catch {
		return sessions;
	}
	return [...new Set(table.match(/@kitty-\d+(?=\s*$)/gm) ?? []), ...sessions];
}

const boot = currentBootToken();
const sessions = askJson("mycelium", ["sessions"]);
const kitties = kittySockets().map((socket) =>
	askJson("kitty", ["@", "--to", `unix:${socket}`, "ls"]),
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
