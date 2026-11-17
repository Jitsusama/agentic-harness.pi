/**
 * This machine's name, as its realm's other machines say it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMachineName, thisMachine } from "../../../../lib/internal/machine/machine.ts";

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

	it("takes only what can be a folder's name and a word on a command line", () => {
		const names: unknown[] = ["penelope", "mac-mini.lan"];
		const refused: unknown[] = ["-o", "../penelope", "..", "", 7];
		expect(names.filter((name) => !isMachineName(name))).toEqual([]);
		expect(refused.filter((name) => isMachineName(name))).toEqual([]);
	});
});
