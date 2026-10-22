import { describe, expect, it } from "vitest";
import {
	type Job,
	kindOf,
	MOST_VMS,
	nextTurn,
	RAMP_MS,
	SPREAD_MS,
	waitingInOrder,
	waitsWithRoom,
	whatOf,
} from "../../../../lib/internal/priority/queue.ts";

const NOW = Date.parse("2026-10-22T16:00:00Z");
const ROOMY = { availableGib: 40, memoryPressure: 0 };

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

	it("finds none where the work is only named, or there is none", () => {
		expect(kindOf("git log --oneline")).toBeUndefined();
		expect(kindOf("rg 'nix build' docs")).toBeUndefined();
		expect(
			kindOf("git commit -F - <<'EOF'\ncargo build is faster\nEOF"),
		).toBeUndefined();
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
			nextTurn([job("next")], { availableGib: 40, memoryPressure: 10 }, NOW),
		).toBeUndefined();
	});

	it("holds everyone behind a job the memory left can't fit", () => {
		const jobs = [job("vm", { kind: "vm-test" }), job("small")];
		expect(
			nextTurn(jobs, { availableGib: 5, memoryPressure: 0 }, NOW),
		).toBeUndefined();
		expect(
			nextTurn(jobs, { availableGib: 6, memoryPressure: 0 }, NOW)?.id,
		).toBe("vm");
	});

	it("counts what just started as taken while it grows", () => {
		const growing = job("growing", { started: startedAgo(RAMP_MS - 1) });
		const room = { availableGib: 7, memoryPressure: 0 };
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

	it("holds builds while a VM check runs, until VM tests run timed", () => {
		const check = job("check", {
			kind: "vm-check",
			started: startedAgo(RAMP_MS),
		});
		const waiting = [job("build"), job("bench", { kind: "benchmark" })];
		expect(nextTurn([check, job("build")], ROOMY, NOW)).toBeUndefined();
		expect(nextTurn([check, ...waiting], ROOMY, NOW)?.id).toBe("bench");
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
		expect(waitsWithRoom(waiting, { availableGib: 5, memoryPressure: 0 })).toBe(
			false,
		);
		expect(
			waitsWithRoom([{ ...waiting[0], started: startedAgo(1) }], ROOMY),
		).toBe(false);
	});
});
