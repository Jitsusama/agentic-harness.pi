/**
 * A quit typed in one viewer of a hosted conversation, on pi's own screen.
 * On 11 November a check attached under script(1) with its input from
 * /dev/null: script typed Ctrl+D as that input ended, pi's quit closed the
 * conversation for everyone, and the host wrote nothing. Here a viewer
 * whose input ends leaves the conversation running. A lone viewer keeps
 * pi's quit keys, as plain pi does. With others watching, a quit holds only
 * once the viewer that typed it says y, and anything else lets that viewer
 * go. Every end is a line in the host's journal naming who asked. The
 * host reads Joel's own Ctrl+D bindings, quit and delete forward, so a
 * Ctrl+D typed into words he is writing deletes and never quits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { type Folders, folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";
import { attach, type Viewer } from "./support/viewer.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());

/** How long a turn, a close or a frame may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long one case may take, opening its conversation included. */
const CASE_MS = 60_000;
const ENTER = "\r";
const CTRL_D = "\x04";
const CTRL_C = "\x03";
/** Ctrl+D as Joel's kitty sends it, under the keyboard protocol pi asks for. */
const KITTY_CTRL_D = "\u001b[100;5u";
const LEFT = "\u001b[D";
/** Joel's own bindings for Ctrl+D, from his keybindings.json: it quits, and deletes forward. */
const JOELS_CTRL_D = {
	"app.exit": ["ctrl+d"],
	"tui.editor.deleteCharForward": ["ctrl+d", "delete"],
};
const ROWS = 30;
const COLUMNS = 160;
const QUESTION = /Close this conversation for everyone\?/;
/** What a viewer that typed a quit and didn't confirm it is told as it goes. */
const LEFT_RUNNING =
	"Left the conversation running; open it again from the launcher";

let sealed: Seal;
let host: ScreenHost;
let work: Folders;
const viewers: Viewer[] = [];

/** A viewer of `sessionId`, left at the end of the file if a case doesn't. */
async function viewer(sessionId: string, window?: string): Promise<Viewer> {
	const on = await attach(
		host.path,
		sessionId,
		ROWS,
		COLUMNS,
		window ? { window } : {},
	);
	viewers.push(on);
	return on;
}

/** The journal line the host writes as `sessionId` ends. */
function ended(sessionId: string): string {
	return `${sessionAddress(sessionId)} (${sessionId}) ended: `;
}

/** What the host wrote, for a failure to say. */
function said(): string {
	return `; the host said: ${host.errors()}`;
}

describe.skipIf(!packageDir)(
	"a quit typed in a hosted viewer (needs a pi with the host's patches: pnpm test:host)",
	() => {
		beforeAll(async () => {
			if (!packageDir) return;
			sealed = await seal();
			work = folders(sealed);
			const agent = join(sealed.home, ".pi", "agent");
			mkdirSync(agent, { recursive: true });
			writeFileSync(
				join(agent, "keybindings.json"),
				JSON.stringify(JOELS_CTRL_D),
			);
			host = await startScreenHost(sealed, packageDir);
		}, CASE_MS);
		afterAll(async () => {
			for (const on of viewers) await on.leave().catch(() => {});
			await host?.stop();
			await sealed?.dispose();
		}, CASE_MS);

		it(
			"keeps the conversation when the only viewer's input ends",
			async () => {
				const { sessionId } = await host.open(work.trusted(), "first words");
				const alone = await viewer(sessionId);
				await alone.shows("heard: first words", TURN_MS);

				await alone.leave();

				await host.idle(sessionId, TURN_MS);
				const back = await viewer(sessionId);
				back.type(`after the window${ENTER}`);
				await back.shows("heard: after the window", TURN_MS);
				expect(host.errors(), `nothing ended it${said()}`).not.toContain(
					ended(sessionId),
				);
			},
			CASE_MS,
		);

		it.each([
			["in kitty's encoding", KITTY_CTRL_D],
			["as a control byte", CTRL_D],
		])(
			"deletes forward at Ctrl+D %s while the editor holds words, and never quits, as plain pi does",
			async (named, ctrlD) => {
				const { sessionId } = await host.open(
					work.trusted(),
					`typing ${named}`,
				);
				const alone = await viewer(sessionId);
				await alone.shows(`heard: typing ${named}`, TURN_MS);

				alone.type("abcd");
				await alone.shows("abcd", TURN_MS);
				alone.type(ctrlD);
				alone.type(`${LEFT}${LEFT}`);
				alone.type(ctrlD);
				alone.type(ENTER);

				await alone.shows("heard: abd", TURN_MS);
				await host.idle(sessionId, TURN_MS);
				expect(alone.screen().join("\n"), "it never asked").not.toMatch(
					QUESTION,
				);
				expect(host.errors(), `nothing ended it${said()}`).not.toContain(
					ended(sessionId),
				);
			},
			CASE_MS,
		);

		it.each([
			["Ctrl+D", CTRL_D],
			["Ctrl+D in kitty's encoding", KITTY_CTRL_D],
			["/quit", `/quit${ENTER}`],
			["Ctrl+C twice", `${CTRL_C}${CTRL_C}`],
		])(
			"closes at %s from a lone viewer with no question, as plain pi does, journalling that viewer",
			async (named, quit) => {
				const { sessionId } = await host.open(work.trusted(), `alone ${named}`);
				const alone = await viewer(sessionId, "w-1");
				await alone.shows(`heard: alone ${named}`, TURN_MS);

				alone.type(quit);

				await host.gone(sessionId, TURN_MS);
				expect(await alone.detached, "its window is told it closed").toBe(
					"Conversation closed",
				);
				expect(alone.screen().join("\n"), "it never asked").not.toMatch(
					QUESTION,
				);
				expect(host.errors(), "the journal says who asked").toMatch(
					new RegExp(
						`${ended(sessionId).replace(/[()]/g, "\\$&")}quit, asked by viewer 1 in window w-1, joined \\d{4}-`,
					),
				);
			},
			CASE_MS,
		);

		it(
			"asks only the viewer that typed a quit, and lets only it go when it says anything but y",
			async () => {
				const { sessionId } = await host.open(work.trusted(), "two watching");
				const typing = await viewer(sessionId);
				const watching = await viewer(sessionId);
				await typing.shows("heard: two watching", TURN_MS);
				await watching.shows("heard: two watching", TURN_MS);

				typing.type(CTRL_D);
				await typing.shows(QUESTION, TURN_MS);
				await typing.shows("1 other viewer is watching.", TURN_MS);
				expect(
					watching.screen().join("\n"),
					"the other viewer isn't asked",
				).not.toMatch(QUESTION);
				typing.type("n");

				expect(await typing.detached, "that viewer is let go").toBe(
					LEFT_RUNNING,
				);
				watching.type(`still here${ENTER}`);
				await watching.shows("heard: still here", TURN_MS);
				await host.idle(sessionId, TURN_MS);
			},
			CASE_MS,
		);

		it.each([
			["/quit", `/quit${ENTER}`],
			["Ctrl+C twice", `${CTRL_C}${CTRL_C}`],
		])(
			"asks before %s closes it with another viewer watching, as pi quits within the key",
			async (_named, quit) => {
				const { sessionId } = await host.open(work.trusted(), "other quits");
				const typing = await viewer(sessionId);
				const watching = await viewer(sessionId);
				await typing.shows("heard: other quits", TURN_MS);

				typing.type(quit);
				await typing.shows(QUESTION, TURN_MS);
				typing.type("n");

				expect(await typing.detached, "that viewer is let go").toBe(
					LEFT_RUNNING,
				);
				watching.type(`still watching${ENTER}`);
				await watching.shows("heard: still watching", TURN_MS);
				await host.idle(sessionId, TURN_MS);
				expect(
					(await host.list()).map((one) => one.sessionId),
					`it is still held${said()}`,
				).toContain(sessionId);
			},
			CASE_MS,
		);

		it(
			"closes for everyone once the viewer that typed the quit says y, journalling that viewer",
			async () => {
				const { sessionId } = await host.open(work.trusted(), "closing");
				const typing = await viewer(sessionId, "w-7");
				const watching = await viewer(sessionId);
				await typing.shows("heard: closing", TURN_MS);

				typing.type(CTRL_D);
				await typing.shows(QUESTION, TURN_MS);
				typing.type("y");

				await host.gone(sessionId, TURN_MS);
				expect(await watching.detached, "everyone is let go").toBe(
					"Conversation closed",
				);
				expect(host.errors(), "the journal says who asked").toMatch(
					new RegExp(
						`${ended(sessionId).replace(/[()]/g, "\\$&")}quit, asked by viewer 1 in window w-7, joined \\d{4}-`,
					),
				);
			},
			CASE_MS,
		);

		it(
			"tells a viewer its conversation was released, not closed, and journals who released it",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				await host.idle(sessionId, TURN_MS);
				const watching = await viewer(sessionId);
				await watching.shows(/\S/, TURN_MS);

				await host.release(sessionId, "the cutover");

				expect(await watching.detached, "its window can start plain pi").toBe(
					"Conversation released",
				);
				await host.gone(sessionId, TURN_MS);
				expect(host.errors(), "the journal names the caller").toContain(
					`${ended(sessionId)}released, asked by the cutover over the control socket`,
				);
			},
			CASE_MS,
		);

		it(
			"journals a close over the control socket by the caller it names",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				await host.idle(sessionId, TURN_MS);

				await host.close(sessionId, "the launcher");

				await host.gone(sessionId, TURN_MS);
				expect(host.errors(), "the journal names the caller").toContain(
					`${ended(sessionId)}closed, asked by the launcher over the control socket`,
				);
			},
			CASE_MS,
		);
	},
);
