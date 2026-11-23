/**
 * Where a host's pi-spawner runs: a scope of its own where a host on
 * Linux can make one with the system's own systemd-run, and where it
 * always has otherwise, saying why once; and a scope that fails to
 * start leaves every spawner after it unscoped.
 */

import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeChildren } from "../../../../lib/internal/priority/place.ts";
import {
	inSpawnerScope,
	resetScopeForTests,
	type ScopeSetting,
	sayUnscoped,
	scopeFailed,
	settingHere,
	spawnerStart,
	spawnersScoped,
	spawningSpawner,
} from "../../../../lib/internal/shell/spawner-scope.ts";

const SYSTEM = "/run/current-system/sw/bin";

/** A Linux host with systemd-run in its profile and a user manager. */
function linuxHost(overrides: Partial<ScopeSetting> = {}): ScopeSetting {
	const files = new Set(["/run/user/1000/bus"]);
	const programs = new Map([
		["systemd-run", `${SYSTEM}/systemd-run`],
		["pi-spawner", `${SYSTEM}/pi-spawner`],
	]);
	return {
		platform: "linux",
		hosted: true,
		env: { XDG_RUNTIME_DIR: "/run/user/1000" },
		exists: (path) => files.has(path),
		find: (program) => programs.get(program),
		name: "4242-1a2b3c4d",
		...overrides,
	};
}

beforeEach(() => resetScopeForTests());

describe("starting a host's spawner", () => {
	it("runs it in a scope of its own, named apart, the program last", () => {
		expect(spawnerStart("/nix/bin/pi-spawner", linuxHost())).toEqual({
			command: `${SYSTEM}/systemd-run`,
			args: [
				"--user",
				"--scope",
				"--quiet",
				"--collect",
				"--unit=pi-spawner-4242-1a2b3c4d",
				"--",
				"/nix/bin/pi-spawner",
			],
		});
		expect(spawnersScoped(linuxHost()), "a host's calls are kept").toBe(true);
	});

	it("reaches the user manager by its private socket too", () => {
		const setting = linuxHost({
			exists: (path) => path === "/run/user/1000/systemd/private",
		});
		expect(spawnerStart("/bin/pi-spawner", setting).unscoped).toBeUndefined();
	});

	it("never takes systemd-run from the PATH", () => {
		const setting = linuxHost({
			env: { PATH: "/home/me/.direnv/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
			find: (program) =>
				program === "pi-spawner" ? `${SYSTEM}/pi-spawner` : undefined,
		});
		expect(spawnerStart("/bin/pi-spawner", setting)).toEqual({
			command: "/bin/pi-spawner",
			args: [],
			unscoped: "systemd-run isn't in the system's profile",
		});
	});

	it.each([
		[
			"off Linux",
			{ platform: "darwin" as const },
			"this machine has no systemd",
		],
		[
			"without systemd-run",
			{ find: () => undefined },
			"systemd-run isn't in the system's profile",
		],
		["with no user manager", { env: {} }, "no systemd user manager answers"],
		[
			"with no manager's socket in its runtime folder",
			{ exists: () => false },
			"no systemd user manager answers",
		],
		[
			"once a scope failed to start",
			{ failed: "a scoped pi-spawner ended with 1" },
			"a scoped pi-spawner ended with 1",
		],
	])("runs it where it always has %s, saying why", (_case, overrides, why) => {
		const setting = linuxHost(overrides);
		expect(spawnerStart("/bin/pi-spawner", setting)).toEqual({
			command: "/bin/pi-spawner",
			args: [],
			unscoped: why,
		});
		expect(spawnersScoped(setting), "nothing keeps a host's calls").toBe(false);
	});

	it("runs plain pi's where it always has, with nothing to say", () => {
		expect(
			spawnerStart("/bin/pi-spawner", linuxHost({ hosted: false })),
		).toEqual({ command: "/bin/pi-spawner", args: [] });
	});
});

// 23 November: placing a scoped spawner in jobs just after it started
// moved it back out of the scope its systemd-run had made, leaving 8 of
// 59 hosted spawners in jobs outside any scope (5FWIUS).
describe("where a host's spawner is placed", () => {
	let undo: (() => void) | undefined;
	afterEach(() => {
		undo?.();
		undo = undefined;
	});

	/** The pids placing writes into jobs, from now on. */
	const placing = (): number[] => {
		const written: number[] = [];
		undo = placeChildren("/jobs/cgroup.procs", (_path, pid) => {
			written.push(pid);
		});
		return written;
	};

	/** Spawns `true` for a spawner started as `start`, answering its pid once it exits. */
	const spawnedFor = (start: ReturnType<typeof spawnerStart>) =>
		new Promise<number>((resolve, reject) => {
			const child = spawningSpawner(start, () => spawn("true"));
			child.on("error", reject);
			child.on("exit", () => resolve(child.pid ?? -1));
		});

	it("leaves a scoped one where pi is, for its scope to keep", async () => {
		const written = placing();

		await spawnedFor(spawnerStart("/nix/bin/pi-spawner", linuxHost()));

		expect(written).toEqual([]);
	});

	it("places an unscoped one in jobs, as any child", async () => {
		const written = placing();
		const start = spawnerStart(
			"/nix/bin/pi-spawner",
			linuxHost({ platform: "darwin" }),
		);

		const pid = await spawnedFor(start);

		expect(written).toEqual([pid]);
	});
});

describe("whether a host's calls are kept", () => {
	it("isn't so where pi-spawner is turned off", () => {
		const setting = linuxHost({
			env: { PI_SPAWNER: "off", XDG_RUNTIME_DIR: "/run/user/1000" },
		});
		expect(spawnersScoped(setting), "turned off, so unscoped").toBe(false);
	});

	it("isn't so where pi-spawner isn't in the system's profile", () => {
		const setting = linuxHost({
			find: (program) =>
				program === "systemd-run" ? `${SYSTEM}/systemd-run` : undefined,
		});
		expect(spawnersScoped(setting), "no spawner to scope").toBe(false);
	});
});

describe("a scope that fails to start", () => {
	it("is said once, with the first line systemd-run said", () => {
		const lines: string[] = [];
		scopeFailed(1, "Failed to start transient scope unit.\nmore\n", (line) =>
			lines.push(line),
		);
		scopeFailed(1, "again", (line) => lines.push(line));
		expect(lines).toEqual([
			"pi-spawner runs in the host's own cgroup, since a scoped pi-spawner ended with 1 (Failed to start transient scope unit.): a background command ends when its host stops.\n",
		]);
	});

	it("leaves every spawner after it in this process unscoped", () => {
		scopeFailed(1, "", () => {});
		expect(settingHere(true).failed).toBe("a scoped pi-spawner ended with 1");
	});
});

describe("saying a host's spawners run unscoped", () => {
	it("says it once a process", () => {
		const lines: string[] = [];
		sayUnscoped("this machine has no systemd", (line) => lines.push(line));
		sayUnscoped("this machine has no systemd", (line) => lines.push(line));
		expect(lines).toEqual([
			"pi-spawner runs in the host's own cgroup, since this machine has no systemd: a background command ends when its host stops.\n",
		]);
	});
});

describe("a spawner's scope", () => {
	it("is told apart from every other cgroup", () => {
		const user = "/user.slice/user-1000.slice/user@1000.service";
		expect(
			inSpawnerScope(`${user}/app.slice/pi-spawner-4242-1a2b3c4d.scope`),
			"a spawner's scope",
		).toBe(true);
		expect(
			inSpawnerScope(`${user}/app.slice/run-u8.scope`),
			"a scope started by hand",
		).toBe(false);
		expect(
			inSpawnerScope(`${user}/app.slice/pi-spawner-helper.service`),
			"a service named alike",
		).toBe(false);
	});
});
