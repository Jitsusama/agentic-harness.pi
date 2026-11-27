/**
 * A checkout's commit-graph made to lie, as a session that can write the
 * checkout's objects folder could make it. Git reads a commit's parents
 * from the graph when one is there, not from the commit, and never checks
 * the graph against the commits it names, so a graph naming the head as
 * a parent of main's newest commit makes the head read as merged already:
 * its merge base with main is the head itself, and nothing reads as
 * changed. The merge gates read parents with the graph turned off, and
 * their tests plant one with this to hold them to it. A commit named as
 * `X^{commit}` is read from its object, true parents and all, so a plant
 * goes on a commit behind the one a gate names, which git reaches only
 * through the graph.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../support/git-fixture.ts";

/** The bytes of a SHA-1 object id, the only hash these checkouts use. */
const HASH = 20;
/** A commit's record in the graph: its tree, two parents and a word of generation and date. */
const RECORD = HASH + 16;
/** What the graph says for a second parent a commit doesn't have. */
const NO_PARENT = 0x70000000;

/**
 * Writes `checkout`'s commit-graph, then names `parent` as the second
 * parent of `child`, which has one parent of its own. The graph is
 * written with topological levels, which git prunes its walks by, so the
 * child and every commit at its level or above, but the parent, are
 * raised together to sit above the parent while keeping their order; a
 * graph of corrected dates would need its own chunk rewritten too.
 */
export async function plantParentByGraph(
	checkout: string,
	child: string,
	parent: string,
): Promise<void> {
	await git(
		checkout,
		"-c",
		"commitGraph.generationVersion=1",
		"commit-graph",
		"write",
		"--reachable",
		"--no-progress",
	);
	const common = await git(
		checkout,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	);
	const path = join(common, "objects", "info", "commit-graph");
	const graph = readFileSync(path);
	if (graph.toString("latin1", 0, 4) !== "CGPH" || graph[5] !== 1) {
		throw new Error(`${path} isn't a SHA-1 commit-graph`);
	}
	const chunks = new Map<string, number>();
	const count = graph.readUInt8(6);
	for (let at = 8; at < 8 + 12 * count; at += 12) {
		chunks.set(
			graph.toString("latin1", at, at + 4),
			Number(graph.readBigUInt64BE(at + 4)),
		);
	}
	const fanout = chunks.get("OIDF");
	const ids = chunks.get("OIDL");
	const records = chunks.get("CDAT");
	if (fanout === undefined || ids === undefined || records === undefined) {
		throw new Error(`${path} lacks a chunk this needs`);
	}
	const commits = graph.readUInt32BE(fanout + 255 * 4);
	const position = (id: string): number => {
		for (let at = 0; at < commits; at += 1) {
			const start = ids + at * HASH;
			if (graph.toString("hex", start, start + HASH) === id) return at;
		}
		throw new Error(`${id} isn't in ${path}`);
	};
	const childAt = records + position(child) * RECORD;
	const parentAt = records + position(parent) * RECORD;
	if (graph.readUInt32BE(childAt + HASH + 4) !== NO_PARENT) {
		throw new Error(`${child} has a second parent already`);
	}
	graph.writeUInt32BE(position(parent), childAt + HASH + 4);
	// A level is the word's top 30 bits, the date's top 2 bits below it.
	const level = (at: number): number => graph.readUInt32BE(at + HASH + 8) >>> 2;
	const from = level(childAt);
	const rise = Math.max(0, level(parentAt) + 1 - from);
	for (let at = 0; at < commits; at += 1) {
		const record = records + at * RECORD;
		if (record === parentAt || level(record) < from) continue;
		const dateBits = graph.readUInt32BE(record + HASH + 8) & 0b11;
		const raised = level(record) + rise;
		graph.writeUInt32BE(((raised << 2) | dateBits) >>> 0, record + HASH + 8);
	}
	// Git writes the graph read-only; its owner may still replace it.
	rmSync(path);
	writeFileSync(path, graph);
}
