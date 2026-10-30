/**
 * MCP servers kept across a reload. pi applies what an extension
 * registers while it loads only once it binds, and a reload drops those
 * queued registrations: on 30 October every session that reloaded lost
 * the tool gateway, whose extension registers it as it loads, and a
 * session with nothing listed after the reload had nothing to reconnect.
 * So the servers pi lists as a reload begins are kept for the runtime
 * that replaces this one, and any the reload lost are registered again
 * once it lands, which pi connects at once. A server the reload kept is
 * left alone, so this does nothing once pi keeps them itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** What a kept server is registered with again. */
interface Kept {
	readonly name: string;
	readonly config: Parameters<ExtensionAPI["registerMcpServer"]>[1];
}

const KEPT_KEY = Symbol.for("agentic-harness.reload.mcp-servers");

type KeptGlobal = { [KEPT_KEY]?: readonly Kept[] };

/** Keep pi's MCP servers across this session's reloads. */
export function keepMcpServersAcrossReloads(pi: ExtensionAPI): void {
	const global = globalThis as KeptGlobal;
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "reload") return;
		try {
			global[KEPT_KEY] = pi
				.getMcpServers()
				.map(({ name, config }) => ({ name, config }));
		} catch {
			// A runtime that can't list them has none to keep.
			global[KEPT_KEY] = undefined;
		}
	});
	pi.on("session_start", async (event) => {
		const kept = global[KEPT_KEY];
		global[KEPT_KEY] = undefined;
		if (event.reason !== "reload" || !kept) return;
		let here: Set<string>;
		try {
			here = new Set(pi.getMcpServers().map(({ name }) => name));
		} catch {
			// A pi that can't list them can't be told them again either, and
			// the reload's own handlers after this one must still run.
			return;
		}
		for (const { name, config } of kept) {
			if (here.has(name)) continue;
			try {
				pi.registerMcpServer(name, config);
			} catch {
				// Another extension took the name since, or pi refused the
				// config it gave before: that server stays as pi has it.
			}
		}
	});
}
