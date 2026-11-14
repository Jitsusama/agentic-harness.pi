/**
 * E25: a hosted conversation parked while idle wakes as the person's
 * talk lands in its steer inbox, as Super+S or the launcher's Talk
 * leaves one, and takes it. Before the host watched the inbox only a
 * running pi's look found the talk, a minute apart at worst; here the
 * seal runs nothing else, so the host's watch alone can wake it, and it
 * must start well inside that minute.
 *
 * On the screen host, since only a conversation with a screen parks,
 * with the mesh loaded beside the fixture's own extensions, since the
 * mesh signs it in, names its addresses in its park marker and takes
 * the steer as it starts. Waits out the park rule's two minutes and a
 * minute between looks, so it is long.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	awakePath,
	NAMED_PARK_AFTER_MS,
	readParked,
} from "../../../lib/internal/session/park.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import { steerInbox, textOf, untilAnswered } from "./support/hosted-case.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());

/** How long a turn may take on a loaded machine. */
const TURN_MS = 20_000;
/** park-workflow's minute between looks, as LOOK_EVERY_MS sets it. */
const LOOK_MS = 60_000;
/** How long a named conversation may take to park: its idle time, a look, and room for load. */
const PARK_MS = NAMED_PARK_AFTER_MS + LOOK_MS + 30_000;
/**
 * How soon a talk landing must start its wake: a tenth of the minute a
 * running session's look takes to find it, so only the host's watch of
 * the inbox meets it.
 */
const STEER_WAKES_MS = LOOK_MS / 10;
/** What the person says to it while it sleeps. */
const TALK = "are you there after your nap?";

let sealed: Seal;
let host: ScreenHost | undefined;
beforeEach(async () => {
	sealed = await seal();
});
afterEach(async () => {
	await host?.stop();
	host = undefined;
	await sealed.dispose();
});

const presences = () =>
	createPresences(
		join(
			sealed.env.XDG_STATE_HOME ?? "",
			"pi",
			"agentic-harness.pi",
			"mesh-workflow",
			"presence",
		),
	);

describe.skipIf(!packageDir)(
	"a parked conversation steered (needs a pi with the host's patches: pnpm test:host)",
	() => {
		it(
			"E25: a talk landing in a parked conversation's inbox wakes it at once, and it takes the talk",
			async () => {
				if (!packageDir) throw new Error("the host's pi went missing");
				const started = await startScreenHost(sealed, packageDir, [
					"mesh-workflow",
				]);
				host = started;
				const said = () => `the host said: ${started.errors()}`;
				const { sessionId } = await started.open(
					folders(sealed).trusted(),
					"first words",
				);
				await started.idle(sessionId, TURN_MS);
				await untilAnswered(
					"the conversation signs in to the mesh",
					async () => (presences().of(sessionId)?.addresses ?? []).length > 0,
				).catch((error: unknown) => {
					throw new Error(`${String(error)}; ${said()}`);
				});
				const file =
					(await started.list()).find((one) => one.sessionId === sessionId)
						?.file ?? "";

				// The switch naming it parks it after two minutes idle.
				const parkFolder = join(
					sealed.env.XDG_STATE_HOME ?? "",
					"pi",
					"agentic-harness.pi",
					"park-workflow",
				);
				await mkdir(parkFolder, { recursive: true });
				await writeFile(join(parkFolder, "switch"), `${sessionId}\n`);
				try {
					await started.parked(sessionId, PARK_MS);
				} catch (error: unknown) {
					const awake = await readFile(
						awakePath(sessionId, parkFolder),
						"utf8",
					).catch(() => "nothing");
					throw new Error(
						`${String(error)}; it said it stays awake: ${awake}; ${said()}`,
					);
				}
				const [address] = readParked(sessionId, parkFolder)?.addresses ?? [];
				if (address === undefined)
					throw new Error(`its park marker names no address; ${said()}`);

				const landed = Date.now();
				await steerInbox(sealed, address, TALK);
				let state = "parked";
				while (state === "parked" && Date.now() - landed < TURN_MS)
					state =
						(await started.list()).find((one) => one.sessionId === sessionId)
							?.state ?? "gone";
				const waking = Date.now() - landed;
				process.stdout.write(`steer wake proof: ${waking} ms to wake\n`);
				expect(
					waking,
					`its wake began ${waking} ms after the talk landed; ${said()}`,
				).toBeLessThan(STEER_WAKES_MS);
				await untilAnswered(
					"the woken conversation takes the talk",
					async () => textOf(file).includes(TALK),
					TURN_MS,
				).catch((error: unknown) => {
					throw new Error(`${String(error)}; ${said()}`);
				});
			},
			// A turn, a park, a wake, and room for each.
			TURN_MS * 3 + PARK_MS,
		);
	},
);
