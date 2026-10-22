/**
 * What a session can load rather than declare: the tools registered
 * with `deferred` exposure, how to name them in a line or two, and
 * which of them a piece of text asks for.
 */

/** A registered tool, as far as the loadout reads one. */
export interface LoadableTool {
	readonly name: string;
	readonly description: string;
	readonly exposure: string;
	readonly namespace?: { readonly name: string; readonly description?: string };
}

/** The most tools of one namespace the index names one by one. */
const MOST_NAMED = 24;

/**
 * The areas a large namespace's tools cover: the first word of each
 * name once the namespace's own prefix is taken off, in the order
 * they first appear.
 */
function areasOf(space: string, members: readonly LoadableTool[]): string[] {
	const areas = new Set<string>();
	for (const tool of members) {
		const bare = tool.name.startsWith(`${space}__`)
			? tool.name.slice(space.length + 2)
			: tool.name;
		const area = bare.split("_")[0];
		if (area) areas.add(area);
	}
	return [...areas];
}

/** The longest a tool's purpose runs in the index. */
const PURPOSE_CHARS = 72;

/** The first sentence of a description, cut to fit a line. */
function purposeOf(description: string): string {
	const first = description.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
	const plain = first.replace(/[.!?]$/, "");
	return plain.length <= PURPOSE_CHARS
		? plain
		: `${plain.slice(0, PURPOSE_CHARS - 1).trimEnd()}…`;
}

/** The deferred tools among `tools` that are not declared now. */
export function loadable(
	tools: readonly LoadableTool[],
	active: ReadonlySet<string>,
): LoadableTool[] {
	return tools.filter(
		(tool) => tool.exposure === "deferred" && !active.has(tool.name),
	);
}

/**
 * The index the model reads, so a tool that is not declared is not
 * forgotten: a namespace on one line with its tools, any other tool on
 * a line of its own. Nothing when there is nothing to load.
 *
 * A namespace of more than `MOST_NAMED` tools is said as a count and
 * the areas its names cover, since `tool_search` finds the one wanted.
 * Naming every tool of the Tool Gateway's MCP server, 306 of them, ran
 * to 17,430 characters on every turn.
 */
export function loadableIndex(
	tools: readonly LoadableTool[],
): string | undefined {
	if (tools.length === 0) return undefined;
	const grouped = new Map<string, LoadableTool[]>();
	const lines: string[] = [];
	for (const tool of tools) {
		const space = tool.namespace?.name;
		if (space === undefined) continue;
		grouped.set(space, [...(grouped.get(space) ?? []), tool]);
	}
	for (const [space, members] of grouped) {
		const about = members[0]?.namespace?.description;
		const head = `- ${space}${about ? ` (${purposeOf(about)})` : ""}`;
		if (members.length <= MOST_NAMED) {
			const names = members.map((tool) => tool.name).join(", ");
			lines.push(`${head}: ${names}`);
			continue;
		}
		const areas = areasOf(space, members).join(", ");
		lines.push(
			`${head}: ${members.length} tools, covering ${areas}. Find one with \`tool_search\`.`,
		);
	}
	for (const tool of tools) {
		if (tool.namespace !== undefined) continue;
		lines.push(`- ${tool.name}: ${purposeOf(tool.description)}`);
	}
	return [
		"## Tools That Load on Demand",
		"",
		"These tools are not declared until a session needs them. Load one with `tool_search` before calling it; reading a skill that names one loads it too.",
		"",
		...lines,
	].join("\n");
}

/**
 * The tools a text names, by whole name, with the rest of any
 * namespace a named tool belongs to, since a skill that names one
 * tool of a set goes on to use the others.
 */
export function namedIn(
	text: string,
	tools: readonly LoadableTool[],
): string[] {
	const named = new Set<string>();
	for (const tool of tools) {
		const name = tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`);
		if (pattern.test(text)) named.add(tool.name);
	}
	const spaces = new Set(
		tools
			.filter((tool) => named.has(tool.name))
			.map((tool) => tool.namespace?.name)
			.filter((space): space is string => space !== undefined),
	);
	for (const tool of tools) {
		if (tool.namespace && spaces.has(tool.namespace.name)) named.add(tool.name);
	}
	return tools.map((tool) => tool.name).filter((name) => named.has(name));
}
