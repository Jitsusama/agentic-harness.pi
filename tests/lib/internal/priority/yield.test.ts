import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BuildSlice,
	buildsShouldYield,
	keepYield,
	vmRunsUnder,
	YIELD_FILE,
	YIELD_WEIGHT,
} from "../../../../lib/internal/priority/yield.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "yield-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A build.slice held in memory, recording every weight set on it. */
function slice(start: number, opts: { vm?: boolean; refuses?: boolean } = {}) {
	let weight = start;
	const set: number[] = [];
	const it: BuildSlice & { readonly set: number[] } = {
		weight: () => weight,
		setWeight(next) {
			if (opts.refuses) return false;
			set.push(next);
			weight = next;
			return true;
		},
		hasVm: () => opts.vm ?? false,
		set,
	};
	return it;
}

const running = (...kinds: string[]) => ({
	jobs: kinds.map((kind, n) => ({ id: `j${n}`, kind, state: "running" })),
});

describe("builds giving way to a stamp", () => {
	it("yield while a stamp runs, and not for a stamp still waiting", () => {
		const waiting = {
			jobs: [{ id: "s", kind: "stamp", state: "waiting" }],
		};
		const cases = {
			stamping: buildsShouldYield(running("build", "stamp"), slice(10)),
			waiting: buildsShouldYield(waiting, slice(10)),
			building: buildsShouldYield(running("build"), slice(10)),
			unread: buildsShouldYield(undefined, slice(10)),
		};

		expect(cases).toEqual({
			stamping: true,
			waiting: false,
			building: false,
			unread: false,
		});
	});

	it("don't yield while a VM runs, so its guest keeps time", () => {
		const cases = {
			queued: buildsShouldYield(running("stamp", "vm-test"), slice(10)),
			found: buildsShouldYield(running("stamp"), slice(10, { vm: true })),
		};

		expect(cases).toEqual({ queued: false, found: false });
	});

	it("lower the weight once, and put back what it was", () => {
		const build = slice(10);

		expect(keepYield(dir, true, build)).toBe("lowered");
		expect(keepYield(dir, true, build), "a second keep lowers nothing").toBe(
			undefined,
		);
		expect(build.set).toEqual([YIELD_WEIGHT]);

		expect(keepYield(dir, false, build)).toBe("restored");
		expect(build.set).toEqual([YIELD_WEIGHT, 10]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("are put back by another session than the one that lowered them", () => {
		keepYield(dir, true, slice(10));
		const later = slice(YIELD_WEIGHT);

		expect(keepYield(dir, false, later)).toBe("restored");
		expect(later.set).toEqual([10]);
	});

	it("leave nothing to put back when the weight can't be lowered", () => {
		expect(keepYield(dir, true, slice(10, { refuses: true }))).toBe(undefined);
		expect(existsSync(join(dir, YIELD_FILE)), "no weight is kept").toBe(false);
		expect(keepYield(dir, true, slice(YIELD_WEIGHT))).toBe(undefined);
	});

	it("keep the weight to put back while systemd refuses it", () => {
		keepYield(dir, true, slice(10));

		expect(keepYield(dir, false, slice(1, { refuses: true }))).toBe(undefined);
		expect(readdirSync(dir)).toEqual([YIELD_FILE]);
	});
});

describe("a VM in the system's slices", () => {
	const process = (cgroup: string, pid: string, comm: string) => {
		mkdirSync(join(dir, "cg", cgroup), { recursive: true });
		writeFileSync(join(dir, "cg", cgroup, "cgroup.procs"), `${pid}\n`);
		mkdirSync(join(dir, "proc", pid), { recursive: true });
		writeFileSync(join(dir, "proc", pid, "comm"), `${comm}\n`);
	};

	it("is found by its name in a build's cgroup, however deep", () => {
		process(
			"build.slice/nix-daemon.service/nix-build-1",
			"7",
			"qemu-system-x86",
		);
		process("build.slice/nix-daemon.service/nix-build-2", "8", "cc1plus");

		expect(
			vmRunsUnder([join(dir, "cg", "build.slice")], join(dir, "proc")),
			"qemu in a build's cgroup is a VM",
		).toBe(true);
	});

	it("is none among compilers, or where nothing is", () => {
		process("build.slice/nix-daemon.service/nix-build-2", "8", "cc1plus");

		expect(
			vmRunsUnder(
				[join(dir, "cg", "build.slice"), join(dir, "cg", "machine.slice")],
				join(dir, "proc"),
			),
			"a compiler is no VM, and a missing slice holds none",
		).toBe(false);
	});
});
