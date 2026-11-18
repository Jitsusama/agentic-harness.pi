/**
 * The fence's first stage takes one hosted conversation and leaves its
 * neighbour as it was. Two conversations open in one host, neither
 * fenced; one is listed for the stage by its session id, as a person
 * lists a terminal session; the host is killed and started again, so
 * each loads the harness afresh; then each has bash say whether its
 * command may gain privileges. Bubblewrap always takes that away, so the
 * listed one's command says NoNewPrivs 1 and its neighbour's says 0.
 *
 * It holds because the host loads a conversation's extensions inside
 * its own scope, where process.env is that conversation's and names its
 * session, and the host's own command line names none. The proof reads
 * the kernel's word, never a socket or a path the fence hides. Runs on
 * the host's pi, as support/host-pi.ts finds it, skipped saying why
 * without one.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listForStage } from "../../../lib/internal/fence/fence-stage.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	steerInbox,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import { FENCED, SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** The kernel's line on whether a process may gain privileges. */
const NO_NEW_PRIVS = /^NoNewPrivs:\s*(\d)$/m;

let sealed: Seal;
const hosts: HostProcess[] = [];
beforeEach(async () => {
	sealed = await seal();
});
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.kill();
	await sealed.dispose();
});

/** What each host wrote, for a failure. */
function said(): string {
	return hosts
		.map((host, at) => `Host ${at + 1} wrote:\n${host.errors()}`)
		.join("\n");
}

/** The seal's stage folder, where stageFolder() finds it in the host. */
function stageFolder(): string {
	return join(
		sealed.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"fence-stage",
	);
}

it(
	"a hosted conversation listed for the stage runs its commands fenced, and its neighbour doesn't",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const start = async () => {
				const host = await startHost({
					seal: sealed,
					engine: PI_ENGINE,
					env: { PI_HOST_PACKAGE_DIR: pi },
				});
				hosts.push(host);
				return host;
			};
			const first = await start();
			for (const folder of ["a", "b"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const a = await first.open(join(sealed.home, "a"), { model: SCRIPTED });
			const b = await first.open(join(sealed.home, "b"), { model: SCRIPTED });

			listForStage(a.sessionId, "the fence-stage case", stageFolder());
			await first.kill();
			const second = await start();
			await untilAnswered("the new host resumes both", async () => {
				const held = (await second.list()).map((one) => one.sessionId);
				return held.includes(a.sessionId) && held.includes(b.sessionId);
			});
			for (const one of [a, b])
				await steerInbox(sealed, sessionAddress(one.sessionId), FENCED);
			await untilAnswered(
				"both conversations say whether they are fenced",
				async () =>
					[a, b].every((one) => toolAnswer(one.file, "bash") !== undefined),
				ROUND_TRIP_MS,
			).catch((error: unknown) => {
				throw new Error(
					`${String(error)}\na: ${textOf(a.file)}\nb: ${textOf(b.file)}`,
				);
			});
			const privileges = (file: string | undefined) =>
				NO_NEW_PRIVS.exec(toolAnswer(file, "bash") ?? "")?.[1];

			expect(
				{ a: privileges(a.file), b: privileges(b.file) },
				`the listed one's command is fenced, its neighbour's isn't:\na: ${toolAnswer(a.file, "bash")}\nb: ${toolAnswer(b.file, "bash")}`,
			).toEqual({ a: "1", b: "0" });
		});
	},
	// The host's start, two opens, a restart resuming both and a turn each.
	ROUND_TRIP_MS * 3,
);
