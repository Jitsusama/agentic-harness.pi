/**
 * mycelium's attach client in a real terminal, end to end: the program
 * Joel's kitty window runs, under a pseudo-terminal with an interactive
 * shell, joined to a conversation of a sealed host composed as the host
 * program composes it. What its screen shows is read through a terminal
 * emulator, and its Ctrl+G and Ctrl+Z run through its own tty: a scripted
 * editor in that terminal, and bash's own job control. Only kitty itself
 * is left out. Runs on the host's pi as support/host-pi.ts finds it, a
 * mycelium with mycelium#112's client (MYCELIUM_BIN, else the PATH's) and
 * script(1): an ordinary run without one skips it saying which, and
 * `pnpm test:host` fails instead. A mycelium is judged by its own binary,
 * since an older one attaches all the same and only says, on the screen,
 * that it has no editor.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Folders, folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";
import { AT_PROMPT, openTty, type Tty } from "./support/tty.ts";
import { attach, type Viewer } from "./support/viewer.ts";

const packageDir = hostPackageDir();
const mycelium = process.env.MYCELIUM_BIN || onPath("mycelium");
const hasScript = spawnSync("script", ["--version"]).status === 0;
/** A string only mycelium#112's client and later hold: the name of the file it hands the editor. */
const HANDOFF_MARK = "mycelium-edit-";
/** What this machine lacks to run the proof: skipped saying so, or failed under `pnpm test:host`. */
const missing = [
	packageDir ? undefined : hostPiMissing(),
	mycelium
		? handsOff(mycelium)
		: "No mycelium: set MYCELIUM_BIN, or put core.nix's mycelium (mycelium#112 or later) on the PATH",
	hasScript ? undefined : "No script(1) on the PATH: put util-linux on it",
].filter((each) => each !== undefined);
if (missing.length > 0 && process.env[HOST_PI_REQUIRED])
	throw new Error(missing.join("; "));
/** Why `program` can't run the proof, or nothing when its client edits and suspends. */
function handsOff(program: string): string | undefined {
	if (!existsSync(program)) return `No mycelium to run: ${program}`;
	if (readFileSync(program).includes(HANDOFF_MARK)) return undefined;
	return `The mycelium at ${program} predates mycelium#112, so its client neither edits nor suspends: set MYCELIUM_BIN to one built from mycelium 509febc or later, as core.nix#2843 pins`;
}

/** A case: a turn or two, and a client joining, leaving and coming back. */
const CASE_MS = 60_000;
const ROWS = 30;
const COLUMNS = 100;
const ENTER = "\r";
/** Joel's chords, as kitty's keyboard protocol sends them. */
const CTRL_G = "\u001b[103;5u";
const CTRL_Z = "\u001b[122;5u";

let sealed: Seal;
let host: ScreenHost;
let editor: string;
let editorHadTheTerminal: string;
let work: Folders;
const opened: { close(): Promise<void> }[] = [];

describe.skipIf(missing.length > 0)(
	`mycelium's attach client in a terminal of its own${missing.length > 0 ? ` (${missing.join("; ")})` : ""}`,
	() => {
		beforeAll(async () => {
			if (!packageDir) return;
			sealed = await seal();
			work = folders(sealed);
			host = await startScreenHost(sealed, packageDir);
			editorHadTheTerminal = join(sealed.root, "editor-had-the-terminal");
			editor = join(sealed.root, "editor");
			writeFileSync(
				editor,
				[
					"#!/bin/sh",
					"# A person's editor, scripted: it adds to the draft it is given,",
					"# and says whether it had the terminal to itself.",
					`if [ -t 0 ] && [ -t 1 ]; then echo yes > '${editorHadTheTerminal}'; fi`,
					`printf '%s and more' "$(cat "$1")" > "$1.new" && mv "$1.new" "$1"`,
					"",
				].join("\n"),
			);
			chmodSync(editor, 0o755);
		}, CASE_MS);
		afterAll(async () => {
			for (const each of opened) await each.close().catch(() => undefined);
			await host?.stop();
			await sealed?.dispose();
		}, CASE_MS);

		it(
			"shows the conversation and types into it, and closing the window only leaves it",
			async () => {
				const { sessionId } = await host.open(folder());
				const window = await joined(sessionId);

				window.type(`from the window${ENTER}`);
				await window.shows("heard: from the window");
				expect(
					window.terminal.buffer.active.type,
					"pi's screen is the alternate one",
				).toBe("alternate");

				await window.close();

				const after = await viewer(sessionId);
				await after.shows("heard: from the window");
				expect((await host.list()).map((s) => s.sessionId)).toContain(
					sessionId,
				);
			},
			CASE_MS,
		);

		it(
			"edits a draft in the person's editor, in the window's own terminal, on Ctrl+G",
			async () => {
				const { sessionId } = await host.open(folder());
				const window = await joined(sessionId);
				window.type("a draft");
				await window.shows("a draft");

				window.type(CTRL_G);

				await window.shows("a draft and more");
				expect(readFileSync(editorHadTheTerminal, "utf8")).toBe("yes\n");
				window.type(ENTER);
				await window.shows("heard: a draft and more");
			},
			CASE_MS,
		);

		it(
			"suspends to the shell on Ctrl+Z while the conversation runs on, and fg brings it back",
			async () => {
				const { sessionId } = await host.open(folder());
				const window = await joined(sessionId);
				const other = await viewer(sessionId);

				window.type(CTRL_Z);

				await window.shows(/Stopped\s+mycelium/);
				await window.shows(AT_PROMPT);
				expect(
					window.terminal.buffer.active.type,
					"the shell has its own screen back",
				).toBe("normal");
				other.type(`while it was away${ENTER}`);
				await other.shows("heard: while it was away");

				window.type(`fg${ENTER}`);

				await window.shows("heard: while it was away");
				expect(window.terminal.buffer.active.type).toBe("alternate");
				window.type(`back again${ENTER}`);
				await other.shows("heard: back again");
			},
			CASE_MS,
		);
	},
);

/** A fresh working folder for one conversation, trusted so it asks nothing. */
function folder(): string {
	return work.trusted();
}

/** Where `program` is on this process's PATH, if anywhere. */
function onPath(program: string): string | undefined {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((folder) => folder !== "")
		.map((folder) => join(folder, program))
		.find((path) => existsSync(path));
}

/** A window with a shell, which joins `sessionId` as the launcher's Go To does. */
async function joined(sessionId: string): Promise<Tty> {
	if (!mycelium || !existsSync(mycelium))
		throw new Error(`No mycelium to run: ${mycelium}`);
	const window = await openTty(sealed, {
		mycelium,
		editor,
		rows: ROWS,
		columns: COLUMNS,
	});
	opened.push(window);
	window.type(
		`mycelium --realm ${sealed.realm} attach --host ${sealed.realm}-attended --session ${sessionId}${ENTER}`,
	);
	await window.shows(new RegExp(`^─{${COLUMNS}}$`, "m"));
	return window;
}

/** A viewer through the socket, as a second window's client is one. */
async function viewer(sessionId: string): Promise<Viewer> {
	const attached = await attach(host.path, sessionId, ROWS, COLUMNS);
	opened.push({ close: () => attached.leave() });
	return attached;
}
