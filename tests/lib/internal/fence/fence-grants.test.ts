/**
 * What a machine grants the strict profile is bound into the fence's own
 * root, after its `/dev` and emptied runtime folder, which would hide it.
 */

import { describe, expect, it } from "vitest";
import { fenceArgs } from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";

const disk: Disk = {
	kind: (path) => (path.split("/").includes(".git") ? undefined : "folder"),
	entries: () => [],
};

const grants = {
	read: ["/run/worker-signing", "/run/user/1001/delta"],
	write: ["/world", "/dev/kvm"],
};

const place = { home: "/home/worker", runtimeDir: "/run/user/1001" };

/** Where `args` holds the run of words `run`, or -1. */
function at(args: readonly string[], run: readonly string[]): number {
	return args.findIndex((_, start) =>
		run.every((word, offset) => args[start + offset] === word),
	);
}

describe("a machine's grants inside the fence", () => {
	it("binds a granted /dev/kvm as a device, after the fence's /dev", () => {
		const args = fenceArgs({ ...place, grants }, disk);
		const kvm = at(args, ["--dev-bind", "/dev/kvm", "/dev/kvm"]);
		expect(kvm, "kvm is bound as a device").toBeGreaterThan(-1);
		expect(kvm, "after the fence's own /dev").toBeGreaterThan(
			at(args, ["--dev", "/dev"]),
		);
	});

	it("binds reads read-only and writes writable, after the runtime folder is emptied", () => {
		const args = fenceArgs({ ...place, grants }, disk);
		const emptied = at(args, ["--tmpfs", "/run/user/1001"]);
		const delta = at(args, [
			"--ro-bind",
			"/run/user/1001/delta",
			"/run/user/1001/delta",
		]);
		expect(delta, "the token's folder is bound read-only").toBeGreaterThan(
			emptied,
		);
		expect(
			at(args, ["--ro-bind", "/run/worker-signing", "/run/worker-signing"]),
			"the signing folder is bound read-only",
		).toBeGreaterThan(-1);
		expect(
			at(args, ["--bind", "/world", "/world"]),
			"the World disk is bound writable",
		).toBeGreaterThan(-1);
	});

	it("leaves out a granted path this machine lacks", () => {
		const noKvm: Disk = {
			...disk,
			kind: (path) => (path === "/dev/kvm" ? undefined : disk.kind(path)),
		};
		const args = fenceArgs({ ...place, grants }, noKvm);
		expect(args, "no kvm to bind").not.toContain("/dev/kvm");
		expect(
			at(args, ["--bind", "/world", "/world"]),
			"the rest still bound",
		).toBeGreaterThan(-1);
	});

	it("binds nothing more where the machine grants nothing", () => {
		const args = fenceArgs(place, disk);
		for (const path of [...grants.read, ...grants.write]) {
			expect(args, `${path} is not bound`).not.toContain(path);
		}
	});
});
