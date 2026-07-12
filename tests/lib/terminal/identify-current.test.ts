import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearTerminalDrivers,
	identifyCurrentTerminal,
	registerTerminalDriver,
	type TerminalDriver,
	type TerminalLivenessCapability,
	type TerminalSessionHandle,
} from "../../../lib/terminal/index";

const HANDLE: TerminalSessionHandle = {
	driverId: "fake",
	kind: "fake-pane",
	hostId: "host-a",
	scope: "/sock/1",
	value: "5",
};

function driver(
	id: string,
	current: TerminalSessionHandle | undefined,
): TerminalDriver & TerminalLivenessCapability {
	return {
		id,
		available: () => true,
		spawn: async () => {},
		identifyCurrent: () => current,
		probe: async () => new Map(),
	};
}

beforeEach(() => clearTerminalDrivers());
afterEach(() => clearTerminalDrivers());

describe("identifyCurrentTerminal", () => {
	it("returns the handle from the first driver that identifies a surface", () => {
		registerTerminalDriver(driver("blind", undefined));
		registerTerminalDriver(driver("fake", HANDLE));
		expect(identifyCurrentTerminal()).toEqual(HANDLE);
	});

	it("returns undefined when no driver identifies a surface", () => {
		registerTerminalDriver(driver("blind", undefined));
		expect(identifyCurrentTerminal()).toBeUndefined();
	});
});
