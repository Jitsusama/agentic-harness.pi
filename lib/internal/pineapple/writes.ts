/**
 * Which of a session's tool calls are writes a safe-word stop can hold,
 * and what each is a write to.
 *
 * A write is anything that reaches other people or lands for good:
 * pushing a branch, opening, editing, commenting on or merging a pull
 * request, and switching or deploying a machine. Starting more agents
 * counts too: a pi host cut or restarted, a session spawned, a council
 * or fleet run, since a stop that parks every session means nothing if
 * a parked one can start more. Reads, builds and commits stay on this
 * machine and are never writes here, so a stop leaves a session free to
 * keep working in its own tree.
 *
 * This only reads the call. What it names but doesn't say, such as the
 * repository a bare `git push` goes to, is left for {@link settle} to ask
 * git, so the parsing stays testable without a checkout.
 */

import { isAbsolute, join, resolve } from "node:path";
import { effectiveCwd, tokenize } from "../../command/index.ts";
import type { CommandLine, SimpleCommand, Word } from "../../command/types.ts";
import { unquote } from "../../shell/index.ts";
import {
	ansiUnquoted,
	flatten,
	heredocRuns,
	inlined,
	uncommented,
} from "./flatten.ts";
import {
	ranAtLast,
	readsStdin,
	runs,
	SHELLS,
	sourcesStdin,
	sshReadsStdin,
	unwrapped,
} from "./runs.ts";
import { startIn } from "./starts.ts";

/**
 * What a write lands on: one change (a push, a comment, a merge), a
 * repository (a new pull request), the machine (a switch, a deploy), or
 * its agents (a start: a pi host cut or restarted, a session spawned, a
 * council or fleet run).
 */
export type WriteKind = "change" | "repo" | "machine" | "start";

/** Whether a write lands on the machine as a whole, not on a repository. */
export function machineWide(kind: WriteKind): boolean {
	return kind === "machine" || kind === "start";
}

/** A write as the call states it, before git fills in what it left out. */
export interface WriteCall {
	/** What it does, as a person would say it: "git push", "review_offer merge". */
	readonly action: string;
	readonly kind: WriteKind;
	/** Where it runs, which says its repository when it names none. */
	readonly dir?: string;
	/** The git remote it goes to, when it says one. */
	readonly remote?: string;
	readonly repo?: string;
	readonly branch?: string;
	readonly pr?: number;
}

/** A write with what git could say about it filled in. */
export type Write = WriteCall;

/** What {@link settle} asks git, so a test can answer instead. */
export interface GitFacts {
	/** The `owner/name` a remote of the checkout at `dir` points at. */
	repoOf(dir: string, remote: string): Promise<string | undefined>;
	/** The branch checked out at `dir`. */
	branchOf(dir: string): Promise<string | undefined>;
}

/** Fill in the repository and branch a call leaves to its checkout. */
export async function settle(call: WriteCall, git: GitFacts): Promise<Write> {
	if (machineWide(call.kind) || call.dir === undefined) return call;
	const repo =
		call.repo ?? (await git.repoOf(call.dir, call.remote ?? "origin"));
	const branch =
		call.branch ??
		(call.pr === undefined ? await git.branchOf(call.dir) : undefined);
	return { ...call, repo, branch };
}

/** The `owner/name` a remote URL names, lowercased. */
export function repoOfUrl(url: string): string | undefined {
	const path = url
		.trim()
		.replace(/^[a-z+]+:\/\/[^/]+\//i, "")
		.replace(/^[^@/]+@[^:]+:/, "")
		.replace(/\.git\/?$/, "")
		.replace(/\/$/, "");
	const parts = path.split("/").filter(Boolean);
	if (parts.length < 2) return undefined;
	return parts.slice(-2).join("/").toLowerCase();
}

/**
 * The change a reference names: a link to a pull request on any host,
 * `owner/name#12`, `#12` or `12`. The repository is absent when the
 * reference doesn't name one.
 */
export function changeOf(
	reference: string,
): { repo?: string; pr: number } | undefined {
	const text = reference.trim();
	const link =
		/^https?:\/\/[^/]+\/(.+?)\/(?:pull|pulls|merge_requests|-\/merge_requests)\/(\d+)/i.exec(
			text,
		);
	if (link?.[1] && link[2]) {
		const repo = link[1].split("/").slice(-2).join("/").toLowerCase();
		return { repo, pr: Number(link[2]) };
	}
	const short = /^([\w.-]+\/[\w.-]+)?#?(\d+)$/.exec(text);
	if (short?.[2]) {
		const pr = Number(short[2]);
		return short[1] ? { repo: short[1].toLowerCase(), pr } : { pr };
	}
	return undefined;
}

/** The review tools' actions that change nothing anyone else sees. */
const REVIEW_READS = new Set(["capabilities"]);

/** review_offer's actions that open a new change rather than touch one. */
const OPENS = new Set(["propose", "propose-stack"]);

/** The quest tool's actions that start a pi session. */
const SPAWNS = new Set(["spawn", "spawn-tab", "spawn-pane", "spawn-window"]);

/** review_ask's actions that only read the rounds already run. */
const ASK_READS = new Set(["runs", "roster", "collect", "stop", "release"]);

/**
 * The write a call to one of the harness's own tools makes, or undefined
 * when it makes none. `trees` is where the work tool keeps its trees, so
 * a tree named by key can be found.
 */
export function writeInTool(
	tool: string,
	input: unknown,
	cwd: string,
	trees: string,
): WriteCall | undefined {
	const args = (
		typeof input === "object" && input !== null ? input : {}
	) as Record<string, unknown>;
	const action = typeof args.action === "string" ? args.action : undefined;
	switch (tool) {
		case "review_offer":
		case "review_say":
			if (action !== undefined && REVIEW_READS.has(action)) return undefined;
			return reviewWrite(tool, action, args, cwd);
		case "review_draft":
			return action === "publish"
				? reviewWrite(tool, action, args, cwd)
				: undefined;
		case "quest":
			return questStart(action, args);
		case "subagent":
			return { action: "subagent", kind: "start" };
		case "review_ask":
			if (ASK_READS.has(action ?? "runs")) return undefined;
			return { action: `review_ask ${action}`, kind: "start" };
		case "work":
			if (action !== "push") return undefined;
			return {
				action: "work push",
				kind: "change",
				dir: treeDir(args.tree, trees),
			};
		default:
			return undefined;
	}
}

/** A quest spawn, or a reopening of lost sessions that isn't a dry run. */
function questStart(
	action: string | undefined,
	args: Record<string, unknown>,
): WriteCall | undefined {
	if (args.dryRun === true || action === undefined) return undefined;
	const starts =
		SPAWNS.has(action) || (action === "reopen-sessions" && args.force === true);
	return starts ? { action: `quest ${action}`, kind: "start" } : undefined;
}

function reviewWrite(
	tool: string,
	action: string | undefined,
	args: Record<string, unknown>,
	cwd: string,
): WriteCall {
	const dir = typeof args.repo === "string" ? resolve(cwd, args.repo) : cwd;
	const named =
		typeof args.change === "string"
			? changeOf(args.change)
			: typeof args.change === "number"
				? { pr: args.change }
				: undefined;
	const head =
		typeof args.head === "string"
			? args.head
			: Array.isArray(args.heads) && typeof args.heads.at(-1) === "string"
				? (args.heads.at(-1) as string)
				: undefined;
	return {
		action: action ? `${tool} ${action}` : tool,
		kind: action !== undefined && OPENS.has(action) ? "repo" : "change",
		dir,
		...(named?.repo ? { repo: named.repo } : {}),
		...(named ? { pr: named.pr } : {}),
		...(head ? { branch: head } : {}),
	};
}

function treeDir(tree: unknown, trees: string): string | undefined {
	if (typeof tree !== "string" || tree === "") return undefined;
	if (tree.startsWith("~/")) return join(process.env.HOME ?? "", tree.slice(2));
	return isAbsolute(tree) ? tree : join(trees, tree);
}

/** Pull-request subcommands of `gh pr` and `dt pr` that write. */
const PR_WRITES = new Set([
	"create",
	"merge",
	"comment",
	"review",
	"edit",
	"ready",
	"close",
	"reopen",
	"update-branch",
	"resolve",
	"unresolve",
	"restore-branch",
	"lock",
	"unlock",
]);

/** Commands that switch or deploy a machine, by name and first word. */
const MACHINE: ReadonlyArray<
	readonly [string, ReadonlySet<string> | undefined]
> = [
	["switch-system", undefined],
	["nixos-rebuild", new Set(["switch", "boot", "test"])],
	["darwin-rebuild", new Set(["switch", "activate"])],
	["home-manager", new Set(["switch"])],
	["deploy-rs", undefined],
	["deploy", undefined],
	["colmena", new Set(["apply"])],
];

/**
 * The writes a bash command makes, in order. A line the command model
 * can't read is flattened into one it can (flatten.ts), and only one
 * that still can't is searched by pattern, so a write hidden in a
 * construct it doesn't parse is still seen, though with nothing known
 * about where it goes.
 */
export function writesInBash(command: string, cwd: string): WriteCall[] {
	return writesInLine(command, cwd);
}

/**
 * As {@link writesInBash}, where `cwd` may be unknown, as a shell's `-c`
 * line's is when its own shell's can't be told: every write in it is then
 * left without a directory, rather than read from this process's own.
 */
function writesInLine(command: string, cwd: string | undefined): WriteCall[] {
	// Comments, `$'...'` strings and heredocs, which the command model
	// misreads, go first.
	const plain = ansiUnquoted(uncommented(command));
	const source = inlined(plain);
	const flat = flatten(source);
	// What a substitution runs in double quotes or an unquoted heredoc,
	// where isn't known, read before its heredocs were inlined, which
	// left those in double quotes bodiless.
	const substituted = [
		...flatten(plain).substituted,
		...heredocRuns(plain),
	].flatMap((inner) => writesInLine(inner, undefined));
	const line = defusedLine(source);
	if (line.supported) return [...writesOf(line, cwd), ...substituted];
	const flattened = defusedLine(flat.line);
	if (!flattened.supported) return patternWrites(source);
	// Its structure moves offsets and may move directories, so no
	// command in it is said to run anywhere known.
	return [...writesOf(flattened, undefined), ...substituted];
}

/** A `<<` that is no here-string's `<<<`. */
const HEREDOC_OPENER = /(?<!<)<<(?!<)/g;

/**
 * What stands in for a `<<` while the command model reads a line: two
 * private-use characters, which it takes for a word's own, and which
 * keep every offset where it was.
 */
const DEFUSED_OPENER = "\uE000\uE000";

const DEFUSED = new RegExp(DEFUSED_OPENER, "g");

/**
 * The line as the command model reads it, with each `<<` left in it
 * read as plain text. Every heredoc has been inlined, so one left is
 * quoted or never closed, and the model, which finds heredocs without
 * knowing quotes, would take the lines after it for a body and leave
 * their commands unread. Each word keeps its `<<`, so a shell's `-c`
 * line still holds the heredoc it opens.
 */
function defusedLine(source: string): CommandLine {
	const read = tokenize(source.replace(HEREDOC_OPENER, DEFUSED_OPENER));
	const word = (each: Word): Word => ({
		...each,
		text: each.text.replace(DEFUSED, "<<"),
	});
	return {
		...read,
		source,
		commands: read.commands.map((simple) => ({
			...simple,
			assignments: simple.assignments.map(word),
			argv: simple.argv.map(word),
			redirects: simple.redirects.map((redirect) =>
				redirect.target
					? { ...redirect, target: word(redirect.target) }
					: redirect,
			),
		})),
	};
}

/** The writes of each command a readable line holds, in order. */
function writesOf(line: CommandLine, cwd: string | undefined): WriteCall[] {
	const writes: WriteCall[] = [];
	for (const simple of line.commands) {
		const here =
			cwd === undefined
				? undefined
				: effectiveCwd(line, cwd, simple.span.start);
		const dir = here !== undefined && "dir" in here ? here.dir : undefined;
		// Its here-strings go first, so a wrapper left with none opens a
		// shell for them.
		const given = hereStrings(simple.argv.map((word) => unquote(word.text)));
		const own = unwrapped(given.own);
		const { strings } = given;
		writes.push(...writeIn(own, dir));
		const fed = fedTo(line, simple, own, strings);
		if (fed === undefined) continue;
		const read = fed.lines.flatMap((one) =>
			writesInLine(one, fed.runner === undefined ? dir : undefined),
		);
		writes.push(
			...(fed.runner === undefined ? read : startsBy(fed.runner, read)),
		);
	}
	return writes;
}

/**
 * What a command reading its commands on stdin is fed, as lines to read:
 * its here-strings, which its heredocs became, and the words and
 * here-strings of the command piped into it. That command is a shell
 * reading stdin, or ssh, whose starts alone count, as it says, behind
 * any wrapper or launcher. Nothing when it is neither.
 */
function fedTo(
	line: CommandLine,
	simple: SimpleCommand,
	argv: string[],
	strings: string[],
): { lines: string[]; runner?: string } | undefined {
	const [program, ...args] = ranAtLast(argv);
	const name = program?.split("/").at(-1) ?? "";
	const shell =
		(SHELLS.has(name) && readsStdin(args)) || sourcesStdin(name, args);
	if (!shell && !(name === "ssh" && sshReadsStdin(args))) return undefined;
	const lines = [...strings];
	const producer = pipedInto(line, simple);
	if (producer !== undefined) {
		const fed = hereStrings(words(producer));
		lines.push(...fed.own.slice(1), ...fed.strings);
	}
	return shell ? { lines } : { lines, runner: name };
}

/**
 * The command piped into `simple`, found by where each sits in the line
 * rather than by its index, since the command model leaves an empty one
 * out but keeps the connector after it. A pipe may end its line, the
 * command it feeds starting the next, so the line breaks after it with
 * no command between are passed over.
 */
function pipedInto(
	line: CommandLine,
	simple: SimpleCommand,
): SimpleCommand | undefined {
	const connectors = line.connectors.filter(
		(connector) => connector.span.end <= simple.span.start,
	);
	let at = connectors.length - 1;
	while (connectors[at]?.op === "\n" && at > 0) {
		const after = connectors[at - 1]?.span.end ?? 0;
		const until = connectors[at]?.span.start ?? 0;
		const between = line.commands.some(
			(command) => command.span.start >= after && command.span.end <= until,
		);
		if (between) break;
		at -= 1;
	}
	const before = connectors[at];
	if (before?.op !== "|" && before?.op !== "|&") return undefined;
	return line.commands
		.filter((command) => command.span.end <= before.span.start)
		.at(-1);
}

/**
 * A command's own words, and the here-strings the command model leaves
 * among them as words: `<<<` and its string, or the two as one.
 */
function hereStrings(argv: string[]): { own: string[]; strings: string[] } {
	const own: string[] = [];
	const strings: string[] = [];
	for (let at = 0; at < argv.length; at += 1) {
		const word = argv[at] ?? "";
		if (word === "<<<") {
			const string = argv[at + 1];
			if (string !== undefined) strings.push(string);
			at += 1;
		} else if (word.startsWith("<<<")) strings.push(word.slice(3));
		else own.push(word);
	}
	return { own, strings };
}

/** Of what a runner runs, only its starts, named by the runner. */
function startsBy(runner: string, writes: WriteCall[]): WriteCall[] {
	return writes
		.filter((write) => write.kind === "start")
		.map((write) => ({ ...write, action: `${runner} ${write.action}` }));
}

/** A command's words, unquoted, from the program it runs past any wrapper. */
export function words(simple: SimpleCommand): string[] {
	return unwrapped(simple.argv.map((word) => unquote(word.text)));
}

/** The writes one command makes, with those of any command it runs. */
function writeIn(argv: string[], dir: string | undefined): WriteCall[] {
	const [program, ...rest] = argv;
	if (program === undefined) return [];
	const name = program.split("/").at(-1) ?? program;
	const launched = launchedBy(name, rest)?.(dir) ?? [];
	// A launcher's own verb still counts when what it runs writes nothing,
	// as `mycelium start ... -- program` does.
	if (launched.length > 0) return launched;
	const write = ownWrite(name, rest, dir);
	return write === undefined ? [] : [write];
}

/** What a command writes itself, apart from any command it runs. */
function ownWrite(
	name: string,
	rest: string[],
	dir: string | undefined,
): WriteCall | undefined {
	if (name === "git") return gitPush(rest, dir);
	if (name === "gh") return ghWrite(rest, dir);
	if (name === "dt") return dtWrite(rest, dir);
	const start = startIn(name, rest);
	if (start) return start;
	for (const [machine, verbs] of MACHINE) {
		if (name !== machine) continue;
		const verb = rest.find((word) => !word.startsWith("-"));
		if (verbs === undefined || (verb !== undefined && verbs.has(verb))) {
			return {
				action: [name, verbs ? verb : undefined].filter(Boolean).join(" "),
				kind: "machine",
			};
		}
	}
	return undefined;
}

/**
 * What a command that runs another command writes (runs.ts): a shell's
 * `-c` line, whatever a launcher runs, or what follows `--` in a
 * `mycelium` call. Of what an opaque runner runs, only its starts count,
 * named by the runner, as where it runs isn't known.
 */
function launchedBy(
	name: string,
	args: string[],
): ((dir: string | undefined) => WriteCall[]) | undefined {
	const ran = runs(name, args);
	if (ran === undefined) return undefined;
	return (dir) => {
		const at = ran.opaque === undefined ? dir : undefined;
		const writes =
			"line" in ran
				? writesInLine(ran.line, at)
				: writeIn(unwrapped(ran.argv), at);
		return ran.opaque === undefined ? writes : startsBy(ran.opaque, writes);
	};
}

/** `git [-C dir] push [options] [remote [refspec...]]`. */
function gitPush(
	args: string[],
	dir: string | undefined,
): WriteCall | undefined {
	let at = 0;
	let where = dir;
	while (at < args.length && (args[at] ?? "").startsWith("-")) {
		const flag = args[at] ?? "";
		if (flag === "-C") {
			const target = args[at + 1];
			if (target !== undefined && where !== undefined)
				where = resolve(where, target);
			at += 2;
			continue;
		}
		at += flag === "-c" ? 2 : 1;
	}
	if (args[at] !== "push") return undefined;
	return pushOf(args.slice(at + 1), where, "git push");
}

function pushOf(
	args: string[],
	dir: string | undefined,
	action: string,
): WriteCall {
	const positional: string[] = [];
	let every = false;
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (word === "--all" || word === "--mirror" || word === "--tags")
			every = true;
		if (word === "-o" || word === "--push-option" || word === "--repo") at += 1;
		else if (!word.startsWith("-")) positional.push(word);
	}
	const [remote, ...refspecs] = positional;
	const branch = every ? undefined : refspecs.map(destination).find(Boolean);
	return {
		action,
		kind: "change",
		...(dir !== undefined ? { dir } : {}),
		...(remote !== undefined ? remotePart(remote) : {}),
		...(branch !== undefined ? { branch } : {}),
	};
}

/** A remote named by name stays for git; one given as a URL names its repo. */
function remotePart(remote: string): { remote: string } | { repo: string } {
	const repo = /[:/]/.test(remote) ? repoOfUrl(remote) : undefined;
	return repo ? { repo } : { remote };
}

/** The branch a refspec pushes to: after the colon, else the whole. */
function destination(refspec: string): string | undefined {
	const bare = refspec.replace(/^\+/, "");
	const target = bare.includes(":") ? bare.slice(bare.indexOf(":") + 1) : bare;
	const branch = target.replace(/^refs\/heads\//, "");
	return branch === "" || branch === "HEAD" ? undefined : branch;
}

/** `gh pr <write>` and `gh api` calls that change a pull request or issue. */
function ghWrite(
	args: string[],
	dir: string | undefined,
): WriteCall | undefined {
	const repoFlag = flagValue(args, ["-R", "--repo"]);
	if (args[0] === "pr" && args[1] !== undefined && PR_WRITES.has(args[1])) {
		return prWrite(`gh pr ${args[1]}`, args.slice(2), dir, repoFlag);
	}
	if (args[0] === "api") return apiWrite(args.slice(1), dir);
	return undefined;
}

/** `dt pr <write>`, `dt submit` and `dt push`, which runs git's. */
function dtWrite(
	args: string[],
	dir: string | undefined,
): WriteCall | undefined {
	const repoFlag = flagValue(args, ["-R", "--repo"]);
	let verbAt = 0;
	while ((args[verbAt] ?? "").startsWith("-")) {
		verbAt += VALUED.has(args[verbAt] ?? "") ? 2 : 1;
	}
	const verb = args[verbAt];
	const rest = args.slice(verbAt + 1);
	if (verb === "pr" && rest[0] !== undefined && PR_WRITES.has(rest[0])) {
		return prWrite(`dt pr ${rest[0]}`, rest.slice(1), dir, repoFlag);
	}
	if (verb === "submit") {
		return {
			action: "dt submit",
			kind: "change",
			...(dir ? { dir } : {}),
			...repoOf(repoFlag),
		};
	}
	if (verb === "push") return pushOf(rest, dir, "dt push");
	return undefined;
}

function prWrite(
	action: string,
	args: string[],
	dir: string | undefined,
	repoFlag: string | undefined,
): WriteCall {
	const target = positionals(args)[0];
	const change = target === undefined ? undefined : changeOf(target);
	const repo = change?.repo ?? repoOf(repoFlag).repo;
	const head = flagValue(args, ["-H", "--head"]);
	const opens = action.endsWith(" create");
	return {
		action,
		kind: opens ? "repo" : "change",
		...(dir !== undefined ? { dir } : {}),
		...(repo !== undefined ? { repo } : {}),
		...(change ? { pr: change.pr } : {}),
		...(head !== undefined
			? { branch: head }
			: !opens && change === undefined && target !== undefined
				? { branch: target }
				: {}),
	};
}

/**
 * `gh api` with a method other than GET, or fields that make gh POST,
 * on a repository's pulls or issues.
 */
function apiWrite(
	args: string[],
	dir: string | undefined,
): WriteCall | undefined {
	const method = flagValue(args, ["-X", "--method"])?.toUpperCase();
	const fields = args.some((word) =>
		["-f", "-F", "--field", "--raw-field", "--input"].includes(word),
	);
	if (method === "GET" || (method === undefined && !fields)) return undefined;
	const path = positionals(args).find((word) => /repos\//.test(word));
	const found = path
		? /repos\/([^/]+\/[^/]+)\/(pulls|issues)(?:\/(\d+))?/.exec(path)
		: null;
	if (!found?.[1]) return undefined;
	return {
		action: "gh api",
		kind: found[3] ? "change" : "repo",
		...(dir !== undefined ? { dir } : {}),
		repo: found[1].toLowerCase(),
		...(found[3] ? { pr: Number(found[3]) } : {}),
	};
}

/** Flags that take a value, so their value isn't read as a positional. */
const VALUED = new Set([
	"-R",
	"--repo",
	"-H",
	"--head",
	"-B",
	"--base",
	"-b",
	"--body",
	"-F",
	"--body-file",
	"-t",
	"--title",
	"-X",
	"--method",
	"-f",
	"--field",
	"--raw-field",
	"--input",
	"-r",
	"--reviewer",
	"-a",
	"--assignee",
	"-l",
	"--label",
	"-m",
	"--message",
	"--subject",
	"--add-label",
	"--remove-label",
	"--add-reviewer",
	"--match-head-commit",
	"--host",
	"--remote",
]);

function positionals(args: string[]): string[] {
	const found: string[] = [];
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (VALUED.has(word)) at += 1;
		else if (!word.startsWith("-")) found.push(word);
	}
	return found;
}

function flagValue(args: string[], names: string[]): string | undefined {
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (names.includes(word)) return args[at + 1];
		const joined = names.find(
			(name) => name.startsWith("--") && word.startsWith(`${name}=`),
		);
		if (joined) return word.slice(joined.length + 1);
	}
	return undefined;
}

function repoOf(flag: string | undefined): { repo?: string } {
	if (flag === undefined) return {};
	const repo = flag.includes("/")
		? (repoOfUrl(flag) ?? flag.toLowerCase())
		: undefined;
	return repo ? { repo } : {};
}

/** Writes in a line the command model can't read, found by pattern. */
function patternWrites(command: string): WriteCall[] {
	const writes: WriteCall[] = [];
	const patterns: ReadonlyArray<readonly [RegExp, string, WriteKind]> = [
		[/\bgit\b[^;&|\n]*\bpush\b/, "git push", "change"],
		[/\b(?:gh|dt)\s+pr\s+(\S+)/, "pr write", "change"],
		[/\bdt\s+(?:submit|push)\b/, "dt push", "change"],
		[
			/\bswitch-system\b|\b(?:nixos|darwin)-rebuild\s+switch\b|\bhome-manager\s+switch\b/,
			"switch",
			"machine",
		],
		[
			/\bsystemctl\b[^;&|\n]*\b(?:re)?(?:start|enable)\b[^;&|\n]*\b(?:pi-host|pi-conversation|mycelium-pi)[-*@]/,
			"pi host start",
			"start",
		],
		[
			/\b(?:node|tsx|bun|deno)\s+(?:\S*\/)?(?:host-(?:cutover|drain|release|take-up|join)|pi-host|pi-carry)\.ts\b/,
			"pi host move",
			"start",
		],
		[/\bpi-packages\s+update\b/, "pi-packages update", "start"],
		[
			/(?:^|[;&|(`]|\b(?:do|then|else|nohup|exec|setsid|command|time|sudo)\b)\s*(?:[\w.~-]*\/)*pi(?:-host|-carry)?(?=[\s;&|)`]|$)(?!\s+(?:--version|-v|--help|-h)\s*(?:$|[;&|)]))/,
			"pi",
			"start",
		],
		[/\bmycelium\s+(?:carry|start|sprout)\b/, "mycelium start", "start"],
	];
	for (const [pattern, action, kind] of patterns) {
		const found = pattern.exec(command);
		if (!found) continue;
		if (action === "pr write" && !PR_WRITES.has(found[1] ?? "")) continue;
		// Where it runs isn't known, so neither is its repository.
		writes.push({ action, kind });
	}
	return writes;
}
