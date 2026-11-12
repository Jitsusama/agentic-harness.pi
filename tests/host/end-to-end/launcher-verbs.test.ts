/**
 * E20: the launcher's Stop and Close on hosted rows, where E8 leaves
 * them unproved. Both reach a conversation as steers written into its
 * inbox, which mesh-workflow's pausing.ts turns into an abort and a
 * close inside it (core #2827).
 *
 * A Stop with both conversations mid-turn cuts only the one it names:
 * E8's neighbour sits idle, so an abort reaching the wrong conversation
 * would go unseen there. Here the neighbour runs a tool that ends by
 * itself, still running when the Stop lands, and its turn runs to its
 * own end.
 *
 * A Close with a viewer attached, as Joel's window is, on pi's own
 * screen: the viewer is told the conversation closed and let go, the
 * host keeps no screen or session of it and refuses a new attach, and
 * its other conversation still answers its viewer.
 *
 * The steers are written as the launcher writes them, so this needs no
 * mycelium node. Runs on the host's pi, as support/host-pi.ts finds it,
 * skipped saying why without one.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CLOSED } from "../../../lib/core/viewer/terminal.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folders } from "./support/folders.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	steerInbox,
	textOf,
	toolAnswer,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import {
	DAWDLE,
	DAWDLING,
	SCRIPTED,
	WAIT_A_WHILE,
	WAITED,
	WAITING,
} from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import { attach, type Viewer } from "./support/viewer.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
/** A conversation's turn on the scripted provider, with pi's whole screen drawing it. */
const TURN_MS = 20_000;
const ENTER = "\r";
const ROWS = 30;
const COLUMNS = 100;

let sealed: Seal;
let host: HostProcess | undefined;
let screens: ScreenHost | undefined;
const viewers: Viewer[] = [];
beforeEach(async () => {
	sealed = await seal();
});
afterEach(async () => {
	for (const viewer of viewers.splice(0))
		await viewer.leave().catch(() => {
			// A viewer the host already let go has nothing left to leave.
		});
	await host?.kill();
	await screens?.stop();
	host = undefined;
	screens = undefined;
	await sealed.dispose();
});

/** What the host wrote, for a failure. */
function said(): string {
	return `The host wrote:\n${host?.errors() ?? screens?.errors()}`;
}

/** The addresses the conversation `sessionId` signed in to the mesh by. */
function addressesOf(sessionId: string): readonly string[] {
	const presences = createPresences(
		join(
			sealed.env.XDG_STATE_HOME ?? "",
			"pi",
			"agentic-harness.pi",
			"mesh-workflow",
			"presence",
		),
	);
	return presences.of(sessionId)?.addresses ?? [];
}

/** A viewer attached to `sessionId` on the screen host, left at the end. */
async function viewing(on: ScreenHost, sessionId: string): Promise<Viewer> {
	const viewer = await attach(on.path, sessionId, ROWS, COLUMNS);
	viewers.push(viewer);
	return viewer;
}

it(
	"E20: a Stop cuts only its own conversation's turn while its neighbour's runs on",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			for (const folder of ["a", "b"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const a = await host.open(join(sealed.home, "a"), {
				model: SCRIPTED,
				first: DAWDLE,
			});
			const b = await host.open(join(sealed.home, "b"), {
				model: SCRIPTED,
				first: WAIT_A_WHILE,
			});
			const files = () => `\na: ${textOf(a.file)}\nb: ${textOf(b.file)}`;

			await untilAnswered(
				"both conversations are busy in their tools",
				async () =>
					textOf(a.file).includes(DAWDLING) &&
					textOf(b.file).includes(WAITING),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}${files()}`);
			});

			await steerInbox(sealed, sessionAddress(a.sessionId), "", "stop");
			await untilAnswered(
				"the Stop cuts the first's tool short",
				async () => toolAnswer(a.file, "bash") !== undefined,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}${files()}`);
			});
			expect(toolAnswer(a.file, "bash")).toMatch(/Command aborted/);
			expect(
				toolAnswer(b.file, "bash"),
				"its neighbour's tool was still running when the Stop landed",
			).toBeUndefined();

			await untilAnswered(
				"the neighbour's turn runs to its own end",
				async () => turnEnded(b.file),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}${files()}`);
			});
			expect(toolAnswer(b.file, "bash")).toContain(WAITED);
			expect(toolAnswer(b.file, "bash")).not.toMatch(/aborted/);
			expect(
				(await host.list()).map((one) => one.sessionId),
				"the host holds both",
			).toEqual(expect.arrayContaining([a.sessionId, b.sessionId]));
		});
	},
	// A host's start, two opens, the neighbour's 20 s tool, and room for load.
	ROUND_TRIP_MS * 2,
);

it(
	"E20: a Close lets its viewer go, leaves no screen of it, and keeps the host's other",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const started = await startScreenHost(sealed, pi, ["mesh-workflow"]);
			screens = started;
			const work = folders(sealed);
			const a = await started.open(work.trusted(), "first words");
			const b = await started.open(work.trusted(), "first words");
			await started.idle(a.sessionId, TURN_MS);
			await started.idle(b.sessionId, TURN_MS);
			await untilAnswered(
				"the first signs in to the mesh",
				async () => addressesOf(a.sessionId).length > 0,
			);
			const [address = ""] = addressesOf(a.sessionId);
			const watching = await viewing(started, a.sessionId);
			const other = await viewing(started, b.sessionId);
			await watching.shows("heard: first words", TURN_MS);

			await steerInbox(sealed, address, "", "close");

			expect(await watching.detached).toBe(CLOSED);
			await started.gone(a.sessionId, TURN_MS);
			expect(
				(await started.list()).map((one) => one.sessionId),
				"the host holds the other alone",
			).toEqual([b.sessionId]);
			const weighed = await started.weigh();
			expect(
				weighed.sessions,
				"no session of the closed conversation is left in the host's memory",
			).not.toContain(a.sessionId);
			expect(weighed.sessions).toContain(b.sessionId);
			await expect(
				viewing(started, a.sessionId),
				"a new viewer finds no screen of it to attach to",
			).rejects.toThrow(/attach refused/);

			other.type(`after the close${ENTER}`);
			await other.shows("heard: after the close", TURN_MS);
		});
	},
	// A host's start, two opens, a close, and a turn after it.
	ROUND_TRIP_MS * 2,
);
