/**
 * Where a host's pi-spawner runs: a scope of its own where a host on
 * Linux can make one with the system's own systemd-run, and where it
 * always has otherwise, saying why once; a scope that fails to start
 * leaves every spawner after it unscoped; and a scoped start is never
 * placed in jobs, while an unscoped one is. The placing cases wrap every
 * spawn in the process, as pi's placement does, and undo it after each.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeChildren } from "../../../../lib/internal/priority/place.ts";
import { startProgram } from "../../../../lib/internal/shell/spawner.ts";
import {
	inSpawnerScope,
	resetScopeForTests,
	type ScopeSetting,
	type SpawnerStart,
	sayUnscoped,
	scopeFailed,
	settingHere,
	spawnerStart,
	spawnersScoped,
	spawningSpawner,
} from "../../../../lib/internal/shell/spawner-scope.ts";

const SYSTEM = "/run/current-system/sw/bin";

/** How long a started spawner's output is waited for past its exit. */
const NO_DRAIN_MS = 0;

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
			scoped: true,
		});
		expect(spawnersScoped(linuxHost()), "a host's calls are kept").toBe(true);
	});

	it("reaches the user manager by its private socket too", () => {
		const setting = linuxHost({
			exists: (path) => path === "/run/user/1000/systemd/private",
		});
		expect(
			spawnerStart("/bin/pi-spawner", setting).scoped,
			"the spawner starts in a scope",
		).toBe(true);
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
			scoped: false,
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
			scoped: false,
			unscoped: why,
		});
		expect(spawnersScoped(setting), "nothing keeps a host's calls").toBe(false);
	});

	it("runs plain pi's where it always has, with nothing to say", () => {
		expect(
			spawnerStart("/bin/pi-spawner", linuxHost({ hosted: false })),
		).toEqual({ command: "/bin/pi-spawner", args: [], scoped: false });
	});
});

// 23 November: placing a scoped spawner in jobs just after it started
// moved it back out of the scope its systemd-run had made, leaving 8 of
// 59 hosted spawners in jobs outside any scope (5FWIUS).
describe("where a host's spawner is placed", () => {
	let undo: (() => void) | undefined;
	let folder: string | undefined;
	afterEach(() => {
		undo?.();
		undo = undefined;
		if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
		folder = undefined;
	});

	/** The pids placing writes into jobs, from now on. */
	const placing = (): number[] => {
		const written: number[] = [];
		undo = placeChildren("/jobs/cgroup.procs", (_path, pid) => {
			written.push(pid);
		});
		return written;
	};

	/**
	 * A stand-in systemd-run, which runs its last word in its own process
	 * as the real one runs the spawner once its scope is made, and a
	 * spawner that ends at once.
	 */
	const standIns = (): { run: string; spawner: string } => {
		folder = mkdtempSync(join(tmpdir(), "spawner-start-"));
		const run = join(folder, "systemd-run");
		writeFileSync(run, '#!/bin/sh\nfor last do :; done\nexec "$last"\n', {
			mode: 0o755,
		});
		const spawner = join(folder, "pi-spawner");
		writeFileSync(spawner, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		return { run, spawner };
	};

	/** Starts `spawner` as a host's start does, answering its pid once it ends. */
	const startedAs = (spawner: string, setting: ScopeSetting) =>
		new Promise<number>((resolve) => {
			const started = startProgram(spawner, undefined, NO_DRAIN_MS, setting);
			started.ended(() => resolve(started.pid ?? -1));
		});

	/** Spawns `true` for a spawner started as `start`, answering its pid once it exits. */
	const spawnedFor = (start: SpawnerStart) =>
		new Promise<number>((resolve, reject) => {
			const child = spawningSpawner(start, () => spawn("true"));
			child.on("error", reject);
			child.on("exit", () => resolve(child.pid ?? -1));
		});

	it("leaves a scoped one where pi is, for its scope to keep", async () => {
		const written = placing();
		const { run, spawner } = standIns();
		const scoped = linuxHost({
			find: (program) => (program === "systemd-run" ? run : undefined),
		});

		const kept = await startedAs(spawner, scoped);
		const placed = await startedAs(spawner, linuxHost({ hosted: false }));

		expect(kept, "the scoped one started").toBeGreaterThan(0);
		expect(written, "only plain pi's is placed").toEqual([placed]);
	});

	it.each([
		["for plain pi", { hosted: false }],
		["off Linux", { platform: "darwin" as const }],
		[
			"once a scope failed to start",
			{ failed: "a scoped pi-spawner ended with 1" },
		],
	])(
		"places an unscoped one in jobs %s, as any child",
		async (_case, overrides) => {
			const written = placing();

			const pid = await spawnedFor(
				spawnerStart("/nix/bin/pi-spawner", linuxHost(overrides)),
			);

			expect(written).toEqual([pid]);
		},
	);

	// PV3TE0's round 2 (F3, F5): only the start's word says it is scoped,
	// never its arguments, which every start made today happens to match.
	it("places a start with arguments but no scope, as any child", async () => {
		const written = placing();

		const pid = await spawnedFor({
			command: "/nix/bin/pi-spawner",
			args: ["--quiet"],
			scoped: false,
		});

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

	// PV3TE0's round 2 (F1, F6, F9): read as no reason given, plain pi's
	// direct start, which gives none, was called scoped.
	it("isn't so for plain pi, whose spawner runs where it always has", () => {
		expect(
			spawnersScoped(linuxHost({ hosted: false })),
			"plain pi's spawners aren't scoped",
		).toBe(false);
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
