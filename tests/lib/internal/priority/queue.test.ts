import { describe, expect, it } from "vitest";
import {
	type Job,
	kindOf,
	MOST_CPU_PRESSURE_BESIDE_VMS,
	MOST_VMS,
	nextTurn,
	RAMP_MS,
	roomLeft,
	roomSaid,
	SPREAD_MS,
	waitingInOrder,
	waitsWithRoom,
	whatOf,
} from "../../../../lib/internal/priority/queue.ts";

const NOW = Date.parse("2026-10-22T16:00:00Z");
const ROOMY = { availableGib: 40, memoryPressure: 0, vms: 0, cpuPressure: 0 };
const BUSY = { ...ROOMY, cpuPressure: MOST_CPU_PRESSURE_BESIDE_VMS };

function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		kind: "build",
		what: "nix build",
		owner: { session: "s", pid: 1 },
		since: new Date(NOW - 60_000).toISOString(),
		...over,
	};
}

const startedAgo = (ms: number) => new Date(NOW - ms).toISOString();

describe("the kind of heavy work a command runs", () => {
	it("reads each kind from the command", () => {
		expect(kindOf("./result/bin/nixos-test-driver")).toBe("vm-test");
		expect(kindOf("qemu-system-x86_64 -m 2G disk.img")).toBe("vm-test");
		expect(kindOf("nix build .#checks.x86_64-linux.vm-desktop-works")).toBe(
			"vm-check",
		);
		expect(
			kindOf("nix build .#checks.x86_64-linux.vm-desktop-works.driver"),
		).toBe("build");
		expect(kindOf("cargo bench")).toBe("benchmark");
		expect(kindOf("hyperfine 'make'")).toBe("benchmark");
		expect(kindOf("cd x && cargo clippy --all")).toBe("build");
		expect(kindOf("nix flake check")).toBe("build");
		expect(kindOf("sudo nixos-rebuild switch")).toBe("build");
	});

	it("reads a quoted word as the argument it is", () => {
		expect(
			kindOf(
				'nix build -L "path:$W/tmp/$job#checks.x86_64-linux.vm-desktop-works"',
			),
		).toBe("vm-check");
		expect(kindOf('echo "nix build is slow"')).toBeUndefined();
	});

	it("finds none where the work is only named, or there is none", () => {
		expect(kindOf("git log --oneline")).toBeUndefined();
		expect(kindOf("rg 'nix build' docs")).toBeUndefined();
		expect(
			kindOf("git commit -F - <<'EOF'\ncargo build is faster\nEOF"),
		).toBeUndefined();
	});

	it("finds none in a step that only looks for the work", () => {
		for (const looking of [
			"rm -f x; pgrep -x qemu-system-x86 | xargs -r ps -o pid,user -p",
			'pkill -f "qemu-system-x86_64"',
			"pidof qemu-system-x86_64",
			"ps -C qemu-system-x86",
			"sudo systemctl status qemu-system-x86",
			"ls /proc | grep -c qemu-kvm",
		]) {
			expect(kindOf(looking)).toBeUndefined();
		}
		expect(kindOf("pgrep -x qemu-kvm || nix build .#a")).toBe("build");
	});

	it("says the step that does the work, past the variables it sets", () => {
		expect(whatOf('cd core && RUST_LOG=debug A="x y" cargo test -p a')).toBe(
			"cargo test -p a",
		);
		expect(whatOf("echo hi")).toBe("echo hi");
	});
});

describe("whose turn it is", () => {
	it("starts timed work first, then the oldest", () => {
		const jobs = [
			job("old"),
			job("newer", { since: startedAgo(10_000) }),
			job("timed", { kind: "benchmark", since: startedAgo(5_000) }),
		];
		expect(waitingInOrder(jobs).map((one) => one.id)).toEqual([
			"timed",
			"old",
			"newer",
		]);
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("timed");
	});

	it("gives no turn within a spread of the last, nor under pressure", () => {
		const running = job("running", { started: startedAgo(SPREAD_MS - 1) });
		expect(nextTurn([running, job("next")], ROOMY, NOW)).toBeUndefined();
		const settled = { ...running, started: startedAgo(SPREAD_MS) };
		expect(nextTurn([settled, job("next")], ROOMY, NOW)?.id).toBe("next");
		expect(
			nextTurn([job("next")], { ...ROOMY, memoryPressure: 10 }, NOW),
		).toBeUndefined();
	});

	it("holds everyone behind a job the memory left can't fit", () => {
		const jobs = [job("vm", { kind: "vm-test" }), job("small")];
		expect(nextTurn(jobs, { ...ROOMY, availableGib: 5 }, NOW)).toBeUndefined();
		expect(nextTurn(jobs, { ...ROOMY, availableGib: 6 }, NOW)?.id).toBe("vm");
	});

	it("counts what just started as taken while it grows", () => {
		const growing = job("growing", { started: startedAgo(RAMP_MS - 1) });
		const room = { ...ROOMY, availableGib: 7 };
		expect(nextTurn([growing, job("next")], room, NOW)).toBeUndefined();
		const grown = { ...growing, started: startedAgo(RAMP_MS) };
		expect(nextTurn([grown, job("next")], room, NOW)?.id).toBe("next");
	});

	it("lets the next job past a VM the VMs at once hold back", () => {
		const vms = Array.from({ length: MOST_VMS }, (_, at) =>
			job(`vm${at}`, { kind: "vm-test", started: startedAgo(RAMP_MS) }),
		);
		const jobs = [...vms, job("third", { kind: "vm-test" }), job("build")];
		expect(nextTurn(jobs, ROOMY, NOW)?.id).toBe("build");
	});

	it("counts the VMs the machine runs, queued or not", () => {
		const machine = { ...ROOMY, vms: MOST_VMS };
		expect(
			nextTurn([job("vm", { kind: "vm-test" })], machine, NOW),
		).toBeUndefined();
		// A VM outside the queue is a check the daemon runs: builds beside
		// it are capped.
		expect(nextTurn([job("build")], { ...ROOMY, vms: 1 }, NOW)?.capped).toBe(
			true,
		);
		const test = job("test", { kind: "vm-test", started: startedAgo(RAMP_MS) });
		expect(nextTurn([test, job("build")], { ...ROOMY, vms: 1 }, NOW)).toEqual(
			job("build"),
		);
	});

	it("holds the checks behind a build that waits for a check", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const later = job("later", { kind: "vm-check", since: startedAgo(1) });
		expect(nextTurn([check, job("build"), later], BUSY, NOW)).toBeUndefined();
	});

	it("starts one capped build beside a VM check while the CPU is free", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		expect(nextTurn([check, job("build")], ROOMY, NOW)).toEqual({
			...job("build"),
			capped: true,
		});
		const beside = job("beside", { started: startedAgo(RAMP_MS) });
		expect(nextTurn([check, beside, job("build")], ROOMY, NOW)).toBeUndefined();
		expect(nextTurn([check, job("build")], BUSY, NOW)).toBeUndefined();
		const waiting = [job("build"), job("bench", { kind: "benchmark" })];
		expect(nextTurn([check, ...waiting], BUSY, NOW)?.id).toBe("bench");
		expect(
			nextTurn([check, job("build")], ROOMY, NOW, {
				buildsWaitForVmChecks: false,
			})?.id,
		).toBe("build");
		const building = job("building", { started: startedAgo(RAMP_MS) });
		expect(
			nextTurn([building, job("check", { kind: "vm-check" })], ROOMY, NOW)?.id,
		).toBe("check");
	});

	it("counts a wait as wasted only when its memory stands free", () => {
		const waiting = [job("vm", { kind: "vm-test" })];
		expect(waitsWithRoom(waiting, ROOMY)).toBe(true);
		expect(waitsWithRoom(waiting, { ...ROOMY, availableGib: 5 })).toBe(false);
		expect(
			waitsWithRoom([{ ...waiting[0], started: startedAgo(1) }], ROOMY),
		).toBe(false);
	});
});

describe("the room left", () => {
	it("counts what would start now, past what runs and waits", () => {
		expect(roomLeft([], ROOMY, NOW)).toEqual({ vms: MOST_VMS, builds: 10 });
		const running = job("vm", { kind: "vm-test", started: startedAgo(1) });
		expect(roomLeft([running, job("next")], ROOMY, NOW)).toEqual({
			vms: 1,
			builds: 0,
		});
		expect(roomLeft([], { ...ROOMY, availableGib: 9, vms: 1 }, NOW)).toEqual({
			vms: 1,
			builds: 1,
		});
		const queued = [job("vm", { kind: "vm-test" })];
		expect(roomLeft(queued, { ...ROOMY, availableGib: 10 }, NOW)).toEqual({
			vms: 0,
			builds: 1,
		});
		expect(roomLeft([], { ...ROOMY, memoryPressure: 10 }, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
	});

	it("leaves no VM check past a build held for one", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		expect(roomLeft([check], ROOMY, NOW)).toEqual({ vms: 1, builds: 1 });
		expect(roomLeft([check], BUSY, NOW)).toEqual({ vms: 1, builds: 0 });
		expect(roomLeft([check, job("build")], BUSY, NOW)).toEqual({
			vms: 0,
			builds: 0,
		});
	});

	it("says the room in words, or nothing", () => {
		expect(roomSaid({ vms: 2, builds: 8 })).toBe(
			"2 more VM tests and 8 more builds",
		);
		expect(roomSaid({ vms: 1, builds: 0 })).toBe("1 more VM test");
		expect(roomSaid({ vms: 0, builds: 0 })).toBe("");
	});
});
