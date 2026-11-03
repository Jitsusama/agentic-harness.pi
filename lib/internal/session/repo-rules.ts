/**
 * A repo's rules for a session that takes a tree in it but started
 * somewhere else.
 *
 * pi loads AGENTS.md only from the folder a session starts in and its
 * parents, so a session started in home, or in one repo, that cuts a
 * tree in another works without that repo's rules. On 2026-11-03
 * seventeen sessions started in home that way, builders among them,
 * and none of them read core.nix's test pyramid. Saying the rules in
 * the answer that hands over the tree closes that gap without editing
 * anything the model was already sent.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	loadProjectContextFiles,
} from "@earendil-works/pi-coding-agent";
import { processGlobal } from "../process-global.ts";

/** A context file as pi loads one: where it is and what it says. */
export interface ContextFile {
	path: string;
	content: string;
}

/**
 * The longest rules said whole, in characters. Every repo's AGENTS.md
 * on Joel's machine on 2026-11-03 but one ran 2 to 14 KB, which pi
 * would have put in the system prompt whole had the session started
 * there; walgit-rs's ran 422 KB, which would crowd out the work, so a
 * file past this is named for the agent to read instead.
 */
export const RULES_INLINE_LIMIT = 16 * 1024;

/** The names pi takes a folder's rules from, in its own order. */
const RULES_NAMES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
];

const GIT_TIMEOUT_MS = 5_000;

/** The repos each session has been given the rules of, for the process. */
const given = processGlobal(
	"agentic-harness.repo-rules.given",
	() => new Map<string, Set<string>>(),
);

/**
 * What to tell a session that has just cut or taken the tree at
 * `tree`, or undefined when it needs telling nothing: the tree has no
 * rules file, pi loaded one from the same repo when the session
 * started in `cwd` (or the same text from anywhere), or this session
 * was given this repo's rules already. A repo is known by its git
 * common directory, so every worktree of one checkout counts as one
 * repo; a tree outside git is known by its own folder.
 *
 * `loaded` and `repoOf` default to pi's own loader run over `cwd` and
 * to git; a test names them.
 */
export function repoRulesNote(opts: {
	tree: string;
	cwd: string;
	session: string;
	loaded?: readonly ContextFile[];
	repoOf?: (dir: string) => string | undefined;
}): string | undefined {
	const checkout = rulesIn(opts.tree) ? opts.tree : checkoutBelow(opts.tree);
	const rules = checkout ? rulesIn(checkout) : undefined;
	if (!checkout || !rules) return undefined;
	const repoOf = opts.repoOf ?? gitCommonDir;
	const repo = repoOf(checkout) ?? canonical(checkout);
	const loaded = opts.loaded ?? loadedAtStart(opts.cwd);
	const known = loaded.some(
		(file) =>
			file.content === rules.content || repoOf(dirname(file.path)) === repo,
	);
	if (known) return undefined;
	const seen = given.get(opts.session) ?? new Set<string>();
	if (seen.has(repo)) return undefined;
	seen.add(repo);
	given.set(opts.session, seen);
	return noteFor(rules);
}

/** The rules file pi would take from a folder, if it has one. */
function rulesIn(dir: string): ContextFile | undefined {
	for (const name of RULES_NAMES) {
		const path = join(dir, name);
		try {
			if (!existsSync(path) || !statSync(path).isFile()) continue;
			return { path, content: readFileSync(path, "utf8") };
		} catch {
			// Unreadable: pi would skip it too and try the next name.
		}
	}
	return undefined;
}

/**
 * The one folder below a tree holding a `.git`, as a World tree keeps
 * its checkout in `src/`, or nothing when there are none or several.
 */
function checkoutBelow(tree: string): string | undefined {
	try {
		const found = readdirSync(tree, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(tree, entry.name))
			.filter((child) => existsSync(join(child, ".git")));
		return found.length === 1 ? found[0] : undefined;
	} catch {
		// A tree that can't be listed has no checkout to read rules from.
		return undefined;
	}
}

/** What pi loaded for a session started in `cwd`. */
function loadedAtStart(cwd: string): ContextFile[] {
	try {
		return loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
	} catch {
		// A folder pi can't read loaded nothing, so every repo is new.
		return [];
	}
}

/** A folder's repo, as its git common directory, or undefined outside git. */
function gitCommonDir(dir: string): string | undefined {
	try {
		const out = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
			},
		).trim();
		return out ? canonical(out) : undefined;
	} catch {
		// Not a repository, or no git: the folder stands for itself.
		return undefined;
	}
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A path that doesn't resolve compares as it is spelt.
		return path;
	}
}

function noteFor(rules: ContextFile): string {
	const lead = `This tree's repo has rules at ${rules.path}, and pi loaded no rules from this repo when this session started, as it reads AGENTS.md only from the folder a session starts in and its parents.`;
	if (rules.content.length > RULES_INLINE_LIMIT) {
		const kb = Math.round(rules.content.length / 1024);
		return `${lead} At ${kb} KB they are too long to say here: read it, in pieces with offset and limit, before changing anything in this tree, and follow it for work here.`;
	}
	return `${lead} Follow them for work in this tree:\n\n<repo_rules path="${rules.path}">\n${rules.content.trimEnd()}\n</repo_rules>`;
}
