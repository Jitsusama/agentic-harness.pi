/** Count direct process/session-state shortcuts, ignoring comments and strings. */
import { parse } from "@babel/parser";

type Site = "pid" | "cwd" | "global" | "env-write" | "module";
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

/**
 * A module's own state: a top-level `let`, or a top-level map or set named
 * as a variable rather than a constant. pi caches a module by path while
 * the folder stays the same, so every conversation a host opens in one
 * folder shares it, and what one writes there the next reads or wipes.
 */
function moduleState(statement: unknown): number {
	const declared =
		node(statement) && statement.type === "ExportNamedDeclaration"
			? statement.declaration
			: statement;
	if (!node(declared) || declared.type !== "VariableDeclaration") return 0;
	const declarators = Array.isArray(declared.declarations)
		? declared.declarations
		: [];
	if (declared.kind === "let") return declarators.length;
	if (declared.kind !== "const") return 0;
	return declarators.filter(
		(declarator) =>
			node(declarator) &&
			node(declarator.id) &&
			typeof declarator.id.name === "string" &&
			/^[a-z]/.test(declarator.id.name) &&
			node(declarator.init) &&
			declarator.init.type === "NewExpression" &&
			(named(declarator.init.callee, "Map") ||
				named(declarator.init.callee, "Set")),
	).length;
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
	for (const statement of file.program.body)
		for (let n = moduleState(statement); n > 0; n -= 1) add("module");
	return counts;
}
