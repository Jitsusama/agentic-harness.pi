/**
 * The fence's first stage takes one hosted conversation and leaves its
 * neighbour as it was. Two conversations open in one host, neither
 * fenced, and the first has bash show it; it is then listed for the
 * stage by its session id, as a person lists a terminal session; the
 * host is killed and started again, so each loads the harness afresh;
 * then each has bash show whether its command may gain privileges and
 * which mounts it sees. The listed one's command now has NoNewPrivs and
 * mounts of its own, the two marks of the fence's bubblewrap the census
 * reads, and its neighbour's has neither.
 *
 * It holds because the host loads a conversation's extensions inside
 * its own scope, where process.env is that conversation's and names its
 * session, and the host's own command line names none. The proof reads
 * the kernel's word, never a socket or a path the fence hides. Runs on
 * the host's pi, as support/host-pi.ts finds it, and skipped saying why
 * without one, where the fence can't be laid, or where this runner
 * already can't gain privileges, since then no command could show 0.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listForStage } from "../../../lib/internal/fence/fence-stage.ts";
import { sandboxFor } from "../../../lib/internal/sandbox/sandbox.ts";
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

/** The mount namespace a `fenced` command said it runs in. */
const MOUNTS = /^mounts: (\S+)$/m;

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

/**
 * The seal's stage folder, where the host's stageFolder() finds it,
 * from the seal's own state folder, which every seal names.
 */
function stageFolder(): string {
	const state = sealed.env.XDG_STATE_HOME;
	if (!state) throw new Error("the seal names no XDG_STATE_HOME");
	return join(state, "pi", "agentic-harness.pi", "fence-stage");
}

/**
 * Why the fence can't be shown here, or nothing when it can: it needs
 * the fence's programs, a bubblewrap that can make its namespaces, and
 * a runner that can still gain privileges, for the neighbour's 0.
 */
async function unprovable(): Promise<string | undefined> {
	const status = await readFile("/proc/self/status", "utf8");
	if (NO_NEW_PRIVS.exec(status)?.[1] !== "0") {
		return "this runner already can't gain privileges, so no command could show it unfenced";
	}
	const sandbox = sandboxFor({ ...process.env, PI_SANDBOX: "fence" });
	if (sandbox.kind !== "fence") return "the fence's programs aren't here";
	const tried = spawnSync(sandbox.bwrap, [
		"--ro-bind",
		"/",
		"/",
		"--unshare-all",
		"--",
		"true",
	]);
	return tried.status === 0
		? undefined
		: "bubblewrap can't make its namespaces here";
}

/** The marks a conversation's latest `fenced` answer shows. */
function marks(file: string | undefined): {
	privileges?: string;
	mounts?: string;
} {
	const answer = toolAnswer(file, "bash") ?? "";
	return {
		privileges: NO_NEW_PRIVS.exec(answer)?.[1],
		mounts: MOUNTS.exec(answer)?.[1],
	};
}

it(
	"a hosted conversation listed for the stage runs its commands fenced, and its neighbour doesn't",
	async ({ skip }) => {
		const why = await unprovable();
		if (why) skip(why);
		const machine = await readlink("/proc/self/ns/mnt");
		const unfenced = { privileges: "0", mounts: machine };
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
			/** Have each conversation run `fenced`, and wait for its new answer. */
			const shown = async (
				which: readonly { sessionId: string; file?: string }[],
			) => {
				const before = which.map((one) => toolAnswer(one.file, "bash"));
				for (const one of which)
					await steerInbox(sealed, sessionAddress(one.sessionId), FENCED);
				await untilAnswered(
					"each conversation shows its marks",
					async () =>
						which.every((one, at) => {
							const now = toolAnswer(one.file, "bash");
							return now !== undefined && now !== before[at];
						}),
					ROUND_TRIP_MS,
				).catch((error: unknown) => {
					throw new Error(
						`${String(error)}\n${which.map((one) => textOf(one.file)).join("\n")}`,
					);
				});
			};
			const first = await start();
			for (const folder of ["a", "b"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const a = await first.open(join(sealed.home, "a"), { model: SCRIPTED });
			const b = await first.open(join(sealed.home, "b"), { model: SCRIPTED });
			await shown([a]);
			expect(marks(a.file), "a runs unfenced before it is listed").toEqual(
				unfenced,
			);

			listForStage(a.sessionId, "the fence-stage case", stageFolder());
			await first.kill();
			const second = await start();
			await untilAnswered("the new host resumes both", async () => {
				const held = (await second.list()).map((one) => one.sessionId);
				return held.includes(a.sessionId) && held.includes(b.sessionId);
			});
			await shown([a, b]);

			const fenced = marks(a.file);
			expect(
				{
					a: {
						privileges: fenced.privileges,
						ownMounts: fenced.mounts !== undefined && fenced.mounts !== machine,
					},
					b: marks(b.file),
				},
				`the listed one's command is fenced, its neighbour's isn't:\na: ${toolAnswer(a.file, "bash")}\nb: ${toolAnswer(b.file, "bash")}`,
			).toEqual({ a: { privileges: "1", ownMounts: true }, b: unfenced });
		});
	},
	// The host's start, two opens, a turn, a restart resuming both and a
	// turn each, with room to say why under load before vitest's clock.
	ROUND_TRIP_MS * 6,
);
