/**
 * Where a host's pi-spawner runs: in a transient systemd user scope of
 * its own, outside the host's unit, so the commands it starts outlive
 * the host's stop.
 *
 * On 17 November a host's stop outran systemd's 60 s, and systemd killed
 * the host with everything in its unit's cgroup: the shell and output
 * writer of every bash call its conversations ran in the background,
 * four suites and proofs among them. A scope of the spawner's own keeps
 * what it starts out of the unit, as SEYNT2 kept its runs by starting
 * them with `systemd-run --user --scope` by hand. One scope a spawner,
 * not one a command: every command it starts sits in it. `systemd-run
 * --scope` runs the spawner in its own process once the scope is made,
 * so its pid, pipes and environment are the same. The reapers still
 * count the scope as work (reap.ts), so a stop or a conversation's end
 * kills what its calls left there as it did in the unit.
 *
 * systemd-run is found as pi-spawner is, only in the system's profile
 * (system-program.ts): one taken from `PATH` could be planted, and would
 * start the spawner, and every command after it, as it liked.
 *
 * Without systemd-run or a user manager to reach, as on a Mac, the
 * spawner runs where it always has, said once: the host's stop then
 * ends what its conversations run. A scope that fails to start is said
 * once too, and every spawner after it runs unscoped, so a host never
 * counts on a scope it hasn't got (`spawnersScoped`).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { systemProgram } from "../system-program.ts";
import { spawnerWanted } from "./spawner-variable.ts";

/** What every pi-spawner scope's name starts with (reap.ts reads it). */
const SPAWNER_SCOPE_PREFIX = "pi-spawner-";

/** The program that makes a scope and runs the spawner in it. */
const SCOPE_PROGRAM = "systemd-run";

/** The spawner, as system-program.ts finds it. */
const SPAWNER = "pi-spawner";

/** What deciding where a spawner runs reads, for tests to stand in for. */
export interface ScopeSetting {
	readonly platform: NodeJS.Platform;
	/** Whether this pi is a host running conversations. */
	readonly hosted: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly exists: (path: string) => boolean;
	/** Where a program is in the system's profile, or nothing. */
	readonly find: (program: string) => string | undefined;
	/** Why a scope failed to start in this process, once one has. */
	readonly failed?: string;
	/** Names the scope apart from every other spawner's. */
	readonly name: string;
}

/** How to start the spawner: the program and its arguments. */
interface SpawnerStart {
	readonly command: string;
	readonly args: readonly string[];
	/** Why it runs in the host's own cgroup, when a host's spawner does. */
	readonly unscoped?: string;
}

/** Why a scope failed to start in this process, once one has. */
let failedBecause: string | undefined;

/** This process's setting: its platform, environment and files. */
export function settingHere(hosted: boolean): ScopeSetting {
	return {
		platform: process.platform,
		hosted,
		env: process.env,
		exists: existsSync,
		find: (program) => systemProgram(program),
		...(failedBecause !== undefined ? { failed: failedBecause } : {}),
		name: `${process.pid}-${randomUUID().slice(0, 8)}`,
	};
}

/** Whether a systemd user manager answers here, by its sockets. */
function managerReachable(
	env: NodeJS.ProcessEnv,
	exists: (path: string) => boolean,
): boolean {
	const runtime = env.XDG_RUNTIME_DIR;
	if (!runtime) return false;
	return (
		exists(join(runtime, "systemd", "private")) || exists(join(runtime, "bus"))
	);
}

/**
 * How to start the spawner at `program`: in a scope of its own when a
 * host on Linux can make one, and otherwise directly, saying why when a
 * host's commands then end with it.
 */
export function spawnerStart(
	program: string,
	setting: ScopeSetting,
): SpawnerStart {
	const direct = { command: program, args: [] };
	if (!setting.hosted) return direct;
	if (setting.platform !== "linux")
		return { ...direct, unscoped: "this machine has no systemd" };
	if (setting.failed !== undefined)
		return { ...direct, unscoped: setting.failed };
	const run = setting.find(SCOPE_PROGRAM);
	if (run === undefined)
		return { ...direct, unscoped: "systemd-run isn't in the system's profile" };
	if (!managerReachable(setting.env, setting.exists))
		return { ...direct, unscoped: "no systemd user manager answers" };
	return {
		command: run,
		args: [
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			`--unit=${SPAWNER_SCOPE_PREFIX}${setting.name}`,
			"--",
			program,
		],
	};
}

/**
 * Whether a host's bash calls run in spawners scoped apart from it here,
 * so what they start outlives the host's stop: the spawner is wanted and
 * found, and its scope can be made and hasn't failed to.
 */
export function spawnersScoped(
	setting: ScopeSetting = settingHere(true),
): boolean {
	if (!spawnerWanted(setting.env)) return false;
	const spawner = setting.find(SPAWNER);
	if (spawner === undefined) return false;
	return spawnerStart(spawner, setting).unscoped === undefined;
}

/** Whether a cgroup path lies in a pi-spawner's scope. */
export function inSpawnerScope(cgroup: string): boolean {
	return cgroup
		.split("/")
		.some(
			(part) =>
				part.startsWith(SPAWNER_SCOPE_PREFIX) && part.endsWith(".scope"),
		);
}

/** Whether this process has said its spawners run unscoped. */
let saidUnscoped = false;

/**
 * Say once, to the host's log, why its spawners run in its own cgroup;
 * `write` stands in for its standard error under test.
 */
export function sayUnscoped(
	why: string,
	write: (line: string) => void = (line) => process.stderr.write(line),
): void {
	if (saidUnscoped) return;
	saidUnscoped = true;
	write(
		`pi-spawner runs in the host's own cgroup, since ${why}: a background command ends when its host stops.\n`,
	);
}

/**
 * A scoped spawner ended with `code`, having said `said` on its error
 * output, as a scope systemd-run couldn't make ends: every spawner after
 * it in this process runs unscoped, said once, and the host counts no
 * call as kept. A spawner that failed of itself is taken the same way,
 * since nothing tells the two apart from here.
 */
export function scopeFailed(
	code: number,
	said: string,
	write?: (line: string) => void,
): void {
	if (failedBecause !== undefined) return;
	const told = said.trim().split("\n")[0] ?? "";
	const why = told === "" ? "" : ` (${told})`;
	failedBecause = `a scoped pi-spawner ended with ${code}${why}`;
	sayUnscoped(failedBecause, write);
}

/** Forget a scope's failure and the saying of it, between tests. */
export function resetScopeForTests(): void {
	failedBecause = undefined;
	saidUnscoped = false;
}
