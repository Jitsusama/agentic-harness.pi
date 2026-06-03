import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearTerminalDrivers,
	getTerminalDriver,
	listTerminalDrivers,
	registerBuiltinTerminalDrivers,
	registerTerminalDriver,
	resolveDriver,
	spawnTerminal,
	type TerminalDriver,
	unregisterTerminalDriver,
} from "../../../lib/terminal/index";

beforeEach(() => clearTerminalDrivers());
afterEach(() => clearTerminalDrivers());

describe("registration", () => {
	const fake: TerminalDriver = {
		id: "fake",
		available: () => true,
		async spawn() {},
	};

	it("registers and retrieves a driver", () => {
		registerTerminalDriver(fake);
		expect(getTerminalDriver("fake")).toBe(fake);
		expect(listTerminalDrivers()).toEqual([fake]);
	});

	it("unregisters a driver", () => {
		registerTerminalDriver(fake);
		unregisterTerminalDriver("fake");
		expect(getTerminalDriver("fake")).toBeUndefined();
	});

	it("registerBuiltinTerminalDrivers seeds wezterm, tmux, fallback", () => {
		registerBuiltinTerminalDrivers();
		expect(listTerminalDrivers().map((d) => d.id)).toEqual([
			"wezterm",
			"tmux",
			"fallback",
		]);
	});
});

describe("resolveDriver", () => {
	it("returns the preferred driver when available", async () => {
		const a: TerminalDriver = {
			id: "a",
			available: () => true,
			async spawn() {},
		};
		const b: TerminalDriver = {
			id: "b",
			available: () => true,
			async spawn() {},
		};
		registerTerminalDriver(a);
		registerTerminalDriver(b);
		const driver = await resolveDriver("b");
		expect(driver?.id).toBe("b");
	});

	it("falls back to registration order when preferred is unavailable", async () => {
		const unavailable: TerminalDriver = {
			id: "unavailable",
			available: () => false,
			async spawn() {},
		};
		const ready: TerminalDriver = {
			id: "ready",
			available: () => true,
			async spawn() {},
		};
		registerTerminalDriver(unavailable);
		registerTerminalDriver(ready);
		expect((await resolveDriver("unavailable"))?.id).toBe("ready");
	});

	it("returns undefined when nothing is available", async () => {
		const unavailable: TerminalDriver = {
			id: "u",
			available: () => false,
			async spawn() {},
		};
		registerTerminalDriver(unavailable);
		expect(await resolveDriver()).toBeUndefined();
	});

	it("the built-in fallback driver is always available", async () => {
		registerBuiltinTerminalDrivers();
		const driver = await resolveDriver("fallback");
		expect(driver?.id).toBe("fallback");
	});
});

describe("spawnTerminal", () => {
	it("dispatches through the chosen driver", async () => {
		const fakeSpawn = vi.fn(async () => {});
		const fake: TerminalDriver = {
			id: "fake",
			available: () => true,
			spawn: fakeSpawn,
		};
		registerTerminalDriver(fake);
		await spawnTerminal({ layout: "tab", command: "echo hi" });
		expect(fakeSpawn).toHaveBeenCalledOnce();
		expect(fakeSpawn).toHaveBeenCalledWith({
			layout: "tab",
			command: "echo hi",
		});
	});

	it("throws when no driver is available", async () => {
		await expect(
			spawnTerminal({ layout: "tab", command: "x" }),
		).rejects.toThrow(/No terminal driver/);
	});
});

describe("fallback driver", () => {
	it("writes the request to stderr", async () => {
		registerBuiltinTerminalDrivers();
		const driver = getTerminalDriver("fallback");
		expect(driver).toBeDefined();
		const writes: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await driver?.spawn({
				layout: "tab",
				command: "echo hi",
				cwd: "/tmp",
				title: "Hi",
			});
		} finally {
			process.stderr.write = original;
		}
		const all = writes.join("");
		expect(all).toContain("would have opened tab");
		expect(all).toContain("/tmp");
		expect(all).toContain("echo hi");
	});
});
