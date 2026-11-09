/** Count direct process/session-state shortcuts, ignoring comments and strings. */
import { parse } from "@babel/parser";

type Site = "pid" | "cwd" | "global" | "env-write";
type Node = Record<string, unknown> & { type: string };

function node(value: unknown): value is Node {
	return (
		!!value &&
		typeof value === "object" &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function named(value: unknown, name: string): boolean {
	return node(value) && value.type === "Identifier" && value.name === name;
}

function property(
	value: unknown,
): { base: unknown; name: unknown } | undefined {
	if (
		!node(value) ||
		!["MemberExpression", "OptionalMemberExpression"].includes(value.type)
	)
		return;
	if (!node(value.property)) return;
	return {
		base: value.object,
		name: value.computed ? value.property.value : value.property.name,
	};
}

function processEnv(value: unknown): boolean {
	const prop = property(value);
	return !!prop && named(prop.base, "process") && prop.name === "env";
}

function environmentTarget(value: unknown): boolean {
	const prop = property(value);
	return processEnv(value) || (!!prop && processEnv(prop.base));
}

/** Counts per kind: new sites may not hide behind a comment or string match. */
export function processSessionSites(source: string): Map<Site, number> {
	const file = parse(source, {
		sourceType: "unambiguous",
		plugins: ["typescript"],
	});
	const counts = new Map<Site, number>();
	const add = (site: Site) => counts.set(site, (counts.get(site) ?? 0) + 1);
	function visit(value: unknown): void {
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}
		if (!node(value)) return;
		const prop = property(value);
		if (prop && named(prop.base, "process") && prop.name === "pid") add("pid");
		if (["CallExpression", "OptionalCallExpression"].includes(value.type)) {
			const call = property(value.callee);
			if (call && named(call.base, "process") && call.name === "cwd")
				add("cwd");
			if (
				named(value.callee, "processGlobal") ||
				(call && named(call.base, "Symbol") && call.name === "for")
			)
				add("global");
		}
		if (prop && named(prop.base, "globalThis")) add("global");
		if (
			(value.type === "AssignmentExpression" &&
				environmentTarget(value.left)) ||
			(value.type === "UpdateExpression" &&
				environmentTarget(value.argument)) ||
			(value.type === "UnaryExpression" &&
				value.operator === "delete" &&
				environmentTarget(value.argument))
		)
			add("env-write");
		for (const child of Object.values(value)) visit(child);
	}
	visit(file);
	return counts;
}
