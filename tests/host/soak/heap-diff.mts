// Scratch: what grew between the first and last parked heap snapshots.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "";
const files = readdirSync(dir)
	.filter((name) => name.endsWith(".heapsnapshot"))
	.sort();
// Weighed awake, parked at once and parked 15 s on at each checkpoint: the
// last of each three is the settled park.
const parked = files.filter((_, at) => at % 3 === 2);
console.log(`snapshots ${files.join(" ")}; parked ${parked.join(" ")}`);

type Snap = {
	nodes: number[];
	edges: number[];
	strings: string[];
	nodeFields: string[];
	edgeFields: string[];
	nodeTypes: string[];
	edgeTypes: string[];
};

function load(file: string): Snap {
	const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
	const meta = raw.snapshot.meta;
	return {
		nodes: raw.nodes,
		edges: raw.edges,
		strings: raw.strings,
		nodeFields: meta.node_fields,
		edgeFields: meta.edge_fields,
		nodeTypes: meta.node_types[0],
		edgeTypes: meta.edge_types[0],
	};
}

function keyOf(s: Snap, at: number): string {
	const nf = s.nodeFields.length;
	const type = s.nodeTypes[s.nodes[at * nf] ?? 0] ?? "?";
	let name = s.strings[s.nodes[at * nf + 1] ?? 0] ?? "?";
	if (type === "string" || type === "concatenated string" || type === "sliced string")
		name = name.slice(0, 50).replace(/\s+/g, " ");
	return `${type}:${name}`;
}

function tally(s: Snap): Map<string, { count: number; bytes: number }> {
	const nf = s.nodeFields.length;
	const sizeAt = s.nodeFields.indexOf("self_size");
	const out = new Map<string, { count: number; bytes: number }>();
	for (let at = 0; at * nf < s.nodes.length; at++) {
		const key = keyOf(s, at);
		const one = out.get(key) ?? { count: 0, bytes: 0 };
		one.count++;
		one.bytes += s.nodes[at * nf + sizeAt] ?? 0;
		out.set(key, one);
	}
	return out;
}

const first = load(parked[0] ?? "");
const firstTally = tally(first);
first.nodes = [];
first.edges = [];
const last = load(parked.at(-1) ?? "");
const lastTally = tally(last);
const grown = [...lastTally]
	.map(([key, one]) => {
		const was = firstTally.get(key) ?? { count: 0, bytes: 0 };
		return { key, count: one.count - was.count, bytes: one.bytes - was.bytes };
	})
	.sort((a, b) => b.bytes - a.bytes)
	.slice(0, 40);
console.log("=== GROWN (bytes, count, type:name)");
for (const one of grown) console.log(one.bytes, one.count, one.key);

// Retainer paths for a few nodes of the top grown kinds, in the last one.
const nf = last.nodeFields.length;
const ef = last.edgeFields.length;
const edgeCountAt = last.nodeFields.indexOf("edge_count");
const toAt = last.edgeFields.indexOf("to_node");
const typeAt = last.edgeFields.indexOf("type");
const nameAt = last.edgeFields.indexOf("name_or_index");
const nodeCount = last.nodes.length / nf;
const retainers: number[][] = Array.from({ length: nodeCount }, () => []);
const viaEdge: number[][] = Array.from({ length: nodeCount }, () => []);
let edge = 0;
for (let at = 0; at < nodeCount; at++) {
	const count = last.nodes[at * nf + edgeCountAt] ?? 0;
	for (let i = 0; i < count; i++, edge++) {
		const kind = last.edgeTypes[last.edges[edge * ef + typeAt] ?? 0];
		if (kind === "weak") continue;
		const to = (last.edges[edge * ef + toAt] ?? 0) / nf;
		retainers[to]?.push(at);
		viaEdge[to]?.push(edge);
	}
}
function edgeName(e: number): string {
	const kind = last.edgeTypes[last.edges[e * ef + typeAt] ?? 0] ?? "?";
	const name = last.edges[e * ef + nameAt] ?? 0;
	return kind === "element" || kind === "hidden" ? `[${name}]` : (last.strings[name] ?? "?");
}
console.log("=== RETAINERS");
for (const one of grown.slice(0, 8)) {
	const sample: number[] = [];
	for (let at = nodeCount - 1; at >= 0 && sample.length < 2; at--)
		if (keyOf(last, at) === one.key) sample.push(at);
	for (const start of sample) {
		const path: string[] = [keyOf(last, start)];
		const seen = new Set<number>([start]);
		let at = start;
		for (let hop = 0; hop < 14; hop++) {
			const from = retainers[at] ?? [];
			const via = viaEdge[at] ?? [];
			const pick = from.findIndex((r) => !seen.has(r));
			if (pick < 0) break;
			at = from[pick] ?? 0;
			seen.add(at);
			path.push(`<-${edgeName(via[pick] ?? 0)}- ${keyOf(last, at).slice(0, 70)}`);
		}
		console.log(path.join("\n   "));
		console.log("--");
	}
}

// The shortest path from the snapshot's root to each InteractiveMode still
// alive while every conversation is parked: what holds a parked session.
const firstEdge: number[] = new Array(nodeCount).fill(0);
for (let at = 0, e = 0; at < nodeCount; at++) {
	firstEdge[at] = e;
	e += last.nodes[at * nf + edgeCountAt] ?? 0;
}
const parentNode = new Int32Array(nodeCount).fill(-1);
const parentEdge = new Int32Array(nodeCount).fill(-1);
parentNode[0] = 0;
const queue = [0];
for (let head = 0; head < queue.length; head++) {
	const at = queue[head] ?? 0;
	const count = last.nodes[at * nf + edgeCountAt] ?? 0;
	for (let i = 0; i < count; i++) {
		const e = (firstEdge[at] ?? 0) + i;
		const kind = last.edgeTypes[last.edges[e * ef + typeAt] ?? 0];
		if (kind === "weak") continue;
		const to = (last.edges[e * ef + toAt] ?? 0) / nf;
		if (parentNode[to] !== -1) continue;
		parentNode[to] = at;
		parentEdge[to] = e;
		queue.push(to);
	}
}
console.log("=== HELD FROM ROOT");
for (let at = 0; at < nodeCount; at++) {
	const key = keyOf(last, at);
	if (
		key !== "object:InteractiveMode" &&
		key !== "object:SessionManager" &&
		key !== "object:AgentSession"
	)
		continue;
	console.log(`held ${key}`);
	const path: string[] = [];
	for (let on = at; on !== 0 && path.length < 60; on = parentNode[on] ?? 0) {
		if (parentNode[on] === -1) {
			path.push("(unreachable)");
			break;
		}
		path.push(`${keyOf(last, on).slice(0, 90)} <-${edgeName(parentEdge[on] ?? 0)}-`);
	}
	console.log(path.join("\n   "));
	console.log("--");
}
