import { afterEach, describe, expect, it, vi } from "vitest";
import { machineBooted } from "../../../../lib/internal/machine/booted.ts";

/** What `sysctl -n kern.boottime` says on a Mac, or the fault it throws. */
const sysctl = vi.hoisted(() => ({
	said: "{ sec = 1795600000, usec = 412345 } Wed Nov 25 12:26:40 2026\n",
	fails: false,
	asked: 0,
}));

vi.mock("node:child_process", async (original) => {
	const child = await original<typeof import("node:child_process")>();
	return {
		...child,
		execFileSync: (file: string, args: readonly string[]) => {
			if (file !== "/usr/sbin/sysctl" || args.join(" ") !== "-n kern.boottime")
				throw new Error(`asked ${file} ${args.join(" ")}`);
			sysctl.asked += 1;
			if (sysctl.fails) throw new Error("sysctl: as the test asked");
			return sysctl.said;
		},
	};
});

const platform = process.platform;

/** The module afresh, as a new process on a machine of `os` would load it. */
async function freshOn(os: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: os });
	vi.resetModules();
	return await import("../../../../lib/internal/machine/booted.ts");
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	sysctl.fails = false;
	sysctl.asked = 0;
});

describe("when the machine booted", () => {
	it("is the kernel's btime, in milliseconds", () => {
		const stat = "cpu  1 2 3\nintr 9\nbtime 1792864593\nprocesses 4\n";

		expect(machineBooted(() => stat)).toBe(1792864593000);
	});

	it("is a Mac's kern.boottime, to the millisecond", () => {
		expect(machineBooted(() => sysctl.said)).toBe(1795600000412);
	});

	it("is nothing where the machine will not say", () => {
		expect(machineBooted(() => "cpu  1 2 3\n")).toBeUndefined();
		expect(machineBooted(() => "{ sec = soon }\n")).toBeUndefined();
		expect(
			machineBooted(() => {
				throw new Error("ENOENT: /proc/stat");
			}),
		).toBeUndefined();
	});

	it("is asked of a Mac's sysctl once a process, since a Mac has no /proc", async () => {
		const { machineBooted: onMac } = await freshOn("darwin");

		expect(onMac()).toBe(1795600000412);
		expect(onMac()).toBe(1795600000412);
		expect(sysctl.asked, "a boot doesn't move while the process runs").toBe(1);
	});

	it("is nothing on a Mac whose sysctl won't answer, and asked again next time", async () => {
		const { machineBooted: onMac } = await freshOn("darwin");
		sysctl.fails = true;

		expect(onMac()).toBeUndefined();
		sysctl.fails = false;
		expect(onMac(), "a fault of the moment isn't kept").toBe(1795600000412);
		expect(sysctl.asked).toBe(2);
	});

	it("is never asked of sysctl off a Mac", async () => {
		const { machineBooted: onLinux } = await freshOn("linux");

		onLinux();
		expect(sysctl.asked).toBe(0);
	});
});
