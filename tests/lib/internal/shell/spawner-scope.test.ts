/**
 * Where a host's pi-spawner runs: a scope of its own where a host on
 * Linux can make one, and where it always has otherwise, saying why
 * once.
 */

import { describe, expect, it } from "vitest";
import {
	inSpawnerScope,
	type ScopeSetting,
	sayUnscoped,
	spawnerStart,
	spawnersScoped,
} from "../../../../lib/internal/shell/spawner-scope.ts";

/** A Linux host with systemd-run on its PATH and a user manager answering. */
function linuxHost(overrides: Partial<ScopeSetting> = {}): ScopeSetting {
	const files = new Set(["/usr/bin/systemd-run", "/run/user/1000/bus"]);
	return {
		platform: "linux",
		hosted: true,
		env: { PATH: "/bin:/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
		exists: (path) => files.has(path),
		name: "4242-1a2b3c4d",
		...overrides,
	};
}

describe("starting a host's spawner", () => {
	it("runs it in a scope of its own, named apart, the program last", () => {
		expect(spawnerStart("/nix/bin/pi-spawner", linuxHost())).toEqual({
			command: "/usr/bin/systemd-run",
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

	it.each([
		[
			"off Linux",
			{ platform: "darwin" as const },
			"this machine has no systemd",
		],
		[
			"without systemd-run",
			{ env: { PATH: "/bin", XDG_RUNTIME_DIR: "/run/user/1000" } },
			"systemd-run isn't on the PATH",
		],
		[
			"with no user manager",
			{ env: { PATH: "/usr/bin" } },
			"no systemd user manager answers",
		],
	])("runs it where it always has %s, saying why", (_case, overrides, why) => {
		const setting = linuxHost(overrides);
		expect(spawnerStart("/bin/pi-spawner", setting)).toEqual({
			command: "/bin/pi-spawner",
			args: [],
			unscoped: why,
		});
		expect(spawnersScoped(setting), "nothing keeps a host's calls").toBe(
			false,
		);
	});

	it("runs plain pi's where it always has, with nothing to say", () => {
		expect(
			spawnerStart("/bin/pi-spawner", linuxHost({ hosted: false })),
		).toEqual({ command: "/bin/pi-spawner", args: [] });
	});

	it("says once why a host's spawners run in its own cgroup", () => {
		const lines: string[] = [];
		sayUnscoped("systemd-run isn't on the PATH", (line) => lines.push(line));
		sayUnscoped("systemd-run isn't on the PATH", (line) => lines.push(line));
		expect(lines).toEqual([
			"pi-spawner runs in the host's own cgroup, since systemd-run isn't on the PATH: a background command ends when its host stops.\n",
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
