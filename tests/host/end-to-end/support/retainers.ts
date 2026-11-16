/**
 * What keeps a module's code alive in a heap snapshot: the scripts whose
 * name holds a mark, such as an install version's folder, and for each
 * the shortest chain of strong references from the heap's roots to it,
 * so a case whose old code outlives a reload names what holds it.
 *
 * Reads the snapshot format V8's HeapProfiler writes, whose meta says
 * the fields of each node and edge.
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

/** Roots whose holding a script is V8's own caching, not the program's. */
const CACHES = ["(Compilation cache", "(Internalized strings"];

/** How many of a chain's last steps belong to the one script it holds. */
const TAIL_STEPS = 3;

/** How long a node's name may run in a chain before it is cut. */
const NAME_CHARS = 80;

/**
 * For the scripts named with `mark` in `json`, how many there are, how
 * many the program holds, and the commonest chains holding them, up to
 * `most`, each with how many scripts it holds.
 */
export function retainersOf(json: string, mark: string, most = 5): string[] {
	const parsed: Snapshot = JSON.parse(json);
	const { meta } = parsed.snapshot;
	const nodeWidth = meta.node_fields.length;
	const edgeWidth = meta.edge_fields.length;
	const typeAt = meta.node_fields.indexOf("type");
	const nameAt = meta.node_fields.indexOf("name");
	const edgesAt = meta.node_fields.indexOf("edge_count");
	const edgeTypeAt = meta.edge_fields.indexOf("type");
	const edgeNameAt = meta.edge_fields.indexOf("name_or_index");
	const toAt = meta.edge_fields.indexOf("to_node");
	const nodeTypes = meta.node_types[0];
	const edgeTypes = meta.edge_types[0];
	const { nodes, edges, strings } = parsed;
	const count = nodes.length / nodeWidth;
	const firstEdge = new Uint32Array(count + 1);
	for (let n = 0; n < count; n++) {
		firstEdge[n + 1] =
			(firstEdge[n] ?? 0) + (nodes[n * nodeWidth + edgesAt] ?? 0) * edgeWidth;
	}
	const type = (n: number) => nodeTypes[nodes[n * nodeWidth + typeAt] ?? 0];
	const name = (n: number) => strings[nodes[n * nodeWidth + nameAt] ?? 0] ?? "";
	const edgeType = (e: number) => edgeTypes[edges[e + edgeTypeAt] ?? 0];
	const edgeName = (e: number) => {
		const raw = edges[e + edgeNameAt] ?? 0;
		const kind = edgeType(e);
		return kind === "element" || kind === "hidden"
			? `[${raw}]`
			: (strings[raw] ?? "");
	};
	const target = (e: number) => (edges[e + toAt] ?? 0) / nodeWidth;

	const marked = new Set<number>();
	for (let n = 0; n < count; n++) {
		if (type(n) === "string" && name(n).includes(mark)) marked.add(n);
	}
	const scripts: number[] = [];
	for (let n = 0; n < count; n++) {
		const kind = type(n);
		if (kind === "string" || kind === "concatenated string") continue;
		for (
			let e = firstEdge[n] ?? 0;
			e < (firstEdge[n + 1] ?? 0);
			e += edgeWidth
		) {
			if (edgeName(e) === "name" && marked.has(target(e))) {
				scripts.push(n);
				break;
			}
		}
	}

	const parentEdge = new Int32Array(count).fill(-1);
	const parent = new Int32Array(count).fill(-1);
	const seen = new Uint8Array(count);
	seen[0] = 1;
	let queue = [0];
	while (queue.length > 0) {
		const next: number[] = [];
		for (const n of queue) {
			if (CACHES.some((cache) => name(n).startsWith(cache))) continue;
			for (
				let e = firstEdge[n] ?? 0;
				e < (firstEdge[n + 1] ?? 0);
				e += edgeWidth
			) {
				if (edgeType(e) === "weak") continue;
				const to = target(e);
				if (seen[to]) continue;
				seen[to] = 1;
				parent[to] = n;
				parentEdge[to] = e;
				next.push(to);
			}
		}
		queue = next;
	}

	const chains = new Map<string, { times: number; tail: string }>();
	let held = 0;
	for (const script of scripts) {
		if (!seen[script]) continue;
		held++;
		const steps: string[] = [];
		for (let n = script; n > 0 && (parent[n] ?? -1) >= 0; n = parent[n] ?? -1) {
			const via = edgeName(parentEdge[n] ?? 0);
			const own = name(n).slice(0, NAME_CHARS).replaceAll("\n", " ");
			steps.unshift(`-${via}-> ${type(n)} ${own}`);
		}
		// The last steps name the script and its own functions, which differ
		// between scripts one holder keeps, so chains are told apart above them.
		const tail = steps.splice(-TAIL_STEPS).join("\n    ");
		const chain = steps.join("\n  ");
		const was = chains.get(chain);
		chains.set(chain, {
			times: (was?.times ?? 0) + 1,
			tail: was?.tail ?? tail,
		});
	}
	const commonest = [...chains.entries()]
		.sort((a, b) => b[1].times - a[1].times)
		.slice(0, most)
		.map(
			([chain, { times, tail }]) =>
				`${times} script(s) held by:\n  ${chain}\n  as one:\n    ${tail}`,
		);
	return [
		`${scripts.length} script(s) named with ${mark}, ${held} held past V8's caches`,
		...commonest,
	];
}
