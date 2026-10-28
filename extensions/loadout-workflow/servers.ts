/**
 * The MCP servers a session had before a reload or a restart, and a
 * wait for them to come back before its first run.
 *
 * A reload starts every MCP connection again, and pi builds the first
 * run's prompt without waiting for a server whose tools reach the model
 * through codemode or `tool_search`. So that run's prompt lost the
 * server's one-line summary, the tools loaded from it and its line in
 * the index of tools that load on demand, and the next run put the
 * summary back: each a change to the prompt, and each a cache rewrite.
 * In the week to 28 October, 215 of the 268 times a summary went
 * missing, it went within a minute of a reload or a start. pi keeps a reloaded session's tools pending until its next run
 * starts, so a server that is back by then keeps everything as it was.
 */

/** The longest the first run after a reload waits, as pi waits for its own. */
export const MOST_WAIT_MS = 10_000;

/** How often the wait looks again. */
const EVERY_MS = 100;

/** The prompt section pi lists the servers in. */
const SERVERS_SECTION = "mcp_servers";

/** The start of an MCP tool's name, before its server's part. */
const MCP_PREFIX = "mcp__";

/** A tool as far as the wait reads one. */
export interface RegisteredTool {
	readonly name: string;
	readonly namespace?: { readonly name: string };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function toolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((tool) => {
		const name = recordOf(tool)?.name ?? tool;
		return typeof name === "string" ? [name] : [];
	});
}

/** The server part of an MCP tool's name, such as `mcp__docs`. */
function serverOf(tool: string): string | undefined {
	if (!tool.startsWith(MCP_PREFIX)) return undefined;
	const end = tool.indexOf("__", MCP_PREFIX.length);
	return end > MCP_PREFIX.length ? tool.slice(0, end) : undefined;
}

/** The servers a rendering of pi's `mcp_servers` section lists. */
function serversListed(section: string): string[] {
	return [...section.matchAll(/^- (mcp__[A-Za-z0-9_]+) \(/gm)].flatMap(
		(match) => (match[1] ? [match[1]] : []),
	);
}

/**
 * The MCP servers a branch last had, by namespace: those its latest
 * `mcp_servers` section lists, and those of the tools it last had
 * declared, replayed from the system messages pi records.
 */
export function serversTheSessionHad(entries: readonly unknown[]): string[] {
	let section: string | undefined;
	const declared = new Set<string>();
	for (const entry of entries) {
		const message = recordOf(recordOf(entry)?.message);
		if (recordOf(entry)?.type !== "message" || message?.role !== "system")
			continue;
		const sections = recordOf(message.sections);
		if (sections && SERVERS_SECTION in sections) {
			const value = sections[SERVERS_SECTION];
			section = typeof value === "string" ? value : undefined;
		}
		for (const name of toolNames(message.toolsAdded)) declared.add(name);
		for (const name of toolNames(message.toolsRemoved)) declared.delete(name);
	}
	const servers = new Set(section ? serversListed(section) : []);
	for (const name of declared) {
		const server = serverOf(name);
		if (server) servers.add(server);
	}
	return [...servers].sort();
}

/** The MCP servers with a tool registered now. */
export function serversRegistered(
	tools: readonly RegisteredTool[],
): Set<string> {
	const servers = new Set<string>();
	for (const tool of tools) {
		const server = serverOf(tool.name) ?? tool.namespace?.name;
		if (server?.startsWith(MCP_PREFIX)) servers.add(server);
	}
	return servers;
}

/**
 * Wait until every server wanted has a tool registered, or `mostMs`
 * passes, and answer the ones still missing. A server registers its
 * tools once it has connected, which is also when pi learns its
 * summary.
 */
export async function untilServersReturn(
	wanted: readonly string[],
	registered: () => ReadonlySet<string>,
	mostMs: number = MOST_WAIT_MS,
): Promise<string[]> {
	const missing = () => {
		const now = registered();
		return wanted.filter((server) => !now.has(server));
	};
	const until = Date.now() + mostMs;
	let left = missing();
	while (left.length > 0 && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
		left = missing();
	}
	return left;
}
