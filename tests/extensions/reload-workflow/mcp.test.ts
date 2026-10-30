/**
 * MCP servers kept across a reload, which pi itself drops when an
 * extension registered them as it loaded.
 */

import { describe, expect, it } from "vitest";
import { keepMcpServersAcrossReloads } from "../../../extensions/reload-workflow/mcp.ts";

type Handler = (event: { reason: string }) => Promise<void>;

/** One runtime's pi: its handlers and its registered servers. */
function runtime(servers: { name: string; config: object }[]) {
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
	const fire = (event: string, reason: string) =>
		handlers.get(event)?.({ reason });
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
