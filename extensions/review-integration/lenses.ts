/**
 * Which lens each reviewer reads through, gathered from disk.
 *
 * A lens can come from two places now: a persona the operator wrote,
 * which lives beside their config and travels with them, and an agent
 * the repo under review defined for itself, which lives in the repo
 * and does not. Binding a roster to charters means reading both and
 * knowing which is which.
 *
 * Its own module because the composition is the part that has been
 * wrong before. Four PRs in a row shipped a helper with tests and a
 * call site without any, and the call site is where the bugs were: a
 * glyph module two imports from a renderer still drawing the old
 * marks, a spend recorder every test called directly and production
 * never called at all. A composition inside a tool file can only be
 * checked by reading it. Here it can be driven.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	AgentDiscovery,
	AgentFile,
	Roster,
} from "../../lib/review/index.js";
import {
	bindPersonas,
	discoverAgents,
	parsePersona,
} from "../../lib/review/index.js";
import type { ReadableTree } from "./work.js";

/**
 * Where a repo keeps the agents somebody defined for it.
 *
 * Measured on this machine rather than guessed at: fifteen agent files
 * across two repos live under `.claude/agents`, and a third keeps five
 * review lenses in a plain `agents` directory at the root. Nothing
 * else on disk holds any, so nothing else is looked in.
 */
const AGENT_DIRS = [join(".claude", "agents"), "agents"];

/**
 * Every charter the operator wrote, by persona id.
 *
 * Read once per round rather than per participant, since six reviewers
 * naming three personas should not be six directory walks. A file that
 * will not parse stops the round: a roster naming it would otherwise
 * fail with "no such persona" while the file sits right there, which
 * sends somebody looking in the wrong place.
 */
export async function chartersOnDisk(
	dir: string,
): Promise<Map<string, string>> {
	const charters = new Map<string, string>();

	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		// No persona directory at all is the ordinary case for anybody who
		// has never written one, and a roster naming no persona never
		// asks. bindPersonas refuses if one is named.
		return charters;
	}

	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const id = basename(name, ".md");
		const parsed = parsePersona(id, await readFile(join(dir, name), "utf8"));
		if ("refusal" in parsed) throw new Error(parsed.refusal);
		charters.set(id, parsed.persona.charter);
	}
	return charters;
}

/**
 * Lenses the repo under review already had, by namespaced id.
 *
 * Read from the tree the round will actually read, not from the
 * session's directory, since those are two repos often enough to have
 * cost $75.63 finding out.
 */
export async function agentsInRepo(
	treePath: string,
	touched: readonly string[] = [],
): Promise<AgentDiscovery> {
	const files: AgentFile[] = [];
	const unreadable: { path: string; why: string }[] = [];

	for (const dir of AGENT_DIRS) {
		let names: string[];
		try {
			names = await readdir(join(treePath, dir));
		} catch {
			// A repo with no agents is the ordinary case, and one of the two
			// directories is absent even in a repo that has some.
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".md")) continue;
			try {
				files.push({
					path: join(dir, name),
					text: await readFile(join(treePath, dir, name), "utf8"),
				});
			} catch (error) {
				// The leniency was written for the parse and skipped for the
				// read, and the read is the half that lives in the repo's
				// control. A dangling symlink, a directory named `.md`, a file
				// nobody may open: any one of them threw out of here, out of
				// the round, and out of every other round against that repo,
				// including rounds naming no repo lens at all.
				unreadable.push({
					path: join(dir, name),
					why: `It could not be read: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	const found = discoverAgents(files, touched);
	return { agents: found.agents, skipped: [...unreadable, ...found.skipped] };
}

/** What the tree offered, for a refusal that would otherwise guess. */
function whatTheTreeSaid(inRepo: AgentDiscovery): string[] {
	const said: string[] = [];
	if (inRepo.agents.length > 0) {
		said.push(
			`The repo under review offers ${inRepo.agents.map((one) => `"${one.id}"`).join(", ")}.`,
		);
	}
	for (const missed of inRepo.skipped) {
		said.push(`${missed.path} was not read: ${missed.why}`);
	}
	return said;
}

/**
 * Each participant's charter, by participant id.
 *
 * Keyed by participant rather than by persona, because a round asks by
 * participant id and the same lens can be on a roster twice at two
 * thinking levels. A missing persona stops the round here, before
 * anybody is asked, since a reviewer running without its lens files
 * generic findings under a specialist's name.
 *
 * The repo's own agents are looked up alongside the personas and
 * cannot shadow one: their ids carry a namespace, so asking for a
 * repo's lens and asking for your own are different requests, and one
 * can never quietly answer the other.
 */
export async function chartersFor(
	// Narrowed to who this round asks before it arrives. Binding the
	// whole roster was harmless while a lens was a file in a directory
	// the operator owns. It stops being harmless once one can come from
	// the repo: a judge-only round would refuse over a reviewer's
	// missing lens, and that reviewer is somebody it will never ask.
	roster: Roster,
	personaDir: string,
	// Paths the change under review touches, so a lens the change itself
	// wrote can be refused rather than obeyed.
	touched: readonly string[],
	// The tree itself rather than a path, so a round cannot hand this
	// somewhere other than where it reads. A path parameter took
	// `process.cwd()` without complaint, and a lens borrowed from the
	// session's repo rather than the change's is the cheap version of
	// the mistake that cost $75.63: a reviewer reading real code through
	// a lens written for a codebase nobody is reviewing.
	tree: ReadableTree,
): Promise<Map<string, string>> {
	const charters = await chartersOnDisk(personaDir);
	const inRepo = await agentsInRepo(tree.path, touched);
	for (const agent of inRepo.agents) {
		// A persona file may not claim the namespace, so the merge order
		// cannot decide anything. Without this the guarantee above held by
		// convention only: a file literally named `repo:architect.md` was
		// shadowed here by whatever the repo shipped.
		if (charters.has(agent.id)) {
			throw new Error(
				`A persona of your own is called "${agent.id}", which is the namespace repo lenses use. Rename it: while it exists, asking for your lens and asking for the repo's are the same request.`,
			);
		}
		charters.set(agent.id, agent.charter);
	}

	const bound = bindPersonas(roster, (id) => charters.get(id));
	if ("refusal" in bound) {
		// The refusal knows the lens is missing and not why. What the tree
		// offered and declined to offer is here, and saying it is the
		// difference between "no such persona" and "the change you are
		// reviewing edits that file" while the file sits right there.
		throw new Error([bound.refusal, ...whatTheTreeSaid(inRepo)].join(" "));
	}

	const byParticipant = new Map<string, string>();
	for (const binding of bound.bindings) {
		if (binding.charter !== undefined) {
			byParticipant.set(binding.participant.id, binding.charter);
		}
	}
	return byParticipant;
}
