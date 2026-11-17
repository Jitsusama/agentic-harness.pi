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
 * Without systemd-run or a user manager to reach, as on a Mac, the
 * spawner runs where it always has, said once: the host's stop then
 * ends what its conversations run.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** What every pi-spawner scope's name starts with (reap.ts reads it). */
const SPAWNER_SCOPE_PREFIX = "pi-spawner-";

/** What deciding where a spawner runs reads, for tests to stand in for. */
export interface ScopeSetting {
	readonly platform: NodeJS.Platform;
	/** Whether this pi is a host running conversations. */
	readonly hosted: boolean;
	readonly env: NodeJS.ProcessEnv;
	readonly exists: (path: string) => boolean;
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

/** This process's setting: its platform, environment and files. */
export function settingHere(hosted: boolean): ScopeSetting {
	return {
		platform: process.platform,
		hosted,
		env: process.env,
		exists: existsSync,
		name: `${process.pid}-${randomUUID().slice(0, 8)}`,
	};
}

/** The program `name` on `env`'s PATH, or nothing. */
function onPath(
	name: string,
	env: NodeJS.ProcessEnv,
	exists: (path: string) => boolean,
): string | undefined {
	for (const folder of (env.PATH ?? "").split(delimiter)) {
		if (folder === "") continue;
		const path = join(folder, name);
		if (exists(path)) return path;
	}
	return undefined;
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
	const run = onPath("systemd-run", setting.env, setting.exists);
	if (run === undefined)
		return { ...direct, unscoped: "systemd-run isn't on the PATH" };
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
 * Whether a host's spawners run in scopes of their own here, so what
 * they start outlives the host's stop.
 */
export function spawnersScoped(
	setting: ScopeSetting = settingHere(true),
): boolean {
	return spawnerStart("pi-spawner", setting).unscoped === undefined;
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
