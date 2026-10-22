import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { floorsIn, readRoom } from "../../../../lib/internal/priority/room.ts";

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

function proc(availableGib: number) {
	const dir = join(root, "proc");
	mkdirSync(join(dir, "pressure"), { recursive: true });
	writeFileSync(
		join(dir, "meminfo"),
		`MemTotal: 1 kB\nMemAvailable: ${availableGib * 1024 * 1024} kB\n`,
	);
	for (const [kind, avg] of [
		["cpu", "1.50"],
		["memory", "4.00"],
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
});
