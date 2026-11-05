import { describe, expect, it } from "vitest";
import { endTarget } from "../../../lib/mesh/end.ts";

const owner = { pid: 4242, startedAt: 1, startTicks: 99 };
const builder = {
	addresses: ["BUILDR"],
	session: "builder-session",
	orchestratedBy: "ORCHST",
	owner,
};
const outsider = {
	addresses: ["OTHERS"],
	session: "other-session",
	orchestratedBy: "ELSEWH",
	owner,
};
const elsewhere = {
	addresses: ["AWAYSS"],
	session: "away-session",
	orchestratedBy: "ORCHST",
	machine: "a-mac",
};
const orchestrator = {
	addresses: ["ORCHST"],
	session: "orchestrator-session",
	owner,
};
const present = [builder, outsider, elsewhere, orchestrator];

const refusal = (address: string, orchestrates?: string) => {
	const target = endTarget(
		orchestrates,
		"orchestrator-session",
		address,
		present,
	);
	return "refused" in target ? target.refused : undefined;
};

describe("ending a session by address", () => {
	it("names the process of a session in this orchestration", () => {
		expect(
			endTarget("ORCHST", "orchestrator-session", "BUILDR", present),
		).toEqual({ address: "BUILDR", session: "builder-session", owner });
	});

	it("is refused to a session playing no orchestrator's role", () => {
		expect(refusal("BUILDR")).toMatch(/only an orchestrator/);
	});

	it("is refused for a session outside it, elsewhere, unknown, or itself", () => {
		expect(refusal("OTHERS", "ORCHST")).toMatch(/not in this orchestration/);
		expect(refusal("AWAYSS", "ORCHST")).toMatch(/runs on a-mac/);
		expect(refusal("NOBODY", "ORCHST")).toMatch(/no session/);
		expect(refusal("ORCHST", "ORCHST")).toMatch(/this session/);
	});
});
