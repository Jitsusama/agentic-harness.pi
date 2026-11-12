/**
 * E13: /host, typed in a plain pi's own window, moves that session into
 * the realm's background host in place. The pi runs in a terminal its
 * holder runs itself, as mycelium's hold runs Joel's: a stand-in
 * holder's record names its pid. /host hands the window to the join as
 * the holder's next command and ends, and the take-up it started adopts
 * the log into the host, which lists the conversation under the same
 * session, its log holding what the pi held, and answers there under the
 * same address.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { JOIN_SCRIPT } from "../../../extensions/mesh-workflow/in-place.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	steerInbox,
	textOf,
	untilAnswered,
} from "./support/hosted-case.ts";
import { type Seal, seal } from "./support/seal.ts";
import {
	SCRIPTED_PROVIDER,
	startTerminalPi,
	type TerminalPi,
} from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/**
 * How long the move may take once asked: its 5 s with no key pressed,
 * a look every 2 s, the pi's end, and the take-up's look every 2 s.
 */
const MOVE_MS = 60_000;

let sealed: Seal;
let host: HostProcess | undefined;
let plain: TerminalPi | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	plain = undefined;
});
afterEach(async () => {
	await plain?.stop();
	await host?.kill();
	await sealed.dispose();
});

/** What the host and the plain pi wrote, for a failure. */
function said(): string {
	return [
		host ? `The host wrote:\n${host.errors()}` : "",
		plain ? `The plain pi wrote:\n${plain.errors()}` : "",
	].join("\n");
}

it(
	"E13: /host moves a held plain pi into the background host in its own window, its log intact",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			// A held pi takes no flag a restart would lose, so the scripted
			// model loads from the settings the host's engine wrote.
			const settings = join(sealed.home, ".pi", "agent", "settings.json");
			const written: unknown = JSON.parse(await readFile(settings, "utf8"));
			await writeFile(
				settings,
				JSON.stringify({
					...(isRecord(written) ? written : {}),
					extensions: [SCRIPTED_PROVIDER],
				}),
			);
			const cwd = join(sealed.home, "w");
			await mkdir(cwd, { recursive: true });
			// Trusted as Joel's own folders are, as pi's "Trust parent
			// folder" writes it, under the path pi resolves.
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			// The holder's files, as mycelium's hold keeps them.
			const hold = join(sealed.root, "hold");
			await mkdir(hold, { recursive: true });
			const wake = join(hold, "e13.wake");
			const again = join(hold, "e13.again");
			plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				cwd,
				env: { MYCELIUM_WAKE: wake, MYCELIUM_AGAIN: again },
				bare: true,
			});
			await writeFile(
				join(hold, "e13.json"),
				JSON.stringify({ pid: plain.pid }),
			);
			const word = `before-${randomUUID()}`;
			await plain.prompt(word);
			await untilAnswered(
				"the plain pi answers",
				async () => repliesIn(plain?.file()) > 0,
				ROUND_TRIP_MS,
			);
			const file = plain.file() ?? "";
			const held = await readFile(file, "utf8");

			plain.type("/host");
			await untilAnswered(
				"the plain pi ends, handing its window on",
				async () => plain?.ended() ?? true,
				MOVE_MS,
			);
			const next: unknown = JSON.parse(await readFile(again, "utf8"));
			expect(next, "the holder runs the join next").toEqual(
				expect.arrayContaining([JOIN_SCRIPT, "--session", plain.sessionId]),
			);
			await untilAnswered(
				"the background host lists the conversation",
				async () =>
					((await host?.list()) ?? []).some(
						(one) => one.sessionId === plain?.sessionId,
					),
				MOVE_MS,
			);
			expect(
				(await readFile(file, "utf8")).startsWith(held),
				"its log keeps what the pi held",
			).toBe(true);

			const after = `after-${randomUUID()}`;
			const before = repliesIn(file);
			await steerInbox(sealed, sessionAddress(plain.sessionId), after);
			await untilAnswered(
				"it answers in the host under the same address",
				async () => textOf(file).includes(after) && repliesIn(file) > before,
				ROUND_TRIP_MS,
			);
		});
	},
	ROUND_TRIP_MS * 3 + MOVE_MS * 2,
);
