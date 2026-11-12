/**
 * E18: item 11's release of a conversation its host holds parked. An
 * hour idle parks a hosted conversation, and overnight most are, so the
 * drill's release meets them: the move it asks for waits in an inbox
 * only a running conversation reads. Here the seal holds nothing else
 * running, so no other pi's mesh look wakes it: the release has to.
 * The released conversation is offered back, and opened again in plain
 * pi from the same file it runs under the addresses it had and answers.
 *
 * Opens no window, as E12 doesn't: its plain pi runs under script(1).
 * Waits out the park rule's two minutes and a minute between looks, so
 * it is long.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostKey } from "../../../host/service/address.ts";
import { restoreFilePath } from "../../../lib/internal/quest/restore-file.ts";
import { sessionRealm } from "../../../lib/internal/realm.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { NAMED_PARK_AFTER_MS } from "../../../lib/internal/session/park.ts";
import { saysParked } from "../../../lib/mesh/parked.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	steerInbox,
	textOf,
	untilAnswered,
} from "./support/hosted-case.ts";
import { SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import { startTerminalPi, type TerminalPi } from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
const ROOT = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

/** park-workflow's minute between looks, as LOOK_EVERY_MS sets it. */
const LOOK_MS = 60_000;
/** How long a named conversation may take to park: its idle time, a look, and room for load. */
const PARK_MS = NAMED_PARK_AFTER_MS + LOOK_MS + 30_000;
/** How long the release may wait for the parked one, in minutes. */
const DEADLINE_MINUTES = 2;
const MINUTE_MS = 60_000;

let sealed: Seal;
let hosts: HostProcess[] = [];
let plains: TerminalPi[] = [];
beforeEach(async () => {
	sealed = await seal();
	hosts = [];
	plains = [];
});
afterEach(async () => {
	await Promise.all(plains.map((one) => one.stop()));
	await Promise.all(hosts.map((one) => one.kill()));
	await sealed.dispose();
});

/** What the host and the plain pi wrote, for a failure. */
function said(): string {
	return [
		...hosts.map((one) => `The host wrote:\n${one.errors()}`),
		...plains.map((one) => `The plain pi wrote:\n${one.errors()}`),
	].join("\n");
}

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

/** Talk to the conversation at `address` and wait until it answers. */
async function answers(file: string, address: string, what: string) {
	const word = `hello-${randomUUID()}`;
	const before = repliesIn(file);
	await steerInbox(sealed, address, word);
	await untilAnswered(
		what,
		async () => textOf(file).includes(word) && repliesIn(file) > before,
	).catch((error: unknown) => {
		throw new Error(`${String(error)}\n${textOf(file)}`);
	});
}

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

it(
	"E18: a release wakes a parked conversation and hands it back to plain pi",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			hosts.push(host);
			// Trusted as Joel's own folders are, for the plain pi after.
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			const cwd = join(sealed.home, "resting");
			await mkdir(cwd, { recursive: true });
			const one = await host.open(cwd, { model: SCRIPTED });
			const file = one.file ?? "";
			await untilAnswered(
				"the conversation signs in to the mesh",
				async () => (presences().of(one.sessionId)?.addresses ?? []).length > 0,
			);
			const addresses = presences().of(one.sessionId)?.addresses ?? [];
			const [address = ""] = addresses;
			await answers(file, address, `${address} answers hosted`);

			// The switch naming it parks it after two minutes idle.
			const parkFolder = join(
				sealed.env.XDG_STATE_HOME ?? "",
				"pi",
				"agentic-harness.pi",
				"park-workflow",
			);
			await mkdir(parkFolder, { recursive: true });
			await writeFile(join(parkFolder, "switch"), `${one.sessionId}\n`);
			await untilAnswered(
				"the host lists it parked",
				async () =>
					(await host.list()).find((held) => held.sessionId === one.sessionId)
						?.state === "parked",
				PARK_MS,
			);
			const resting = presences().of(one.sessionId);
			expect(
				resting !== undefined && saysParked(resting),
				"its presence says parked, so nothing it runs reads its inbox",
			).toBe(true);
			const held = textOf(file);

			const released = await release([address]);
			expect(released.code, released.out).toBe(0);
			expect(released.out).toContain("1 released");
			expect(await host.list(), "the host ends empty").toEqual([]);
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
					(offered: { id: string }) => offered.id === one.sessionId,
				),
				"it is offered back",
			).toMatchObject({
				address,
				released: { from: hostKey(sealed.realm, "background") },
			});

			// Reopen Them All: in plain pi, from the same file.
			const before = textOf(file);
			const plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				file,
				cwd,
			});
			plains.push(plain);
			await untilAnswered("it runs in its one plain pi", async () => {
				const now = presences().of(one.sessionId);
				return now?.owner?.pid === plain.pid && !now?.hosted;
			});
			expect(
				textOf(file).startsWith(before),
				"its log keeps what it held",
			).toBe(true);
			expect(
				presences().of(one.sessionId)?.addresses,
				"it keeps its addresses",
			).toEqual(addresses);
			await answers(file, address, `${address} answers in plain pi`);
			expect(await host.list(), "the host took none back").toEqual([]);
		});
	},
	// A park, a release, a plain pi and three round trips.
	PARK_MS + DEADLINE_MINUTES * MINUTE_MS + ROUND_TRIP_MS * 4,
);
