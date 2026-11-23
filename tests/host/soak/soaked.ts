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
	const overrun = setTimeout(() => {
		if (child.pid !== undefined) stopGroup(child.pid);
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
	expect(code, said).toBe(0);
	const report: unknown = JSON.parse(
		readFileSync(join(into, "report.json"), "utf8"),
	);
	return { said, report };
}

/** Ask every process in a soak's group to stop, as each host does on SIGTERM. */
function stopGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// The group has already ended, between the overrun and the stop.
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
