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

import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
	AgentDiscovery,
	AgentFile,
	DiffModel,
	PersonaBinding,
	RepoGuidance,
	Roster,
	RoundGiven,
} from "../../lib/review/index.js";
import {
	bindPersonas,
	discoverAgents,
	NAMESPACE,
	parsePersona,
	quotable,
} from "../../lib/review/index.js";

/** How much repo-written text a refusal may repeat, and how often. */
const MOST_CHARACTERS = 200;
const MOST_LINES = 20;

/** Repo-written text, cut to a length a message can carry. */
function clipped(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MOST_CHARACTERS
		? flat
		: `${flat.slice(0, MOST_CHARACTERS)}...`;
}

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
 * Where a repo writes down what it asks of its contributors.
 *
 * The three names pi's own documentation gives, in the order it gives
 * them, since the point is to hand over deliberately what pi was
 * picking up ambiently. An override wins outright, which is what the
 * name means. A fourth was invented here for symmetry and put ahead of
 * AGENTS.md, where it would have shadowed the real thing if any repo
 * had happened to have one.
 */
const GUIDANCE_FILES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

/**
 * How much of a repo's conventions to carry into a prompt.
 *
 * Measured against the file this repo ships, which is the one case to
 * hand: 32,000 cut it, and cut the tail, which is where a file like
 * this says what not to do. Raised past it with room, and the cut says
 * where the rest is rather than pretending there is no rest.
 *
 * Characters, and the number is what it says it is: an earlier comment
 * here said thirty thousand while the constant kept three times that,
 * which is the kind of disagreement nobody notices until it matters.
 */
const MOST_GUIDANCE = 96_000;

/** Whether a path from a diff names this file at the repo root. */
function sameRootFile(path: string, name: string): boolean {
	const plain = path
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^[ab]\//, "");
	return plain.toLowerCase() === name.toLowerCase();
}

/**
 * What the repo under review asks of its contributors.
 *
 * Read from the tree the round reads, and handed to the prompt as
 * quoted material. Before this it arrived by itself, because a pi
 * child reads the context files in its working directory and a
 * reviewer's working directory is a tree pinned to the commit under
 * review. That put the change author's prose above the round's own
 * instructions, unasked and unrecorded.
 */
export async function guidanceInRepo(
	tree: ReadableTree,
	touched: Touched,
): Promise<RepoGuidance | undefined> {
	if (tree.caveat !== undefined) {
		// The tree is not the change's, so whatever sits at its root is
		// somebody else's conventions, and the edited flag would be
		// computed against a commit nobody read. Handing that over as "the
		// repo's own text" is worse than handing over nothing: the caveat
		// goes to the operator, and the reviewer never hears it.
		return undefined;
	}
	const root = await realpath(tree.path).catch(() => resolve(tree.path));

	for (const name of GUIDANCE_FILES) {
		const at = join(tree.path, name);
		let text: string;
		let reads = name;
		try {
			// The same rule the agent files get, and for the same reason: a
			// link is followed for its bytes, so without this a change could
			// point AGENTS.md at any readable file on the machine and have it
			// quoted into every reviewer's prompt. It was guarded one
			// function along and not here.
			const real = await realpath(at);
			if (real !== resolve(at)) {
				if (!real.startsWith(`${root}/`)) continue;
				// And where it actually lands, so the question of whether the
				// change wrote it is asked about the file the bytes came from.
				// Asking it about the link's own name was the same mistake in
				// its other half: guarded against a link out of the tree, and
				// wide open to one inside it.
				reads = real.slice(root.length + 1);
			}
			text = await readFile(at, "utf8");
		} catch {
			// Most repos have one of these and none has all three.
			continue;
		}
		if (text.trim() === "") continue;
		return {
			path: name,
			// Said as a field as well as in the text, so whoever records
			// what this reviewer was given can tell a round that got the
			// whole file from one that got the beginning of it.
			...(text.length <= MOST_GUIDANCE ? {} : { cut: true as const }),
			// Cut rather than refused, unlike a charter. A charter that
			// arrives half-written is a lens nobody wrote; conventions are
			// reference, and the first ninety-six thousand characters of
			// them are worth more to a reviewer than none.
			text:
				text.length <= MOST_GUIDANCE
					? text
					: `${text.slice(0, MOST_GUIDANCE)}\n\n[cut here at ${MOST_GUIDANCE} of ${text.length} characters. The rest is in ${reads} at the root of your working directory, and the end of one of these files is usually where it says what not to do.]`,
			// Not knowing counts as edited, since the whole reason to say so
			// is that the change may have written what the reviewer is about
			// to read, and "we could not tell" is not "it did not".
			//
			// The comparison is against this file and not against any file
			// whose name ends the same way. A repo with an AGENTS.md in a
			// subdirectory, which is most of them, marked the root one as
			// edited whenever the change touched the other.
			edited: !Array.isArray(touched)
				? "unknown"
				: touched.some(
							(path) => sameRootFile(path, name) || sameRootFile(path, reads),
						)
					? "yes"
					: "no",
		};
	}
	return undefined;
}

/**
 * What the repo says about itself, shaped for a prompt input.
 *
 * The join between the reader and the prompts, which lived in the tool
 * file where nothing could execute it: both halves had tests and the
 * thing that puts them together had none. Spread into a prompt input
 * so a round with no conventions to show says nothing at all rather
 * than carrying an empty section.
 */
export async function guidanceFor(
	tree: ReadableTree,
	diff: DiffModel | { unknown: string },
): Promise<{ guidance?: RepoGuidance }> {
	const guidance = await guidanceInRepo(
		tree,
		"unknown" in diff ? diff : touchedBy(diff),
	);
	return guidance === undefined ? {} : { guidance };
}

/**
 * What a round handed its reviewers, in the shape a run records it.
 *
 * The counterpart of `readFrom`, and it takes the conditions rather
 * than reading them, so the value recorded and the value passed to the
 * spawn are one constant used twice rather than two that agree today.
 *
 * The path and the edited state, not the text. A reader chasing a
 * finding needs to know which file was folded into that reviewer's
 * prompt and whether the change under review had written it; the bytes
 * are in the tree at the witness, and tens of thousands of characters
 * per round would cost more than the whole ledger.
 */
export function givenBy(
	isolated: boolean,
	conventions: { guidance?: RepoGuidance },
): { given: RoundGiven } {
	const guidance = conventions.guidance;
	return {
		given: {
			isolated,
			...(guidance === undefined
				? {}
				: {
						quoted: {
							path: guidance.path,
							edited: guidance.edited,
							...(guidance.cut === undefined ? {} : { cut: true as const }),
							// What the prompt did with it, asked of the prompt.
							// Derived from what was read, this would claim a
							// quotation the reviewer never saw: text that cannot
							// be fenced is named and not reproduced, since
							// unquoted it would be indistinguishable from the
							// round's own words.
							...(quotable(guidance.text) ? {} : { withheld: true as const }),
						},
					}),
		},
	};
}

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
	touched: readonly string[],
): Promise<AgentDiscovery> {
	const files: AgentFile[] = [];
	const unreadable: { path: string; why: string }[] = [];
	const root = await realpath(treePath).catch(() => resolve(treePath));

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
				const at = join(treePath, dir, name);
				// Where the read actually lands. A symlink means the path the
				// diff check ran against and the file the charter came from
				// need not be the same file, and the target need not be in the
				// tree at all: the whole rule about the change not writing the
				// reviewer's prompt reads a path nothing followed.
				const real = await realpath(at);
				if (real !== resolve(at) && !real.startsWith(`${root}/`)) {
					unreadable.push({
						path: join(dir, name),
						why: "It is a link to a file outside the tree, so what the diff says about this path says nothing about what would be read.",
					});
					continue;
				}
				files.push({
					path: join(dir, name),
					// Where the bytes come from, when a link inside the tree
					// means that is not where they appear to. Checking the diff
					// against the link alone let a change edit the file behind
					// it and leave the link untouched.
					...(real === resolve(at)
						? {}
						: { reads: real.slice(root.length + 1) }),
					text: await readFile(at, "utf8"),
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
	// Bounded in both directions. Each line is clipped because the words
	// after the colon can be the repo's, and the count is capped because
	// `agents` is a directory name plenty of repos use for source: one
	// missing lens in a repo with a large one was a refusal measured in
	// hundreds of kilobytes.
	for (const missed of inRepo.skipped.slice(0, MOST_LINES)) {
		said.push(`${clipped(missed.path)} was not read: ${clipped(missed.why)}`);
	}
	if (inRepo.skipped.length > MOST_LINES) {
		said.push(`${inRepo.skipped.length - MOST_LINES} more were not read.`);
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
/**
 * What the change under review writes to, or why that is not known.
 *
 * Not knowing is a real answer and has to be spellable. A stack whose
 * nodes are not all proposed is read at the tip, which holds every
 * node's work, while only the proposed ones carry diffs: the set of
 * touched paths is then a subset pretending to be the whole, and a
 * subset is the wrong shape for a rule that says "unless the change
 * wrote it".
 */
export type Touched = readonly string[] | { unknown: string };

/**
 * What a change writes to, on either side of a rename, or why that is
 * not known.
 *
 * A diff carrying no paths at all is the second answer and not the
 * first. Every real change writes to something, so an empty list means
 * the provider did not say, and reading that as "touches nothing" is
 * the most permissive answer available for the one rule that keeps the
 * change under review out of the reviewer's prompt.
 */
export function touchedBy(diff: DiffModel): Touched {
	const paths = diff.files.flatMap((file) => [
		...(file.newPath === undefined ? [] : [file.newPath]),
		...(file.oldPath === undefined ? [] : [file.oldPath]),
	]);
	return paths.length > 0
		? paths
		: {
				unknown:
					"The diff for this change names no paths, which is not the same as a change that writes to nothing.",
			};
}

export async function lensesFor(
	// Narrowed to who this round asks before it arrives. Binding the
	// whole roster was harmless while a lens was a file in a directory
	// the operator owns. It stops being harmless once one can come from
	// the repo: a judge-only round would refuse over a reviewer's
	// missing lens, and that reviewer is somebody it will never ask.
	roster: Roster,
	personaDir: string,
	// Paths the change under review touches, so a lens the change itself
	// wrote can be refused rather than obeyed.
	touched: Touched,
	// The tree itself rather than a path, so a round cannot hand this
	// somewhere other than where it reads. A path parameter took
	// `process.cwd()` without complaint, and a lens borrowed from the
	// session's repo rather than the change's is the cheap version of
	// the mistake that cost $75.63: a reviewer reading real code through
	// a lens written for a codebase nobody is reviewing.
	tree: ReadableTree,
): Promise<Map<string, string>> {
	const charters = await chartersOnDisk(personaDir);
	for (const id of charters.keys()) {
		// The namespace is reserved rather than deconflicted. Checking only
		// where the two collide left a persona of your own answering a
		// repo request whenever the repo had no agent of that name, which
		// is the substitution the prefix exists to prevent, running the
		// other way.
		if (id.startsWith(NAMESPACE)) {
			throw new Error(
				`A persona of your own is called "${id}", and "${NAMESPACE}" is reserved for lenses the repo under review defines. Rename it: while it exists, asking for a repo's lens can reach yours instead.`,
			);
		}
	}

	// Only when somebody asked for one. Every round was walking and
	// parsing every markdown file in a repo's agent directories,
	// including rounds naming no repo lens, which is work nobody wanted
	// and a surface nobody opened.
	const wants = [
		...roster.reviewers,
		...(roster.judge === undefined ? [] : [roster.judge]),
	].some((one) => one.persona?.startsWith(NAMESPACE) === true);
	if (!wants) {
		const plain = bindPersonas(roster, (id) => charters.get(id));
		if ("refusal" in plain) throw new Error(plain.refusal);
		return byParticipant(plain.bindings);
	}

	// A lens is only as trustworthy as the claim about which commit the
	// tree stands at, and a caveat is that claim failing. The refusal
	// for a lens the diff touches is computed against the change's
	// files, so on a tree that is not the change's it is checking the
	// wrong thing against the wrong bytes.
	if (tree.caveat !== undefined) {
		throw new Error(
			`A participant asks for a lens from the repo under review, and this round is not reading a tree pinned to the commit under review: ${tree.caveat} Drop the repo lens, or run the round where a tree can be pinned.`,
		);
	}
	if (!Array.isArray(touched)) {
		throw new Error(
			`A participant asks for a lens from the repo under review, and what this change writes to is not known in full: ${(touched as { unknown: string }).unknown} A lens is safe to read only where the change under review is known not to have written it.`,
		);
	}

	const inRepo = await agentsInRepo(tree.path, touched);
	for (const agent of inRepo.agents) charters.set(agent.id, agent.charter);

	const bound = bindPersonas(roster, (id) => charters.get(id));
	if ("refusal" in bound) {
		// The refusal knows the lens is missing and not why. What the tree
		// offered and declined to offer is here, and saying it is the
		// difference between "no such persona" and "the change you are
		// reviewing edits that file" while the file sits right there.
		throw new Error([bound.refusal, ...whatTheTreeSaid(inRepo)].join(" "));
	}

	return byParticipant(bound.bindings);
}

/** The charters, keyed the way a round asks for them. */
function byParticipant(
	bindings: readonly PersonaBinding[],
): Map<string, string> {
	const charters = new Map<string, string>();
	for (const binding of bindings) {
		if (binding.charter !== undefined) {
			charters.set(binding.participant.id, binding.charter);
		}
	}
	return charters;
}
