/**
 * E18: item 11's release of a conversation its host holds parked. An
 * hour idle parks a hosted conversation, and overnight most are, so the
 * drill's release meets them: the move it asks for waits in an inbox
 * only a running conversation reads. Here the seal runs nothing else, so
 * no other pi's mesh look wakes it: the release has to. It closes with
 * its note, its host lets it go, its log keeps what it held, and
 * restore.json offers it back. E12 reopens a released one in plain pi.
 *
 * On the screen host, since only a conversation with a screen parks, with
 * the mesh loaded beside the fixture's own extensions, since the move is
 * the mesh's steer. Waits out the park rule's two minutes and a minute
 * between looks, so it is long.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostKey } from "../../../host/service/address.ts";
import { restoreFilePath } from "../../../lib/internal/quest/restore-file.ts";
import { sessionRealm } from "../../../lib/internal/realm.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	awakePath,
	NAMED_PARK_AFTER_MS,
} from "../../../lib/internal/session/park.ts";
import { saysParked } from "../../../lib/mesh/parked.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import { textOf, untilAnswered } from "./support/hosted-case.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());

const ROOT = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

/** How long a turn may take on a loaded machine. */
const TURN_MS = 20_000;
/** park-workflow's minute between looks, as LOOK_EVERY_MS sets it. */
const LOOK_MS = 60_000;
/** How long a named conversation may take to park: its idle time, a look, and room for load. */
const PARK_MS = NAMED_PARK_AFTER_MS + LOOK_MS + 30_000;
/** How long the release may wait for the parked one, in minutes. */
const DEADLINE_MINUTES = 2;
const MINUTE_MS = 60_000;

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

/** Run host-release.ts in the seal for `names`, answering its exit and output. */
async function release(
	names: readonly string[],
): Promise<{ code: number; out: string }> {
	try {
		const { stdout } = await run(
			process.execPath,
			[
				"--no-warnings",
				join(ROOT, "scripts", "host-release.ts"),
				...names,
				"--deadline",
				String(DEADLINE_MINUTES),
			],
			{ cwd: ROOT, env: sealed.env, timeout: DEADLINE_MINUTES * MINUTE_MS * 2 },
		);
		return { code: 0, out: stdout };
	} catch (error: unknown) {
		// execFile fails on a non-zero exit, carrying what the script wrote.
		if (!isRecord(error)) throw error;
		return {
			code: typeof error.code === "number" ? error.code : 1,
			out: `${String(error.stdout ?? "")}${String(error.stderr ?? "")}`,
		};
	}
}

describe.skipIf(!packageDir)(
	"a release of a parked conversation (needs a pi with the host's patches: pnpm test:host)",
	() => {
		it(
			"E18: a release wakes a parked conversation and hands it back",
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
					async () =>
						(presences().of(sessionId)?.addresses ?? []).length > 0,
				).catch((error: unknown) => {
					throw new Error(`${String(error)}; ${said()}`);
				});
				const [address = ""] = presences().of(sessionId)?.addresses ?? [];
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
				await started
					.parked(sessionId, PARK_MS)
					.catch(async (error: unknown) => {
						const awake = await readFile(
							awakePath(sessionId, parkFolder),
							"utf8",
						).catch(() => "nothing");
						throw new Error(
							`${String(error)}; it said it stays awake: ${awake}; ${said()}`,
						);
					});
				const resting = presences().of(sessionId);
				expect(
					resting !== undefined && saysParked(resting),
					"its presence says parked, so nothing it runs reads its inbox",
				).toBe(true);
				const held = textOf(file);

				const released = await release([address]);
				expect(released.code, `${released.out}\n${said()}`).toBe(0);
				expect(released.out).toContain("1 released");
				expect(await started.list(), "the host lets it go").toEqual([]);
				expect(
					textOf(file).startsWith(held),
					"its release keeps every entry it held",
				).toBe(true);
				const restore = JSON.parse(
					await readFile(
						restoreFilePath(
							sealed.env.XDG_STATE_HOME ?? "",
							sessionRealm(sealed.env),
						),
						"utf8",
					),
				);
				expect(
					restore.sessions.find(
						(offered: { id: string }) => offered.id === sessionId,
					),
					"it is offered back",
				).toMatchObject({
					address,
					released: { from: hostKey(sealed.realm, "attended") },
				});
			},
			// A turn, a park, a release, and room for each.
			TURN_MS * 3 + PARK_MS + DEADLINE_MINUTES * MINUTE_MS,
		);
	},
);
