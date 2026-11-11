/**
 * A quit typed in one viewer of a hosted conversation, on pi's own screen.
 * On 11 November a check attached under script(1) with its input from
 * /dev/null: script typed Ctrl+D as that input ended, pi's quit closed the
 * conversation for everyone, and the host wrote nothing. Here a quit holds
 * only once the viewer that typed it says y, anything else lets that
 * viewer go, a viewer whose input ends leaves the conversation running, and
 * every end is a line in the host's journal naming who asked.
 */
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
			host = await startScreenHost(sealed, packageDir);
		}, CASE_MS);
		afterAll(async () => {
			for (const on of viewers) await on.leave().catch(() => {});
			await host?.stop();
			await sealed?.dispose();
		}, CASE_MS);

		it(
			"keeps the conversation when the only viewer's input ends, as script(1) ends it",
			async () => {
				const { sessionId } = await host.open(work.trusted(), "first words");
				const alone = await viewer(sessionId);
				await alone.shows("heard: first words", TURN_MS);

				// script(1) types Ctrl+D as its input ends, then closes the window.
				alone.type(CTRL_D);
				await alone.shows(QUESTION, TURN_MS);
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
