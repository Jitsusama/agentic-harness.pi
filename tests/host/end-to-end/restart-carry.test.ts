/**
 * E23: a host that restarts itself, with a hosted conversation's
 * background command running, carries the command through the restart
 * as a move does. The command runs on while no host runs, and the host
 * started after resumes the conversation and says the command's end in
 * it, under the same job id, leaving nothing the shell kept. Before
 * this a restart waited on every job, and on 13 November neither work
 * host restarted for hours, since each always held one (QCXZEB).
 *
 * E24: the same, but the command's shell is killed while no host runs,
 * so it writes no exit status. The next host says it was lost, with its
 * job id, rather than dropping it or running it again.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { saidAfter } from "./support/held-pi.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import {
	CARRIED_END,
	CARRY,
	CARRYING,
	SCRIPTED,
} from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** How long the carried command runs, as CARRYING times it, and room past it. */
const CARRIED_MS = 45_000 + ROUND_TRIP_MS;

let sealed: Seal;
let hosts: HostProcess[] = [];
beforeEach(async () => {
	sealed = await seal();
	hosts = [];
});
afterEach(async () => {
	for (const host of hosts) await host.kill();
	await sealed.dispose();
});

/** What every host started here wrote, for a failure. */
function said(): string {
	return hosts
		.map((host, at) => `Host ${at + 1} wrote:\n${host.errors()}`)
		.join("\n");
}

/** The folder the shell keeps its commands in, under the seal's state. */
function keptFolder(): string {
	return join(
		sealed.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"shell-workflow",
		"kept",
	);
}

/** What the shell keeps of its commands on disk. */
function kept(): string[] {
	const folder = keptFolder();
	return existsSync(folder) ? readdirSync(folder).map(String) : [];
}

/** The carried command's shell, from the pid its stub kept. */
function keptShell(): number | undefined {
	const file = kept().find((name) => name.endsWith(".pid"));
	if (file === undefined) return undefined;
	const pid = Number(readFileSync(join(keptFolder(), file), "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether a process is still there. */
function alive(pid: number): boolean {
	return existsSync(`/proc/${pid}`);
}

/** A host under the seal, kept to be killed after. */
async function start(pi: string): Promise<HostProcess> {
	const host = await startHost({
		seal: sealed,
		engine: PI_ENGINE,
		kind: "background",
		env: { PI_HOST_PACKAGE_DIR: pi },
	});
	hosts.push(host);
	return host;
}

/**
 * Open a conversation that starts the carried command in the background,
 * and answer its log, what the log held then, and the command's shell.
 */
async function carrying(
	host: HostProcess,
): Promise<{ file: string; held: string; shell: number }> {
	const cwd = join(sealed.home, "w");
	await mkdir(cwd, { recursive: true });
	const one = await host.open(cwd, { model: SCRIPTED, first: CARRY });
	const file = one.file ?? "";
	await untilAnswered(
		"the hosted turn that started the command to end",
		async () => textOf(file).includes(CARRYING) && turnEnded(file),
		ROUND_TRIP_MS,
	);
	const shell = keptShell();
	if (shell === undefined || !alive(shell))
		throw new Error(`the carried command isn't running; ${said()}`);
	return { file, held: await readFile(file, "utf8"), shell };
}

it(
	"E23: a host's own restart carries a running background command, and the next host says its end",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const first = await start(pi);
			const { file, held, shell } = await carrying(first);

			await first.restart();
			expect(
				alive(shell),
				[
					"the restart let the command run on",
					`the log records a carry: ${textOf(file).includes('"job-carried"')}`,
					said(),
				].join("\n"),
			).toBe(true);

			const second = await start(pi);
			await untilAnswered(
				"the next host resumes the conversation",
				async () => (await second.list()).length === 1,
				ROUND_TRIP_MS,
			);
			await untilAnswered(
				"the command's end is said after the restart, under its job id",
				async () => {
					const there = saidAfter(file, held.length);
					return there.includes(CARRIED_END) && there.includes("[j1]");
				},
				CARRIED_MS,
			).catch((failed: unknown) => {
				throw new Error(`${String(failed)}\n${said()}`);
			});
			await untilAnswered(
				"nothing the shell kept of the command is left once its end is said",
				async () => kept().length === 0,
				ROUND_TRIP_MS,
			).catch((failed: unknown) => {
				throw new Error(`${String(failed)}; left: ${kept().join(", ")}`);
			});
		});
	},
	ROUND_TRIP_MS * 4 + CARRIED_MS,
);

it(
	"E24: a carried command whose shell dies during the restart is said as lost",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const first = await start(pi);
			const { file, held, shell } = await carrying(first);

			await first.restart();
			// Killed while no host runs, its stub never writes a status.
			process.kill(-shell, "SIGKILL");

			await start(pi);
			await untilAnswered(
				"the next host says the command was lost, under its job id",
				async () => {
					const there = saidAfter(file, held.length);
					return there.includes("was lost") && there.includes("[j1]");
				},
				ROUND_TRIP_MS * 2,
			).catch((failed: unknown) => {
				throw new Error(
					`${String(failed)}\nsaid: ${saidAfter(file, held.length)}\n${said()}`,
				);
			});
			// The lost line quotes the command, its echo included, so only a
			// line of the echo's own output would say it ran again.
			const there = saidAfter(file, held.length);
			expect(
				there.split("\n").map((line) => line.trim()),
				`a lost command is never run again; said: ${there}`,
			).not.toContain(CARRIED_END);
			expect(there, "a lost command is never said to exit").not.toMatch(
				/exited \d+ after/,
			);
		});
	},
	ROUND_TRIP_MS * 5,
);
