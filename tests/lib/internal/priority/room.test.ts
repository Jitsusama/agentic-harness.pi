import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	floorsIn,
	memoryPeakOf,
	readRoom,
} from "../../../../lib/internal/priority/room.ts";

const GIB = 1024 ** 3;

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "room-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cgroup(path: string, min: number, anon = 0, file = 0) {
	const dir = join(root, "cgroups", path);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "memory.min"), `${min}\n`);
	writeFileSync(join(dir, "memory.current"), `${anon + file}\n`);
	writeFileSync(
		join(dir, "memory.stat"),
		`anon ${anon}\nfile ${file}\nkernel 0\n`,
	);
	return dir;
}

function proc(
	availableGib: number,
	swap?: { readonly totalGib: number; readonly freeGib: number },
	memoryStalled = "4.00",
) {
	const dir = join(root, "proc");
	mkdirSync(join(dir, "pressure"), { recursive: true });
	const kib = (gib: number) => gib * 1024 * 1024;
	writeFileSync(
		join(dir, "meminfo"),
		`MemTotal: 1 kB\nMemAvailable: ${kib(availableGib)} kB\n` +
			(swap
				? `SwapTotal: ${kib(swap.totalGib)} kB\nSwapFree: ${kib(swap.freeGib)} kB\n`
				: ""),
	);
	for (const [kind, avg] of [
		["cpu", "1.50"],
		["memory", memoryStalled],
		["io", "0.25"],
	]) {
		writeFileSync(
			join(dir, "pressure", kind),
			`some avg10=${avg} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
		);
	}
	writeFileSync(join(dir, "cpuinfo"), "processor\t: 0\n\nprocessor\t: 1\n");
	return dir;
}

describe("the machine's room", () => {
	it("counts only the innermost memory floors", () => {
		cgroup("user.slice", 15);
		const app = cgroup(
			"user.slice/user-1000.slice/user@1000.service/app.slice",
			13,
		);
		const session = cgroup(
			"user.slice/user-1000.slice/user@1000.service/session.slice",
			1,
		);
		cgroup("user.slice/user-1000.slice/user@1000.service/jobs.slice", 0);
		expect(floorsIn(join(root, "cgroups"))).toEqual([app, session].sort());
	});

	it("leaves out what a floor keeps past its programs' own memory", () => {
		// A floor full of cache keeps it, though MemAvailable calls it free.
		const app = cgroup("app.slice", 8 * GIB, 6 * GIB, 10 * GIB);
		const session = cgroup("session.slice", 1 * GIB, 3 * GIB);
		const reading = readRoom([app, session], {
			proc: proc(40),
			cgroups: join(root, "cgroups"),
		});
		expect(reading.availableGib).toBe(38);
		expect(reading.memoryPressure).toBe(4);
		expect(reading.pressure).toEqual({ cpu: 1.5, memory: 4, io: 0.25 });
		expect(reading.cores).toBe(2);
		expect(reading.cpuPressure).toBe(1.5);
	});

	describe("memory pressure", () => {
		/** A cgroup stalled this much, holding this much against its high. */
		function stalls(path: string, avg: number, high = "max", current = 0) {
			const dir = join(root, "cgroups", path);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "memory.pressure"),
				`some avg10=${avg.toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`,
			);
			writeFileSync(join(dir, "memory.high"), `${high}\n`);
			writeFileSync(join(dir, "memory.current"), `${current}\n`);
		}
		const user = "user.slice/user-1000.slice/user@1000.service";
		const read = () =>
			readRoom([], {
				proc: proc(40, undefined, "82.00"),
				cgroups: join(root, "cgroups"),
			});

		it("leaves out a cgroup stalled at its own limit", () => {
			// A walk over background.slice's 4 GiB, and nobody else stalled.
			stalls(`${user}/background.slice`, 86, `${4 * GIB}`, 4.4 * GIB);
			stalls(`${user}/app.slice`, 0);
			stalls("system.slice", 0);

			const reading = read();

			expect(reading.memoryPressure).toBe(0);
			expect(reading.pressure.memory).toBe(82);
		});

		it("still holds the queue when others stall as well", () => {
			stalls(`${user}/background.slice`, 86, `${4 * GIB}`, 4.4 * GIB);
			stalls(`${user}/app.slice`, 30);

			expect(read().memoryPressure).toBe(30);
		});

		it("is the machine's figure when no cgroup is at its limit", () => {
			stalls(`${user}/background.slice`, 86, `${4 * GIB}`, 1 * GIB);
			stalls(`${user}/app.slice`, 0);

			expect(read().memoryPressure).toBe(82);
		});
	});

	it("counts no more memory than the swap left", () => {
		const cgroups = join(root, "cgroups");
		mkdirSync(cgroups, { recursive: true });
		const at = (swap: { totalGib: number; freeGib: number }) =>
			readRoom([], { proc: proc(40, swap), cgroups }).availableGib;
		// Cold heaps sit in swap while MemAvailable reads free.
		expect(at({ totalGib: 96, freeGib: 13 })).toBe(13);
		expect(at({ totalGib: 96, freeGib: 90 })).toBe(40);
		// A machine with no swap is read by MemAvailable alone.
		expect(at({ totalGib: 0, freeGib: 0 })).toBe(40);
	});

	it("counts the VMs running, by their processes' names", () => {
		const dir = proc(40);
		for (const [pid, name] of [
			["845775", "qemu-system-x86"],
			["848288", "qemu-kvm"],
			["845929", "kvm-pit/45"],
			["12", "nix-daemon"],
		]) {
			mkdirSync(join(dir, pid));
			writeFileSync(join(dir, pid, "comm"), `${name}\n`);
		}
		mkdirSync(join(dir, "qemu-system-x86"));
		expect(readRoom([], { proc: dir, cgroups: root }).vms).toBe(2);
	});

	it("counts a check with deadlines in a Nix build as a VM, though no qemu runs in it", () => {
		const dir = proc(40);
		const daemon = join(root, "cgroups", "build.slice/nix-daemon.service");
		const running = (build: string, pids: Record<string, string>) => {
			mkdirSync(join(daemon, build), { recursive: true });
			writeFileSync(
				join(daemon, build, "cgroup.procs"),
				`${Object.keys(pids).join("\n")}\n`,
			);
			for (const [pid, name] of Object.entries(pids)) {
				mkdirSync(join(dir, pid));
				writeFileSync(join(dir, pid, "comm"), `${name}\n`);
			}
		};
		// A VM test: its qemu counts it, and its driver doesn't count it again.
		running("nix-build-uid-1", {
			"101": ".nixos-test-dri",
			"102": "qemu-system-x86",
		});
		// A container's test, and a nested compositor's, in its container's cgroup.
		running("nix-build-uid-2", {
			"201": ".nixos-test-dri",
			"202": "systemd-nspawn",
		});
		running("nix-build-uid-3", { "301": "bash" });
		running("nix-build-uid-3/payload", { "302": ".niri-wrapped" });
		// A compiler's build, a niri build running its own tests, which cargo
		// names after the crate and a hash, and Joel's niri outside the daemon.
		running("nix-build-uid-4", { "401": "cc1" });
		running("nix-build-uid-5", {
			"601": "niri-3f2a1b9c0d",
			"602": "niri_config-ab1",
			"603": "swaybg",
		});
		mkdirSync(join(dir, "501"));
		writeFileSync(join(dir, "501", "comm"), "niri\n");

		expect(
			readRoom([], { proc: dir, cgroups: join(root, "cgroups") }).vms,
		).toBe(3);
	});

	it("counts no VM for a compositor only asked something, as a system build asks niri to validate", () => {
		const dir = proc(40);
		const daemon = join(root, "cgroups", "build.slice/nix-daemon.service");
		const running = (build: string, pid: string, argv: string[]) => {
			mkdirSync(join(daemon, build), { recursive: true });
			writeFileSync(join(daemon, build, "cgroup.procs"), `${pid}\n`);
			mkdirSync(join(dir, pid));
			writeFileSync(join(dir, pid, "comm"), `${argv[0]}\n`);
			writeFileSync(join(dir, pid, "cmdline"), `${argv.join("\0")}\0`);
		};
		running("nix-build-uid-1", "101", ["niri", "validate", "-c", "config.kdl"]);
		running("nix-build-uid-2", "201", [".niri-wrapped", "msg", "outputs"]);
		running("nix-build-uid-3", "301", ["sway", "-C", "-c", "config"]);
		// A nested niri running a session still has deadlines.
		running("nix-build-uid-4", "401", [".niri-wrapped", "-c", "config.kdl"]);

		expect(
			readRoom([], { proc: dir, cgroups: join(root, "cgroups") }).vms,
		).toBe(1);
	});

	it("says who asked for each Nix build, whether it has deadlines, and the most memory it held", () => {
		const dir = proc(40);
		const daemon = join(root, "cgroups", "build.slice/nix-daemon.service");
		const running = (
			pid: string,
			comm: string,
			parent: string,
			at: { cmdline?: string; cgroup?: string } = {},
		) => {
			mkdirSync(join(dir, pid));
			writeFileSync(join(dir, pid, "comm"), `${comm}\n`);
			writeFileSync(
				join(dir, pid, "status"),
				`Name:\t${comm}\nPPid:\t${parent}\n`,
			);
			writeFileSync(join(dir, pid, "cmdline"), at.cmdline ?? `${comm}\0`);
			if (at.cgroup)
				writeFileSync(join(dir, pid, "cgroup"), `0::${at.cgroup}\n`);
		};
		const build = (name: string, pids: string[], peak?: number) => {
			mkdirSync(join(daemon, name), { recursive: true });
			writeFileSync(join(daemon, name, "cgroup.procs"), `${pids.join("\n")}\n`);
			if (peak !== undefined)
				writeFileSync(join(daemon, name, "memory.peak"), `${peak}\n`);
		};
		// The daemon forks a worker for each client, naming the client's pid.
		running("971", "nix-daemon", "1", { cmdline: "nix-daemon\0--daemon\0" });
		running("80", "nix", "70", { cgroup: "/jobs.slice/work-70.scope" });
		running("81", "nix", "71", { cgroup: "/jobs.slice/work-71.scope" });
		running("90", "nix-daemon", "971", { cmdline: "nix-daemon\x0080\0\0\0" });
		running("91", "nix-daemon", "971", { cmdline: "nix-daemon\x0081\0\0\0" });
		// A VM test, whose qemu is the builder's child.
		running("101", "bash", "90");
		running("102", "qemu-system-x86", "101");
		build("nix-build-uid-1", ["101", "102"], 3 * GIB);
		// A compiler's build for the other client.
		running("201", "cc1", "91");
		build("nix-build-uid-2", ["201"], GIB);
		// A container's test whose worker has gone, so nobody is known to ask.
		running("301", "systemd-nspawn", "999");
		build("nix-build-uid-3", ["301"]);

		expect(
			readRoom([], { proc: dir, cgroups: join(root, "cgroups") }).builds,
		).toEqual([
			{ asker: "/jobs.slice/work-70.scope", timed: true, memoryPeak: 3 * GIB },
			{ asker: "/jobs.slice/work-71.scope", timed: false, memoryPeak: GIB },
			{ timed: true, memoryPeak: 0 },
		]);
	});
});

describe("memoryPeakOf", () => {
	it("reads the most a cgroup has held, and nothing for one gone or keeping none", () => {
		const cgroups = join(root, "cgroups");
		const scope = join(cgroups, "jobs.slice", "work-71.scope");
		mkdirSync(scope, { recursive: true });
		writeFileSync(join(scope, "memory.peak"), `${3 * GIB}\n`);
		mkdirSync(join(cgroups, "no-peak.scope"));
		expect(memoryPeakOf("/jobs.slice/work-71.scope", cgroups)).toBe(3 * GIB);
		expect(memoryPeakOf("/no-peak.scope", cgroups)).toBeUndefined();
		expect(memoryPeakOf("/gone.scope", cgroups)).toBeUndefined();
	});
});
