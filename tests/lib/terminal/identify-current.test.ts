import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSession } from "../../../lib/core/session/index.ts";
import {
	clearTerminalDrivers,
	identifyCurrentTerminal,
	registerTerminalDriver,
	type TerminalDriver,
	type TerminalLivenessCapability,
	type TerminalSessionHandle,
} from "../../../lib/terminal/index.ts";
import { installTestHost } from "../../support/session-host.ts";

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

	it("names no terminal for a conversation in a host, whose surroundings are the host's", () => {
		registerTerminalDriver(driver("fake", HANDLE));
		const host = installTestHost();
		try {
			expect(withSession("a", identifyCurrentTerminal)).toBeUndefined();
			expect(withSession("b", identifyCurrentTerminal)).toBeUndefined();
		} finally {
			host.dispose();
		}
		expect(identifyCurrentTerminal()).toEqual(HANDLE);
	});
});
