/**
 * The actions a tool's schema offers on its `action` property, read from
 * its source for the gates that hold each action to a guide.
 *
 * Three spellings, since the tools differ: a union of typebox literals, a
 * string enum given its list inline (`StringEnum([...] as const`), or a
 * string enum given a list named above the tool (work's `WORK_ACTIONS`).
 * The enum takes a third of the characters every session sends every
 * turn (#1370), and reading only the union made both gates find nothing.
 *
 * Scoped to the action property's own list rather than every literal in
 * the file, which would sweep up diff sides, verdicts and label modes and
 * demand the guide show each as an action.
 */
export function schemaActions(source: string): readonly string[] {
	const start = source.search(/\baction: (?:Type\.|StringEnum\()/);
	if (start < 0) return [];
	const rest = source.slice(start);
	const named =
		/^action: (?:Type\.Optional\(\s*)?StringEnum\(\s*([A-Z_]+)\b/.exec(
			rest,
		)?.[1];
	const list = named === undefined ? firstList(rest) : namedList(source, named);
	const found = new Set<string>();
	for (const quoted of list.matchAll(/"([a-zA-Z-]+)"/g)) {
		const action = quoted.at(1);
		if (action !== undefined) found.add(action);
	}
	return [...found];
}

/** The first `[...]` list in `text`, or nothing when it holds none. */
function firstList(text: string): string {
	const open = text.indexOf("[");
	if (open < 0) return "";
	const close = text.indexOf("]", open);
	return text.slice(open, close < 0 ? undefined : close);
}

/** The list the constant `name` holds in `source`, or nothing. */
function namedList(source: string, name: string): string {
	return new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(source)?.[1] ?? "";
}
