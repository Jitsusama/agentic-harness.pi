/**
 * Agents another harness already defined in the repo under review.
 *
 * A repo that has been worked in for a while has usually accumulated
 * some: a reviewer, an architect, a debugger, each written by somebody
 * who knew that codebase. They are lenses, which is what a persona is,
 * and they are already there, which is more than can be said for any
 * lens this tool ships. Offering them costs a directory read.
 *
 * Two rules make that safe. They are namespaced, because a roster
 * naming a lens and silently getting the repo's version of it is the
 * quiet substitution `bindPersonas` refuses: the findings still file
 * under the name, and whoever reads them weighs them as the lens they
 * asked for. And only the prose comes across. Measured across fifteen
 * agent files on this machine, thirteen name tools and six name a
 * model, in vocabulary that belongs to the harness that wrote them:
 * `sonnet` is not a model pi resolves and `Bash, Read, Edit` are not
 * tools it has. What transfers is the lens.
 *
 * Reading the directory is somebody else's job, as it is for personas.
 * This module is handed the files.
 */

import { splitFrontmatter } from "./persona.js";

/** A file that might describe an agent. */
export interface AgentFile {
	/** Where it was found, relative to the repo, for reporting. */
	path: string;
	text: string;
}

/** A lens the repo under review already had. */
export interface RepoAgent {
	/** Namespaced id, which is how a roster asks for it. */
	id: string;
	name: string;
	description: string;
	/** The charter prose: the file body, frontmatter stripped. */
	charter: string;
	source: string;
	/** Frontmatter fields deliberately left behind, if any. */
	notAdopted?: string[];
}

/** What a directory of agent files yielded, and what it did not. */
export interface AgentDiscovery {
	agents: RepoAgent[];
	skipped: { path: string; why: string }[];
}

/** The prefix that keeps these out of the persona namespace. */
const NAMESPACE = "repo:";

/**
 * Fields carrying another harness's mechanism, which do not come over.
 *
 * Not a refusal, because the file is not wrong: it is right for the
 * harness it was written for. It is reported so that somebody choosing
 * this lens is not surprised by which model it runs on.
 */
const MECHANISM = ["model", "tools"];

/**
 * Read what a repo's agent files offer.
 *
 * Lenient where the persona reader is strict, and the difference is
 * who asked. A persona is named in somebody's own config, so a
 * malformed one is a mistake they want reported loudly. Nobody asked
 * for these, so one malformed file in a repo this operator does not
 * maintain must not refuse every round run against it.
 */
export function discoverAgents(files: AgentFile[]): AgentDiscovery {
	const read: RepoAgent[] = [];
	const skipped: { path: string; why: string }[] = [];
	const sourceOf = new Map<string, string[]>();

	for (const file of files) {
		const split = splitFrontmatter(file.text);
		if (split === undefined) {
			skipped.push({
				path: file.path,
				why: "It opens with no frontmatter block, so it names no lens.",
			});
			continue;
		}

		const name = split.fields.name;
		if (name === undefined || name === "") {
			skipped.push({
				path: file.path,
				why: "Its frontmatter gives no name, so there is nothing to call it.",
			});
			continue;
		}

		const description = split.fields.description;
		if (description === undefined || description === "") {
			skipped.push({
				path: file.path,
				why: `The agent "${name}" gives no description, which is how somebody choosing a lens knows what it is for.`,
			});
			continue;
		}

		const charter = split.body.trim();
		if (charter === "") {
			skipped.push({
				path: file.path,
				why: `The agent "${name}" has an empty body, so it is a name for a lens that does not exist.`,
			});
			continue;
		}

		const notAdopted = MECHANISM.filter((field) => field in split.fields);
		read.push({
			id: `${NAMESPACE}${name}`,
			name,
			description,
			charter,
			source: file.path,
			...(notAdopted.length === 0 ? {} : { notAdopted }),
		});
		sourceOf.set(name, [...(sourceOf.get(name) ?? []), file.path]);
	}

	// A name two files answer to identifies neither. Dropping both is
	// the only answer that does not make which lens ran depend on the
	// order a directory happened to list its entries.
	const contested = (one: RepoAgent) =>
		(sourceOf.get(one.name) ?? []).length > 1;
	for (const one of read.filter(contested)) {
		skipped.push({
			path: one.source,
			why: `"${one.name}" is claimed by ${(sourceOf.get(one.name) ?? []).join(" and ")}, so the name identifies neither.`,
		});
	}

	return { agents: read.filter((one) => !contested(one)), skipped };
}
