import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearTerminalDrivers,
	getLivenessProvider,
	registerTerminalDriver,
	type TerminalDriver,
	type TerminalLivenessCapability,
} from "../../../lib/terminal/index";

const spawnOnly: TerminalDriver = {
	id: "spawn-only",
	available: () => true,
	spawn: async () => {},
};

const livenessCapable: TerminalDriver & TerminalLivenessCapability = {
	id: "with-liveness",
	available: () => true,
	spawn: async () => {},
	identifyCurrent: () => undefined,
	probe: async () => new Map(),
};

beforeEach(() => {
	clearTerminalDrivers();
});
afterEach(() => {
	clearTerminalDrivers();
});

describe("getLivenessProvider", () => {
	it("returns the driver when it implements the liveness capability", () => {
		registerTerminalDriver(livenessCapable);
		expect(getLivenessProvider("with-liveness")).toBe(livenessCapable);
	});

	it("returns undefined for a spawn-only driver", () => {
		registerTerminalDriver(spawnOnly);
		expect(getLivenessProvider("spawn-only")).toBeUndefined();
	});

	it("returns undefined for an unregistered id", () => {
		expect(getLivenessProvider("nope")).toBeUndefined();
	});

	it("resolves strictly by the given id, not the first capable driver", () => {
		registerTerminalDriver(spawnOnly);
		registerTerminalDriver(livenessCapable);
		expect(getLivenessProvider("spawn-only")).toBeUndefined();
	});
});
