/**
 * What the soak's cases in `pnpm test:host` share: the pi with the host's
 * patches they need, how long one may run, and a soak run as a process of
 * its own, read back as what it said and its report. Each case is a file
 * of its own, so a parallel host lane runs them side by side, as the
 * longest file bounds the whole run.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect } from "vitest";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "../end-to-end/support/host-pi.ts";

const SOAK = resolve(import.meta.dirname, "soak.mts");

/** Two sides each loading every extension, on a loaded machine. */
export const RUN_MS = 600_000;

/**
 * How long a soak may run: just inside its case's limit, so one that
 * overruns is stopped with the hosts it started, and says what it had,
 * rather than going on loading the cores the files beside it share.
 */
const SOAK_WITHIN_MS = RUN_MS - 15_000;

/** How long a soak's group has to end on SIGTERM before it is killed. */
const STOP_GRACE_MS = 10_000;

/** How often a stop looks whether the group has ended. */
const STOP_LOOK_MS = 100;

/**
 * The groups of soaks still running, stopped once their file's cases
 * end, and killed outright should the worker exit first, so a soak's
 * hosts never outlive the file that started them.
 */
const running = new Set<number>();
afterAll(() => Promise.all([...running].map(stopGroup)));
process.on("exit", () => {
	for (const pid of running) signalGroup(pid, "SIGKILL");
});

/** The pi with the host's patches, or undefined to skip; a host run that requires one and finds none fails. */
export function soakPackageDir(): string | undefined {
	const packageDir = hostPackageDir();
	if (!packageDir && process.env[HOST_PI_REQUIRED])
		throw new Error(hostPiMissing());
	return packageDir;
}

/** A folder of its own for a soak's run, named from `name`, removed once its file's cases end. */
export function soakOut(name: string): string {
	const out = mkdtempSync(join(tmpdir(), `soak-${name}-`));
	afterAll(() => rmSync(out, { recursive: true, force: true }));
	return out;
}

/** Run a soak into `into`, the smallest unless `size` gives its turns and checkpoints, with `env` added to its environment: what it said and its report. */
export async function soaked(
	into: string,
	extra: readonly string[],
	[turns, checkpoints]: readonly [string, string] = ["2,2", "1"],
	env: Readonly<Record<string, string>> = {},
): Promise<{ said: string; report: unknown }> {
	const child = spawn(
		process.execPath,
		[
			"--no-warnings",
			SOAK,
			"--turns",
			turns,
			"--checkpoints",
			checkpoints,
			...extra,
			"--out",
			into,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
			// A group of its own, so a stop reaches the hosts it started too.
			detached: true,
		},
	);
	const { pid } = child;
	if (pid !== undefined) running.add(pid);
	let overran = false;
	const overrun = setTimeout(() => {
		overran = true;
		// Its exit, which this stop brings, is what the case awaits.
		if (pid !== undefined) void stopGroup(pid);
	}, SOAK_WITHIN_MS);
	let said = "";
	child.stdout.on("data", (chunk) => {
		said += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		said += String(chunk);
	});
	const [code] = await once(child, "exit");
	clearTimeout(overrun);
	// A host the soak left behind goes with its group.
	if (pid !== undefined) await stopGroup(pid);
	expect(
		code,
		overran
			? `the soak ran past ${SOAK_WITHIN_MS} ms and was stopped:\n${said}`
			: said,
	).toBe(0);
	const report: unknown = JSON.parse(
		readFileSync(join(into, "report.json"), "utf8"),
	);
	return { said, report };
}

/**
 * Stop every process in a soak's group: SIGTERM, which each host ends
 * on, then SIGKILL for whatever is left once STOP_GRACE_MS has passed.
 */
async function stopGroup(pid: number): Promise<void> {
	if (signalGroup(pid, "SIGTERM")) {
		const deadline = Date.now() + STOP_GRACE_MS;
		while (Date.now() < deadline && signalGroup(pid, 0)) {
			// A group's end can't be awaited, only looked for.
			await delay(STOP_LOOK_MS);
		}
		signalGroup(pid, "SIGKILL");
	}
	running.delete(pid);
}

/** Send `signal` to a soak's group: whether any process in it was there. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		// The group has ended, which is what a stop waits for.
		return false;
	}
}

/** The JSON a soak line opening with `lead` holds, or undefined when no line does. */
export function saidAfter(said: string, lead: string): unknown {
	const line = said
		.split("\n")
		.map((one) => one.replace(/^soak \S+ /, ""))
		.reverse()
		.find((one) => one.startsWith(lead));
	return line === undefined ? undefined : JSON.parse(line.slice(lead.length));
}
