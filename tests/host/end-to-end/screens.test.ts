/**
 * Hosted conversations on pi's own screen, end to end: a sealed host
 * process composing hostScreens, createEngine and serveHost as the host
 * program does, on a pi built with the host's patches and its scripted
 * provider, with viewers attached through the socket as mycelium's client
 * attaches and their screens read through a terminal emulator. Each case
 * is one a person relies on at pi's own screen. Runs on the host's pi as
 * support/host-pi.ts finds it; an ordinary run without one skips it, and
 * `pnpm test:host` fails instead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Folders, folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";
import { type Abilities, attach, type Viewer } from "./support/viewer.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());
/** A conversation's turn on the scripted provider, with pi's whole screen drawing it. */
const TURN_MS = 20_000;
/** A case: a few turns and viewers coming and going. */
const CASE_MS = 60_000;
const ENTER = "\r";
/** A one-pixel PNG, for a tool to read. */
const PICTURE =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** Kitty's graphics protocol sending an image's data, not only placing it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: kitty's graphics commands open with ESC.
const IMAGE_DATA = /\u001b_Ga=T[^;]*;[A-Za-z0-9+/=]+/;
/** Joel's chords, as kitty's keyboard protocol sends them. */
const CTRL_G = "\u001b[103;5u";
const CTRL_V = "\u001b[118;5u";
const CTRL_X = "\u001b[120;5u";
const CTRL_Z = "\u001b[122;5u";
/** What mycelium's attach client says it can do. */
const CLIENT = ["edit", "suspend"];
const DOWN = "\u001b[B";
/** What pi's selector puts before the label Enter picks. */
const MARK = "\u2192 ";
/** More Down presses than pi's trust question has labels. */
const MAX_PRESSES = 8;
/** pi's question at the start of a conversation in a folder it hasn't trusted. */
const TRUST_QUESTION = "Trust project folder?";
/** What a folder's own extension writes in it as it loads. */
const LOADED = "extension-loaded";
/** First words a folder's extension asks about before they go on. */
const ASK_ME = "ask me first";
const GO_ON = "Go on?";
/** First words a folder's extension shows its own component about, and what it shows. */
const SHOW_ME = "show me a panel";
const PANEL = "A panel of its own: press any key";

/**
 * What the pi under test lacks of a hook, read from its own built source:
 * which build to point at instead, or nothing when it has it.
 */
function lacks(file: string, hook: string, since: string): string | undefined {
	if (!packageDir) return undefined;
	const path = join(packageDir, file);
	if (existsSync(path) && readFileSync(path, "utf8").includes(hook))
		return undefined;
	return `The pi at ${packageDir} has no ${hook}: point PI_HOST_PACKAGE_DIR at a piHostRuntime built from ${since} or later`;
}
/** A pi from before core.nix#2782 can't resend a late viewer its images. */
const NO_LATE_IMAGES = lacks(
	"node_modules/@earendil-works/pi-tui/dist/tui.js",
	"repaintForNewTerminal",
	"core.nix#2782",
);
/** Nor hand its host an edit or a suspend. */
const NO_HANDOFF = lacks(
	"dist/modes/interactive/interactive-mode.js",
	"editText",
	"core.nix#2782",
);

/** Nor say an extension's own component waits on the person. */
const NO_PANEL_STATUS = lacks(
	"dist/modes/interactive/interactive-mode.js",
	"An extension is asking",
	"core.nix#2853",
);

/** Skip a case its pi can't run, saying which can, or fail it under `pnpm test:host`. */
function needs(lacking: string | undefined, skip: (note: string) => never) {
	if (!lacking) return;
	if (process.env[HOST_PI_REQUIRED]) throw new Error(lacking);
	skip(lacking);
}

let sealed: Seal;
let host: ScreenHost;
const viewers: Viewer[] = [];
let work: Folders;

describe.skipIf(!packageDir)(
	"a hosted conversation on pi's own screen (needs a pi with the host's patches: pnpm test:host)",
	() => {
		beforeAll(async () => {
			if (!packageDir) return;
			sealed = await seal();
			work = folders(sealed);
			host = await startScreenHost(sealed, packageDir);
		}, CASE_MS);
		afterAll(async () => {
			for (const viewer of viewers) await viewer.leave().catch(() => {});
			await host?.stop();
			await sealed?.dispose();
		}, CASE_MS);

		it(
			"runs before anyone watches, and a viewer joining later sees what it did",
			async () => {
				const { sessionId } = await host.open(folder(), "before anyone");
				await host.idle(sessionId, TURN_MS);

				const late = await viewer(sessionId, 30, 100);

				await late.shows("heard: before anyone");
				expect(
					late.terminal.buffer.active.type,
					"pi's screen is the alternate one",
				).toBe("alternate");
			},
			CASE_MS,
		);

		it(
			"shares one screen and its input between two viewers",
			async () => {
				const { sessionId } = await host.open(folder());
				const one = await viewer(sessionId, 30, 100);
				const two = await viewer(sessionId, 30, 100);

				one.type(`from one${ENTER}`);
				await Promise.all([
					one.shows("heard: from one"),
					two.shows("heard: from one"),
				]);
				two.type(`from two${ENTER}`);

				await Promise.all([
					one.shows("heard: from two"),
					two.shows("heard: from two"),
				]);
			},
			CASE_MS,
		);

		it(
			"draws at the narrowest viewer's width, and wider once it leaves",
			async () => {
				const { sessionId } = await host.open(folder());
				const wide = await viewer(sessionId, 30, 100);
				await wide.shows(rule(100));

				const narrow = await viewer(sessionId, 24, 70);
				await Promise.all([wide.shows(rule(70)), narrow.shows(rule(70))]);
				expect(
					widestRule(wide),
					"nothing is drawn past the narrow viewer",
				).toBe(70);

				await narrow.leave();
				await wide.shows(rule(100));
			},
			CASE_MS,
		);

		it(
			"redraws at a viewer's new size when its window is resized",
			async () => {
				const { sessionId } = await host.open(folder());
				const resized = await viewer(sessionId, 30, 100);
				await resized.shows(rule(100));

				resized.resize(20, 60);

				await resized.shows(rule(60));
				expect(widestRule(resized)).toBe(60);
			},
			CASE_MS,
		);

		it(
			"keeps running when a viewer's window closes, for the next to see",
			async () => {
				const { sessionId } = await host.open(folder());
				const first = await viewer(sessionId, 30, 100);
				first.type(`still here${ENTER}`);
				await first.shows("heard: still here");

				await first.leave();
				const held = (await host.list()).find((s) => s.sessionId === sessionId);
				expect(held?.state, "closing the window only detaches").toBe("idle");
				const next = await viewer(sessionId, 30, 100);

				await next.shows("heard: still here");
			},
			CASE_MS,
		);

		it(
			"gives a viewer that joins late the screen's modes before its first repaint",
			async () => {
				const { sessionId } = await host.open(folder());
				await viewer(sessionId, 30, 100);

				const late = await viewer(sessionId, 30, 100);
				await late.shows(rule(100));

				const first = late.output[0] ?? "";
				expect(first, "the alternate screen").toContain("\u001b[?1049h");
				expect(first, "kitty's key flags").toContain("\u001b[>7u");
				expect(late.terminal.modes.bracketedPasteMode, "bracketed paste").toBe(
					true,
				);
			},
			CASE_MS,
		);

		it(
			"keeps a panel waiting with nobody watching, for a viewer to answer later",
			async () => {
				const picked = join(sealed.home, "picked");
				const { sessionId } = await host.open(folder());
				const asking = await viewer(sessionId, 30, 100);
				asking.type(`/pick${ENTER}`);
				await asking.shows("Pick one");

				await asking.leave();
				const held = (await host.list()).find((s) => s.sessionId === sessionId);
				expect(held, "the panel outlives its viewer").toBeDefined();
				const late = await viewer(sessionId, 30, 100);
				await late.shows("Pick one");
				expect(
					existsSync(picked),
					"nothing is picked before anyone answers",
				).toBe(false);

				late.type("\u001b[B");
				late.type(ENTER);

				await host.idle(sessionId, TURN_MS);
				await late.shows(/^(?!.*Pick one)/s);
				expect(readFileSync(picked, "utf8")).toBe("beta\n");
			},
			CASE_MS,
		);

		it(
			"ends only its own conversation when quit from its screen",
			async () => {
				const quitting = await host.open(folder());
				const sibling = await host.open(folder());
				const watching = await viewer(quitting.sessionId, 30, 100);
				const other = await viewer(sibling.sessionId, 30, 100);
				await watching.shows(rule(100));

				watching.type(`/quit${ENTER}`);

				expect(await watching.detached).toBe("Conversation closed");
				await host.gone(quitting.sessionId, TURN_MS);
				const held = (await host.list()).map((s) => s.sessionId);
				expect(held).toContain(sibling.sessionId);
				other.type(`after the quit${ENTER}`);
				await other.shows("heard: after the quit");
			},
			CASE_MS,
		);

		it(
			"takes a bracketed paste of several lines as one message",
			async () => {
				const { sessionId } = await host.open(folder());
				const pasting = await viewer(sessionId, 30, 100);
				await pasting.shows(rule(100));

				pasting.type("\u001b[200~first line\nsecond line\u001b[201~");
				pasting.type(ENTER);

				await pasting.shows(/heard: first line\s*\n\s*second line/);
			},
			CASE_MS,
		);

		it(
			"shows an image a tool read, in kitty's graphics protocol",
			async () => {
				const cwd = folder();
				writeFileSync(join(cwd, "picture.png"), Buffer.from(PICTURE, "base64"));
				const watching = await viewer(
					(await host.open(cwd)).sessionId,
					30,
					100,
				);

				watching.type(`show me a picture${ENTER}`);

				await watching.sent(IMAGE_DATA, TURN_MS);
			},
			CASE_MS,
		);

		it(
			"gives a viewer that joins late the images already on the screen (needs core.nix#2782's pi)",
			async ({ skip }) => {
				needs(NO_LATE_IMAGES, skip);
				const cwd = folder();
				writeFileSync(join(cwd, "picture.png"), Buffer.from(PICTURE, "base64"));
				const { sessionId } = await host.open(cwd);
				const first = await viewer(sessionId, 30, 100);
				first.type(`show me a picture${ENTER}`);
				await first.sent(IMAGE_DATA, TURN_MS);
				await host.idle(sessionId, TURN_MS);

				const late = await viewer(sessionId, 30, 100);

				await late.sent(IMAGE_DATA);
			},
			CASE_MS,
		);

		it(
			"edits a draft in the external editor of the viewer that pressed Ctrl+G (needs core.nix#2782's pi)",
			async ({ skip }) => {
				needs(NO_HANDOFF, skip);
				const { sessionId } = await host.open(folder());
				const editing = await viewer(sessionId, 30, 100, {
					features: CLIENT,
					editor: (draft) => `${draft} and more`,
				});
				const other = await viewer(sessionId, 30, 100);
				editing.type("a draft");
				await other.shows("a draft");

				editing.type(CTRL_G);

				await other.shows("a draft and more");
				expect(editing.edits).toEqual(["a draft"]);
				await editing.shows("a draft and more");
				editing.type(ENTER);
				await other.shows("heard: a draft and more");
			},
			CASE_MS,
		);

		it(
			"suspends only the viewer that pressed Ctrl+Z, which comes back to the same screen (needs core.nix#2782's pi)",
			async ({ skip }) => {
				needs(NO_HANDOFF, skip);
				const { sessionId } = await host.open(folder());
				const stopping = await viewer(sessionId, 30, 100, { features: CLIENT });
				const other = await viewer(sessionId, 30, 100);
				await stopping.shows(rule(100));

				stopping.type(CTRL_Z);

				await stopping.suspended;
				await stopping.detached;
				other.type(`while it was away${ENTER}`);
				await other.shows("heard: while it was away");
				expect((await host.list()).map((s) => s.sessionId)).toContain(
					sessionId,
				);
				// What the client does at fg: attach again.
				const back = await viewer(sessionId, 30, 100, { features: CLIENT });
				await back.shows("heard: while it was away");
				expect(back.terminal.buffer.active.type).toBe("alternate");
			},
			CASE_MS,
		);

		it(
			"copies the last answer to the clipboard of the viewer that pressed Ctrl+X",
			async () => {
				const { sessionId } = await host.open(folder());
				const copying = await viewer(sessionId, 30, 100);
				copying.type(`to copy${ENTER}`);
				await copying.shows("heard: to copy");

				copying.type(CTRL_X);

				const copied = Buffer.from("heard: to copy").toString("base64");
				await copying.sent(`\u001b]52;c;${copied}`);
			},
			CASE_MS,
		);

		it(
			"pastes an image from the session's Wayland clipboard on Ctrl+V",
			async () => {
				const { sessionId } = await host.open(folder());
				// Wide enough that the pasted file's path stays on one row.
				const pasting = await viewer(sessionId, 30, 300);
				await pasting.shows(rule(300));

				pasting.type(CTRL_V);

				const pasted = /\S*pi-clipboard-[0-9a-f-]+\.png/;
				await pasting.shows(pasted);
				const [path = ""] = pasted.exec(pasting.screen().join("\n")) ?? [];
				expect(
					readFileSync(path).toString("base64"),
					"the picture the session's clipboard held",
				).toBe(PICTURE);
			},
			CASE_MS,
		);

		it(
			"reads keys sent in kitty's keyboard protocol",
			async () => {
				const { sessionId } = await host.open(folder());
				const keyed = await viewer(sessionId, 30, 100);
				await keyed.shows(rule(100));

				// Shift+Enter breaks the line; Enter, in kitty's encoding, sends it.
				keyed.type("upper\u001b[13;2ulower\u001b[13u");

				await keyed.shows(/heard: upper\s*\n\s*lower/);
			},
			CASE_MS,
		);

		it(
			"reads keys as from a terminal it knows speaks kitty's protocol",
			async () => {
				const keyed = await viewer(
					(await host.open(folder())).sessionId,
					30,
					100,
				);

				// pi takes a line feed for Shift+Enter only once it knows the
				// terminal speaks kitty's protocol; otherwise it sends the line.
				for (const key of ["first", "\n", "second", ENTER]) keyed.type(key);

				await keyed.shows(/heard: first\s*\n\s*second/);
			},
			CASE_MS,
		);

		it(
			"asks whether to trust a folder with its own extensions, and a yes loads them before the first words go in",
			async () => {
				const cwd = extended();
				const { sessionId } = await host.open(cwd, "once trusted");
				const asked = await viewer(sessionId, 30, 100);
				await asked.shows(TRUST_QUESTION);
				await asked.shows(chosen("Trust"));

				asked.type(ENTER);

				await asked.shows("heard: once trusted", TURN_MS);
				expect(loaded(cwd), "the folder's extension loaded").toBe(true);
				expect(trustStore()[cwd], "pi's trust store keeps the yes").toBe(true);
			},
			CASE_MS,
		);

		it(
			"leaves a folder's extensions out when the answer is not to trust it, and the conversation runs on",
			async () => {
				const cwd = extended();
				const { sessionId } = await host.open(cwd);
				const asked = await viewer(sessionId, 30, 100);
				await asked.shows(TRUST_QUESTION);

				await pick(asked, "Do not trust");
				asked.type(ENTER);

				await asked.shows("This project is not trusted");
				asked.type(`untrusted${ENTER}`);
				await asked.shows("heard: untrusted", TURN_MS);
				expect(loaded(cwd), "the folder's extension stayed out").toBe(false);
				expect(trustStore()[cwd], "pi's trust store keeps the no").toBe(false);
			},
			CASE_MS,
		);

		it(
			"keeps asking when the viewer asked leaves, for the next viewer to answer",
			async () => {
				const cwd = extended();
				const { sessionId } = await host.open(cwd, "answered later");
				const first = await viewer(sessionId, 30, 100);
				await first.shows(TRUST_QUESTION);

				await first.leave();
				const next = await viewer(sessionId, 30, 100);

				await next.shows(TRUST_QUESTION);
				next.type(ENTER);
				await next.shows("heard: answered later", TURN_MS);
				expect(loaded(cwd), "the folder's extension loaded").toBe(true);
			},
			CASE_MS,
		);

		it(
			"leaves a folder untrusted and loads nothing of it when its conversation closes mid-question",
			async () => {
				const cwd = extended();
				const { sessionId } = await host.open(cwd, "never said");
				const asked = await viewer(sessionId, 30, 100);
				await asked.shows(TRUST_QUESTION);

				await host.close(sessionId);

				await asked.detached;
				await host.gone(sessionId, TURN_MS);
				expect(loaded(cwd), "the folder's extension stayed out").toBe(false);
				expect(
					trustStore()[cwd],
					"pi's trust store keeps no answer nobody gave",
				).toBeUndefined();
			},
			CASE_MS,
		);

		it(
			"answers an open whose extension asks before the first words go on, so a viewer can reply",
			async () => {
				const { sessionId } = await host.open(askingFirst(), ASK_ME);
				const asked = await viewer(sessionId, 30, 100);
				await asked.shows(GO_ON);
				await asked.shows(chosen("Yes"));

				asked.type(ENTER);

				await asked.shows(`heard: ${ASK_ME}`, TURN_MS);
			},
			CASE_MS,
		);

		it(
			"keeps first words an extension's question turned away from the model",
			async () => {
				const { sessionId } = await host.open(askingFirst(), ASK_ME);
				const asked = await viewer(sessionId, 30, 100);
				await asked.shows(GO_ON);

				await pick(asked, "No");
				asked.type(ENTER);

				// Typed into the selector, these would never reach the model.
				asked.type(`went on${ENTER}`);
				await asked.shows("heard: went on", TURN_MS);
				expect(
					asked.screen().join("\n"),
					"the words turned away were never sent",
				).not.toContain(`heard: ${ASK_ME}`);
			},
			CASE_MS,
		);

		for (const overlay of [true, false])
			it(
				`answers an open whose extension shows its own component${overlay ? " over the screen" : " in the editor's place"} before the first words go on (needs core.nix#2853's pi)`,
				async ({ skip }) => {
					needs(NO_PANEL_STATUS, skip);
					const { sessionId } = await host.open(panelFirst(overlay), SHOW_ME);
					const shown = await viewer(sessionId, 30, 100);
					await shown.shows(PANEL);

					shown.type(ENTER);

					await shown.shows(`heard: ${SHOW_ME}`, TURN_MS);
				},
				CASE_MS,
			);
	},
);

/** A fresh working folder for one conversation, which opens without asking to be trusted. */
function folder(): string {
	return work.trusted();
}

/**
 * A fresh working folder with an extension of its own, which pi loads
 * only from a folder it trusts, and which says it loaded in the folder.
 */
function extended(): string {
	const cwd = work.untrusted();
	return withExtension(
		cwd,
		"says-it-loaded.ts",
		`import { writeFileSync } from "node:fs";
export default function () {
	writeFileSync(${JSON.stringify(join(cwd, LOADED))}, "loaded\\n");
}
`,
	);
}

/**
 * A fresh trusted folder whose own extension asks the person before first
 * words of ASK_ME go on, as an extension's input handler may, and turns
 * them away on a no.
 */
function askingFirst(): string {
	return withExtension(
		work.trusted(),
		"asks-first.ts",
		`export default function (pi) {
	pi.on("input", async (event, ctx) => {
		if (event.text !== ${JSON.stringify(ASK_ME)}) return { action: "continue" };
		const answer = await ctx.ui.select(${JSON.stringify(GO_ON)}, ["Yes", "No"]);
		return { action: answer === "Yes" ? "continue" : "handled" };
	});
}
`,
	);
}

/**
 * A fresh trusted folder whose own extension shows a component of its
 * own before first words of SHOW_ME go on, over the screen as every
 * harness panel is or in the editor's place, and lets them on once any
 * key answers it.
 */
function panelFirst(overlay: boolean): string {
	return withExtension(
		work.trusted(),
		"panel-first.ts",
		`export default function (pi) {
	pi.on("input", async (event, ctx) => {
		if (event.text !== ${JSON.stringify(SHOW_ME)}) return { action: "continue" };
		await ctx.ui.custom(
			(_tui, _theme, _keys, done) => ({
				render: () => [${JSON.stringify(PANEL)}],
				invalidate: () => undefined,
				handleInput: () => done("seen"),
			}),
			{ overlay: ${overlay} },
		);
		return { action: "continue" };
	});
}
`,
	);
}

/** `cwd`, given an extension of its own named `name`. */
function withExtension(cwd: string, name: string, source: string): string {
	const extensions = join(cwd, ".pi", "extensions");
	mkdirSync(extensions, { recursive: true });
	writeFileSync(join(extensions, name), source);
	return cwd;
}

/** Whether the folder's own extension loaded. */
function loaded(cwd: string): boolean {
	return existsSync(join(cwd, LOADED));
}

/** What pi's trust store holds, by folder, as the host writes each answer. */
function trustStore(): Record<string, unknown> {
	return work.store();
}

/** The row pi's selector marks as the one Enter picks. */
function chosen(label: string): RegExp {
	return new RegExp(`${MARK}${literally(label)} *$`, "m");
}

/** Move a selector's mark down to `label`, as a person presses Down. */
async function pick(on: Viewer, label: string): Promise<void> {
	for (let presses = 0; presses < MAX_PRESSES; presses++) {
		const marked = markedOn(on);
		if (marked === label) return;
		on.type(DOWN);
		// Each press moves the mark before the next is judged.
		await on.shows(
			new RegExp(`${MARK}(?!${literally(marked ?? "")} *$)\\S`, "m"),
		);
	}
	await on.shows(chosen(label));
}

/** The label pi's selector marks on a viewer's screen. */
function markedOn(on: Viewer): string | undefined {
	const row = on.screen().find((line) => line.includes(MARK));
	return row?.slice(row.indexOf(MARK) + MARK.length).trimEnd();
}

/** `text` matched as it is written, in a regular expression. */
function literally(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function viewer(
	sessionId: string,
	rows: number,
	columns: number,
	abilities?: Abilities,
): Promise<Viewer> {
	const attached = await attach(host.path, sessionId, rows, columns, abilities);
	viewers.push(attached);
	return attached;
}

/** A horizontal rule `columns` wide, alone on its row, as pi draws round its editor. */
function rule(columns: number): RegExp {
	return new RegExp(`^─{${columns}}$`, "m");
}

/** The widest rule on a viewer's screen. */
function widestRule(viewer: Viewer): number {
	return Math.max(
		0,
		...viewer.screen().map((row) => (/^─+$/.test(row) ? row.length : 0)),
	);
}
