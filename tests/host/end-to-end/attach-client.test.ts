/**
 * mycelium's attach client in a real terminal, end to end: the program
 * Joel's kitty window runs, under a pseudo-terminal with an interactive
 * shell, joined to a conversation of a sealed host composed as the host
 * program composes it. What its screen shows is read through a terminal
 * emulator, and its Ctrl+G and Ctrl+Z run through its own tty: a scripted
 * editor in that terminal, and bash's own job control. Only kitty itself
 * is left out. Skipped without PI_HOST_PACKAGE_DIR (a pi with the host's
 * patches), MYCELIUM_BIN (a mycelium with mycelium#112's client) and
 * script(1); tests/host/end-to-end/README.md gives the command.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Folders, folders } from "./support/folders.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { SEALED_REALM, type Seal, seal } from "./support/seal.ts";
import { AT_PROMPT, openTty, type Tty } from "./support/tty.ts";
import { attach, type Viewer } from "./support/viewer.ts";

const packageDir = process.env.PI_HOST_PACKAGE_DIR;
const mycelium = process.env.MYCELIUM_BIN;
const hasScript = spawnSync("script", ["--version"]).status === 0;
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

describe.skipIf(!(packageDir && mycelium && hasScript))(
	"mycelium's attach client in a terminal of its own (needs PI_HOST_PACKAGE_DIR, MYCELIUM_BIN and script(1))",
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

/** A window with a shell, which joins `sessionId` as the launcher's Go To does. */
async function joined(sessionId: string): Promise<Tty> {
	if (!mycelium || !existsSync(mycelium))
		throw new Error(`MYCELIUM_BIN names no mycelium: ${mycelium}`);
	const window = await openTty(sealed, {
		mycelium,
		editor,
		rows: ROWS,
		columns: COLUMNS,
	});
	opened.push(window);
	window.type(
		`mycelium --realm ${SEALED_REALM} attach --host ${SEALED_REALM}-attended --session ${sessionId}${ENTER}`,
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
