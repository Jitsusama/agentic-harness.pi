/**
 * The first run after a reload waits for the MCP servers the session
 * had, so its prompt and tools read as they did before the reload.
 */

import { describe, expect, it } from "vitest";
import {
	serversRegistered,
	serversTheSessionHad,
	untilServersReturn,
} from "../../../extensions/loadout-workflow/servers.ts";

const SECTION = [
	"MCP servers whose tools are not declared to you.",
	"- mcp__tool_gateway (codemode): IMPORTANT: call slack_who_am_i first.",
	"- mcp__docs (tool_search)",
].join("\n");

function system(fields: Record<string, unknown>) {
	return {
		type: "message",
		message: { role: "system", content: "", ...fields },
	};
}

describe("the servers a session had", () => {
	it("are the ones its latest servers section lists", () => {
		const branch = [
			system({ sections: { preamble: "You are pi.", mcp_servers: SECTION } }),
			{ type: "message", message: { role: "user", content: "hi" } },
		];

		expect(serversTheSessionHad(branch)).toEqual([
			"mcp__docs",
			"mcp__tool_gateway",
		]);
	});

	it("are none once the section was taken away", () => {
		const branch = [
			system({ sections: { mcp_servers: SECTION } }),
			system({ sections: { mcp_servers: null } }),
		];

		expect(serversTheSessionHad(branch)).toEqual([]);
	});

	it("include the server of a tool it still had declared", () => {
		const branch = [
			system({
				toolsAdded: [
					{ name: "read" },
					{ name: "mcp__jira__search" },
					{ name: "mcp__wiki__page" },
				],
			}),
			system({ toolsRemoved: [{ name: "mcp__wiki__page" }] }),
		];

		expect(serversTheSessionHad(branch)).toEqual(["mcp__jira"]);
	});

	it("are none for a session that never had one", () => {
		expect(
			serversTheSessionHad([system({ toolsAdded: [{ name: "bash" }] })]),
		).toEqual([]);
	});
});

describe("the servers registered now", () => {
	it("are the MCP servers with a tool, by name or by namespace", () => {
		const registered = serversRegistered([
			{ name: "bash" },
			{ name: "mcp__jira__search" },
			{ name: "page", namespace: { name: "mcp__wiki" } },
			{ name: "browser_go", namespace: { name: "browser" } },
		]);

		expect([...registered].sort()).toEqual(["mcp__jira", "mcp__wiki"]);
	});
});

describe("waiting for the servers to return", () => {
	it("ends once every server wanted has registered", async () => {
		const answers = [new Set<string>(), new Set(["mcp__jira"])];
		let asked = 0;
		const registered = () =>
			answers[Math.min(asked++, answers.length - 1)] ?? new Set();

		const missing = await untilServersReturn(["mcp__jira"], registered);

		expect(missing).toEqual([]);
		expect(asked).toBe(2);
	});

	it("gives up when the time is spent, naming what never came", async () => {
		const missing = await untilServersReturn(
			["mcp__jira", "mcp__wiki"],
			() => new Set(["mcp__wiki"]),
			0,
		);

		expect(missing).toEqual(["mcp__jira"]);
	});
});
