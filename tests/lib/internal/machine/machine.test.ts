/**
 * This machine's name, as its realm's other machines say it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isMachineName,
	thisMachine,
	thisMachineOff,
	thisMachineRead,
} from "../../../../lib/internal/machine/machine.ts";

let state: string;

beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "machine-"));
});

afterEach(() => {
	rmSync(state, { recursive: true, force: true });
});

/** An environment whose mycelium node recorded `name`, or none. */
const recorded = (name?: string): NodeJS.ProcessEnv => {
	if (name !== undefined) {
		mkdirSync(join(state, "mycelium"), { recursive: true });
		writeFileSync(join(state, "mycelium", "machine"), name);
	}
	return { XDG_STATE_HOME: state };
};

describe("this machine's name", () => {
	it("is its hostname's first label where no node has named it", () => {
		expect(thisMachine(recorded(), "penelope.local")).toBe("penelope");
		expect(thisMachine(recorded(), "aquifer")).toBe("aquifer");
	});

	// KP0L6A, mycelium #204: a node goes by --machine, else what it
	// recorded, else the hostname, so a carry's handover folder has to
	// be named as the node names the machine.
	it("is the name its mycelium node recorded, over the hostname", () => {
		expect(thisMachine(recorded("kestrel\n"), "box-42.lan")).toBe("kestrel");
	});

	it("is the hostname's when the record can't name a machine", () => {
		expect(thisMachine(recorded("../osprey"), "tern.local")).toBe("tern");
		expect(thisMachine(recorded("  \n"), "tern.local")).toBe("tern");
	});

	it("is read off the thread as on it, failing only where a record there can't be read", async () => {
		const failing = (code: string) => () =>
			Promise.reject(Object.assign(new Error(code), { code }));
		const env = { XDG_STATE_HOME: state };
		const kept = (path: string) =>
			path === join(state, "mycelium", "machine")
				? Promise.resolve("kestrel\n")
				: Promise.reject(new Error(`read ${path}`));

		expect(await thisMachineOff(kept, env, "box-42.lan")).toBe("kestrel");
		expect(
			await thisMachineOff(failing("ENOENT"), env, "penelope.local"),
			"no node has named it",
		).toBe("penelope");
		expect(
			await thisMachineOff(failing("ENOTDIR"), env, "penelope.local"),
			"a file where its folder goes holds no record either",
		).toBe("penelope");
		await expect(
			thisMachineOff(failing("EIO"), env, "penelope.local"),
			"a record there but unread may name another machine",
		).rejects.toThrow("EIO");
		for (const said of ["", "  \n", "../osprey"]) {
			await expect(
				thisMachineOff(() => Promise.resolve(said), env, "penelope.local"),
				`a record naming no machine (${JSON.stringify(said)}) is no hostname's`,
			).rejects.toThrow("it names no machine");
		}
	});

	it("fails on the thread too where the record names no machine", () => {
		expect(
			() => thisMachineRead(recorded("  \n"), "penelope.local"),
			"half written",
		).toThrow("it names no machine");
		expect(() => thisMachineRead(recorded("../osprey"), "tern.local")).toThrow(
			"it names no machine",
		);
	});

	it("is read on the thread as off it by thisMachineRead, failing where a record there can't be read", () => {
		expect(thisMachineRead(recorded("kestrel\n"), "box-42.lan")).toBe(
			"kestrel",
		);
		rmSync(join(state, "mycelium"), { recursive: true });
		expect(thisMachineRead(recorded(), "penelope.local"), "none named it").toBe(
			"penelope",
		);
		writeFileSync(join(state, "mycelium"), "a file where its folder goes");
		expect(thisMachineRead(recorded(), "penelope.local")).toBe("penelope");
		rmSync(join(state, "mycelium"));
		mkdirSync(join(state, "mycelium", "machine"), { recursive: true });
		expect(
			() => thisMachineRead(recorded(), "penelope.local"),
			"a record there but unread may name another machine",
		).toThrow("EISDIR");
	});

	it("takes only what can be a folder's name and a word on a command line", () => {
		const names: unknown[] = ["penelope", "mac-mini.lan"];
		const refused: unknown[] = ["-o", "../penelope", "..", "", 7];
		expect(names.filter((name) => !isMachineName(name))).toEqual([]);
		expect(refused.filter((name) => isMachineName(name))).toEqual([]);
	});
});
