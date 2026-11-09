/**
 * MCP servers kept across a reload, which pi itself drops when an
 * extension registered them as it loaded.
 */

import { afterEach, describe, expect, it } from "vitest";
import { keepMcpServersAcrossReloads } from "../../../extensions/reload-workflow/mcp.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { installTestHost } from "../../support/session-host.ts";

type Handler = (event: { reason: string }, ctx: unknown) => Promise<void>;

/** One runtime's pi for conversation `id`: its handlers and its servers. */
function runtime(servers: { name: string; config: object }[], id = "a") {
	const handlers = new Map<string, Handler>();
	const registered: string[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getMcpServers: () => servers.map((one) => ({ ...one, extensionPath: "x" })),
		registerMcpServer: (name: string, config: object) => {
			registered.push(name);
			servers.push({ name, config });
		},
	};
	keepMcpServersAcrossReloads(pi as never);
	const ctx = { sessionManager: { getSessionId: () => id } };
	// Inside its conversation, as a host runs every hook.
	const fire = (event: string, reason: string) =>
		withSession(id, async () => handlers.get(event)?.({ reason }, ctx));
	return { fire, registered, servers };
}

const GATEWAY = { name: "tool-gateway", config: { url: "https://gw/mcp" } };

describe("MCP servers across a reload", () => {
	it("registers again what the reload lost, as it was", async () => {
		const before = runtime([GATEWAY]);
		await before.fire("session_shutdown", "reload");
		const after = runtime([]);
		await after.fire("session_start", "reload");

		expect(after.registered).toEqual(["tool-gateway"]);
		expect(after.servers).toEqual([GATEWAY]);
	});

	it("leaves a server the reload kept, and keeps nothing past a quit", async () => {
		const before = runtime([GATEWAY]);
		await before.fire("session_shutdown", "reload");
		const kept = runtime([{ ...GATEWAY }]);
		await kept.fire("session_start", "reload");
		expect(kept.registered).toEqual([]);

		await runtime([GATEWAY]).fire("session_shutdown", "quit");
		const fresh = runtime([]);
		await fresh.fire("session_start", "startup");
		expect(fresh.registered).toEqual([]);
	});
});

describe("MCP servers across a reload in a host", () => {
	let host: ReturnType<typeof installTestHost> | undefined;
	afterEach(() => {
		host?.dispose();
		host = undefined;
	});

	it("keeps them for the conversation that reloaded, whatever another does between", async () => {
		host = installTestHost();
		await runtime([GATEWAY], "a").fire("session_shutdown", "reload");

		// B starting, or reloading, in between takes nothing of A's.
		const b = runtime([], "b");
		await b.fire("session_start", "startup");
		await b.fire("session_start", "reload");
		const after = runtime([], "a");
		await after.fire("session_start", "reload");

		expect(b.registered, "B never registers A's servers").toEqual([]);
		expect(after.registered, "A gets its own back").toEqual(["tool-gateway"]);
	});
});
