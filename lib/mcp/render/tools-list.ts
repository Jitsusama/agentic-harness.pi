import type { ToolMode } from "../surface/policy.js";

/** One tool as it appears in a discovery listing. */
export interface DiscoveryEntry {
	name: string;
	backend: string;
	mode: ToolMode;
	summary?: string;
}

/** A backend's tools in a discovery listing, with any folded-away remainder counted. */
export interface DiscoverySection {
	backend: string;
	hint?: string;
	tools: Array<{ name: string; mode: ToolMode; summary?: string }>;
	overflow: number;
}

/** The badge shown beside a tool for its registration mode; disabled tools are unbadged. */
export function modeBadge(mode: ToolMode): string {
	if (mode === "progressive") return "[progressive]";
	if (mode === "direct") return "[direct]";
	return "";
}

/**
 * Group entries into backend sections, sorted by backend then tool name, with a
 * per-backend limit folding the remainder into an overflow count and an
 * optional hint attached per backend.
 */
export function buildDiscoverySections(
	entries: DiscoveryEntry[],
	opts: { perBackendLimit?: number; hints?: Record<string, string> } = {},
): DiscoverySection[] {
	const byBackend = new Map<string, DiscoveryEntry[]>();
	for (const entry of entries) {
		const list = byBackend.get(entry.backend);
		if (list) list.push(entry);
		else byBackend.set(entry.backend, [entry]);
	}

	return [...byBackend.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([backend, list]) => {
			const sorted = list.sort((a, b) => a.name.localeCompare(b.name));
			const shown = opts.perBackendLimit
				? sorted.slice(0, opts.perBackendLimit)
				: sorted;
			return {
				backend,
				hint: opts.hints?.[backend],
				tools: shown.map((entry) => ({
					name: entry.name,
					mode: entry.mode,
					summary: entry.summary,
				})),
				overflow: sorted.length - shown.length,
			};
		});
}

/** Format discovery sections as a compact markdown listing for the model to read. */
export function renderToolDiscovery(sections: DiscoverySection[]): string {
	return sections
		.map((section) => {
			const total = section.tools.length + section.overflow;
			const header = `### ${section.backend} (${total} tools)${section.hint ? ` — ${section.hint}` : ""}`;
			const lines = section.tools.map((tool) => {
				const badge = modeBadge(tool.mode);
				const summary = tool.summary ? ` — ${tool.summary}` : "";
				return `- ${tool.name}${badge ? ` ${badge}` : ""}${summary}`;
			});
			if (section.overflow > 0) lines.push(`- … +${section.overflow} more`);
			return [header, ...lines].join("\n");
		})
		.join("\n\n");
}
