/**
 * What a heap snapshot holds, by kind, so two processes' heaps can be
 * told apart: the bytes of each node type, of each constructor or code
 * name within it, and of the source each loaded script keeps, by the
 * package its file sits in.
 *
 * Reads the snapshot format V8's HeapProfiler writes, whose meta says
 * the fields of each node and edge; self sizes only, so every byte is
 * counted once.
 */

/** A heap snapshot as V8 writes it, as far as this reads one. */
interface Snapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			edge_fields: string[];
			node_types: [string[], ...unknown[]];
			edge_types: [string[], ...unknown[]];
		};
	};
	nodes: number[];
	edges: number[];
	strings: string[];
}

/** Bytes and nodes counted under one key. */
export interface Tally {
	bytes: number;
	count: number;
}

/** A heap's bytes three ways. */
export interface HeapKinds {
	/** By node type: object, string, code, closure and the rest. */
	types: Map<string, Tally>;
	/** By node type and name: an object's constructor, a code's function. */
	names: Map<string, Tally>;
	/** Script source bytes by the package the script's file sits in. */
	sources: Map<string, Tally>;
}

/** How long a name may run as a key before it is cut. */
const NAME_CHARS = 60;

/** A harness file's top folder and the one in it. */
const HARNESS_FOLDER = /\/(extensions|lib|host|core)\/([^/]+)\//;

/** Count `json`, a heap snapshot, by kind. */
export function heapKinds(json: string): HeapKinds {
	const parsed: Snapshot = JSON.parse(json);
	const { meta } = parsed.snapshot;
	const nodeWidth = meta.node_fields.length;
	const edgeWidth = meta.edge_fields.length;
	const typeAt = meta.node_fields.indexOf("type");
	const nameAt = meta.node_fields.indexOf("name");
	const sizeAt = meta.node_fields.indexOf("self_size");
	const edgesAt = meta.node_fields.indexOf("edge_count");
	const edgeTypeAt = meta.edge_fields.indexOf("type");
	const edgeNameAt = meta.edge_fields.indexOf("name_or_index");
	const toAt = meta.edge_fields.indexOf("to_node");
	const nodeTypes = meta.node_types[0];
	const edgeTypes = meta.edge_types[0];
	const { nodes, edges, strings } = parsed;
	const count = nodes.length / nodeWidth;
	const type = (n: number) =>
		nodeTypes[nodes[n * nodeWidth + typeAt] ?? 0] ?? "";
	const name = (n: number) => strings[nodes[n * nodeWidth + nameAt] ?? 0] ?? "";
	const size = (n: number) => nodes[n * nodeWidth + sizeAt] ?? 0;

	const kinds: HeapKinds = {
		types: new Map(),
		names: new Map(),
		sources: new Map(),
	};
	let edge = 0;
	for (let n = 0; n < count; n++) {
		const kind = type(n);
		const bytes = size(n);
		add(kinds.types, kind, bytes);
		add(kinds.names, `${kind} ${keyName(kind, name(n))}`, bytes);
		const first = edge;
		edge += (nodes[n * nodeWidth + edgesAt] ?? 0) * edgeWidth;
		// V8 has named a script's node "system / Script" and, in Node 24,
		// after its file, so a script is known by its shape: code with a
		// string for its source.
		if (kind !== "code") continue;
		let file = "";
		let source: number | undefined;
		for (let e = first; e < edge; e += edgeWidth) {
			const edgeKind = edgeTypes[edges[e + edgeTypeAt] ?? 0];
			if (edgeKind === "element" || edgeKind === "hidden") continue;
			const label = strings[edges[e + edgeNameAt] ?? 0];
			const to = (edges[e + toAt] ?? 0) / nodeWidth;
			if (label === "name") file = name(to);
			else if (label === "source" && type(to).includes("string"))
				source = size(to);
		}
		if (source !== undefined) add(kinds.sources, packageOf(file), source);
	}
	return kinds;
}

/**
 * The lines that say where `ours` differs from `theirs`, the largest
 * differences first: each kind's bytes on both sides and the change.
 */
export function heapDifference(
	ours: Map<string, Tally>,
	theirs: Map<string, Tally>,
	most: number,
): string[] {
	const keys = new Set([...ours.keys(), ...theirs.keys()]);
	return [...keys]
		.map((key) => {
			const a = ours.get(key) ?? { bytes: 0, count: 0 };
			const b = theirs.get(key) ?? { bytes: 0, count: 0 };
			return { key, a, b, change: a.bytes - b.bytes };
		})
		.sort((x, y) => Math.abs(y.change) - Math.abs(x.change))
		.slice(0, most)
		.map(
			({ key, a, b, change }) =>
				`${megabytes(change)} ${key}: ${megabytes(a.bytes)} in ${a.count} against ${megabytes(b.bytes)} in ${b.count}`,
		);
}

/** The total bytes of `tallies`. */
export function totalOf(tallies: Map<string, Tally>): number {
	let total = 0;
	for (const { bytes } of tallies.values()) total += bytes;
	return total;
}

/** `bytes` in MB, signed when negative, to two places. */
export function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Count `bytes` under `key` in `tallies`. */
function add(tallies: Map<string, Tally>, key: string, bytes: number): void {
	const was = tallies.get(key);
	if (was) {
		was.bytes += bytes;
		was.count++;
	} else tallies.set(key, { bytes, count: 1 });
}

/**
 * A node's name as a key: strings are their own text, so they count by
 * their size alone; any other name is cut to its first characters.
 */
function keyName(kind: string, name: string): string {
	if (kind.includes("string")) return "";
	return name.slice(0, NAME_CHARS).replaceAll("\n", " ");
}

/**
 * The package a script's file sits in: the last node_modules folder's
 * package, scoped ones whole, else a harness folder and the one in it,
 * such as `extensions/quest`, else node's own modules, else the last two
 * folders.
 */
function packageOf(file: string): string {
	const modules = file.lastIndexOf("node_modules/");
	if (modules >= 0) {
		const parts = file.slice(modules + "node_modules/".length).split("/");
		const scoped = parts[0]?.startsWith("@") ?? false;
		return `npm ${parts.slice(0, scoped ? 2 : 1).join("/")}`;
	}
	const harness = HARNESS_FOLDER.exec(file);
	if (harness) return `harness ${harness[1]}/${harness[2]}`;
	if (file.startsWith("node:") || !file.includes("/")) return "node";
	const parts = file.split("/");
	return `file ${parts.slice(-3, -1).join("/")}`;
}
