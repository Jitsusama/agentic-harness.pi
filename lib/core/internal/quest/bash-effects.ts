/**
 * What a command does to files without a redirect: the copies, moves,
 * links, directories, clones, downloads and unpacked archives it creates,
 * and the files it removes.
 *
 * Each reader takes an unquoted argv and answers with the paths as the
 * command names them, relative or not, so the caller can place them
 * in the directory the command runs in. A reader reads options the way
 * its command does, since an option's value taken for a destination is a
 * path nobody wrote. What a command writes to standard output names no
 * file and is left to the redirect that catches it.
 */

import { basename, join } from "node:path";

/** What an argv says once its options are read. */
interface Parsed {
	/** Arguments that are not options or option values, in order. */
	readonly operands: string[];
	/** Every value an option was given, by option name. */
	readonly values: Map<string, string[]>;
	/** Options given without a value. */
	readonly flags: Set<string>;
}

/** Which options take a value, short by letter and long by name. */
interface Grammar {
	readonly short?: string;
	readonly long?: readonly string[];
}

/**
 * Read an argv's options against a grammar.
 *
 * Short options cluster (`-sSLo`), and a valued letter takes the rest of
 * its word or, at the end of it, the next word. A long option takes its
 * value after `=` or, when the grammar says it has one, as the next word.
 * Anything after `--` is an operand.
 */
function parse(args: readonly string[], grammar: Grammar): Parsed {
	const operands: string[] = [];
	const values = new Map<string, string[]>();
	const flags = new Set<string>();
	const give = (name: string, value: string): void => {
		values.set(name, [...(values.get(name) ?? []), value]);
	};

	for (let at = 0; at < args.length; at++) {
		const arg = args[at] ?? "";
		if (arg === "--") {
			operands.push(...args.slice(at + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			if (equals > 0) give(arg.slice(2, equals), arg.slice(equals + 1));
			else if (grammar.long?.includes(arg.slice(2))) {
				give(arg.slice(2), args[at + 1] ?? "");
				at++;
			} else flags.add(arg.slice(2));
			continue;
		}
		if (!arg.startsWith("-") || arg === "-") {
			operands.push(arg);
			continue;
		}
		for (let char = 1; char < arg.length; char++) {
			const letter = arg[char] ?? "";
			if (!grammar.short?.includes(letter)) {
				flags.add(letter);
				continue;
			}
			if (char < arg.length - 1) give(letter, arg.slice(char + 1));
			else {
				give(letter, args[at + 1] ?? "");
				at++;
			}
			break;
		}
	}

	return { operands, values, flags };
}

/** The last value an option was given, under any of its names. */
function last(parsed: Parsed, ...names: string[]): string | undefined {
	for (const name of names) {
		const given = parsed.values.get(name);
		if (given?.length) return given[given.length - 1];
	}
	return undefined;
}

/** Whether an option was given, with or without a value. */
function has(parsed: Parsed, ...names: string[]): boolean {
	return names.some(
		(name) => parsed.flags.has(name) || parsed.values.has(name),
	);
}

/**
 * Where `cp`, `mv`, `install` and `ln` put their sources.
 *
 * Into a directory when one is named by `-t`, when the destination ends
 * in a slash, or when there are several sources; otherwise at the
 * destination itself, which may still be a directory the text does not
 * reveal.
 */
function copied(
	sources: string[],
	into: string | undefined,
	dest?: string,
): string[] {
	if (into !== undefined)
		return sources.map((source) => join(into, basename(source)));
	if (dest === undefined || sources.length === 0) return [];
	if (dest.endsWith("/") || sources.length > 1) {
		return sources.map((source) => join(dest, basename(source)));
	}
	return [dest];
}

/** A copier's destinations: `-t` or the last operand. */
function copier(grammar: Grammar): (args: string[]) => string[] {
	return (args) => {
		const parsed = parse(args, grammar);
		const into = last(parsed, "t", "target-directory");
		if (into !== undefined) return copied(parsed.operands, into);
		const sources = parsed.operands.slice(0, -1);
		return copied(sources, undefined, parsed.operands.at(-1));
	};
}

/** The name a download takes from its URL, the way curl and wget do. */
function remoteName(url: string): string {
	const path = url.replace(/[?#].*$/, "").replace(/^[a-z]+:\/\/[^/]*/i, "");
	return basename(path) || "index.html";
}

/** A git URL's repository name, which `git clone` uses for its directory. */
function repositoryName(url: string): string {
	const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
	return trimmed.split(/[/:]/).at(-1) ?? trimmed;
}

/** A path under git's `-C` directories, which apply in order. */
function underGitDirectories(dirs: string[], path: string): string {
	return dirs.reduceRight((inner, dir) => join(dir, inner), path);
}

const GIT_CLONE: Grammar = {
	short: "bocju",
	long: [
		"branch",
		"origin",
		"depth",
		"reference",
		"reference-if-able",
		"separate-git-dir",
		"template",
		"config",
		"jobs",
		"filter",
		"upload-pack",
		"shallow-since",
		"shallow-exclude",
		"bundle-uri",
		"server-option",
	],
};

/** Git's destinations: the directory a clone or a new worktree makes. */
function git(args: string[]): string[] {
	const dirs: string[] = [];
	let at = 0;
	while (at < args.length && args[at]?.startsWith("-")) {
		const option = args[at] ?? "";
		if (option === "-C") dirs.push(args[++at] ?? "");
		else if (option === "-c") at++;
		at++;
	}
	const subcommand = args[at];
	const rest = args.slice(at + 1);

	if (subcommand === "clone") {
		const [url, dir] = parse(rest, GIT_CLONE).operands;
		if (url === undefined) return [];
		return [underGitDirectories(dirs, dir ?? repositoryName(url))];
	}
	if (subcommand === "worktree" && rest[0] === "add") {
		const [path] = parse(rest.slice(1), {
			short: "bB",
			long: ["reason"],
		}).operands;
		return path === undefined ? [] : [underGitDirectories(dirs, path)];
	}
	return [];
}

const CURL: Grammar = {
	short: "ACDEFHKQTUXYbcdemortuwxyz",
	long: [
		"output",
		"output-dir",
		"cookie-jar",
		"dump-header",
		"trace",
		"trace-ascii",
		"header",
		"data",
		"data-binary",
		"data-raw",
		"data-urlencode",
		"json",
		"form",
		"request",
		"user",
		"user-agent",
		"referer",
		"upload-file",
		"write-out",
		"proxy",
		"range",
		"max-time",
		"connect-timeout",
		"retry",
		"cookie",
		"config",
		"cert",
		"key",
		"cacert",
		"url",
	],
};

/** Curl's destinations: `-o`, `-O`, and the files it keeps on the side. */
function curl(args: string[]): string[] {
	const parsed = parse(args, CURL);
	const dir = last(parsed, "output-dir");
	const place = (name: string): string =>
		dir === undefined ? name : join(dir, name);
	const found: string[] = [];
	for (const name of ["o", "output"]) {
		for (const file of parsed.values.get(name) ?? []) {
			if (file !== "-") found.push(place(file));
		}
	}
	if (has(parsed, "O", "remote-name", "remote-name-all")) {
		const urls = [...parsed.operands, ...(parsed.values.get("url") ?? [])];
		found.push(...urls.map((url) => place(remoteName(url))));
	}
	for (const name of [
		"c",
		"cookie-jar",
		"D",
		"dump-header",
		"trace",
		"trace-ascii",
	]) {
		for (const file of parsed.values.get(name) ?? []) {
			if (file !== "-") found.push(file);
		}
	}
	return found;
}

const WGET: Grammar = {
	short: "OPoaetTwUiBQ",
	long: [
		"output-document",
		"directory-prefix",
		"output-file",
		"append-output",
		"user-agent",
		"header",
		"tries",
		"timeout",
		"wait",
		"input-file",
		"post-data",
		"user",
		"password",
		"limit-rate",
	],
};

/** Wget's destinations: `-O`, or each URL's name under `-P`, and its log. */
function wget(args: string[]): string[] {
	const parsed = parse(args, WGET);
	const found: string[] = [];
	const document = last(parsed, "O", "output-document");
	if (document !== undefined) {
		if (document !== "-") found.push(document);
	} else {
		const dir = last(parsed, "P", "directory-prefix");
		for (const url of parsed.operands) {
			const name = remoteName(url);
			found.push(dir === undefined ? name : join(dir, name));
		}
	}
	for (const name of ["o", "output-file", "a", "append-output"]) {
		const log = last(parsed, name);
		if (log !== undefined) found.push(log);
	}
	return found;
}

const TAR: Grammar = {
	short: "fCbTXK",
	long: ["file", "directory", "files-from", "exclude-from"],
};

/**
 * Tar's destinations: the archive it creates or adds to, or the
 * directory it unpacks into.
 *
 * The old spelling bundles its letters without a dash (`tar xzf a.tgz`),
 * each valued letter taking the next word in turn, so it is rewritten
 * into the dashed form before reading.
 */
function tar(args: string[]): string[] {
	const [first, ...rest] = args;
	let words = args;
	if (first !== undefined && /^[a-zA-Z]+$/.test(first)) {
		const valued = [...first].filter((letter) => TAR.short?.includes(letter));
		const plain = [...first].filter((letter) => !TAR.short?.includes(letter));
		const taken = rest.slice(0, valued.length);
		words = [
			...(plain.length ? [`-${plain.join("")}`] : []),
			...valued.flatMap((letter, index) => [`-${letter}`, taken[index] ?? ""]),
			...rest.slice(valued.length),
		];
	}
	const parsed = parse(words, TAR);
	if (has(parsed, "x", "extract", "get")) {
		return [last(parsed, "C", "directory") ?? "."];
	}
	if (has(parsed, "c", "r", "u", "A", "create", "append", "update")) {
		const archive = last(parsed, "f", "file");
		return archive === undefined || archive === "-" ? [] : [archive];
	}
	return [];
}

/** Unzip's destination: the directory it unpacks into, unless it only reads. */
function unzip(args: string[]): string[] {
	const parsed = parse(args, { short: "dP" });
	if (has(parsed, "l", "t", "v", "p", "Z")) return [];
	return [last(parsed, "d") ?? "."];
}

/** Dd's destination, its `of=` operand. */
function dd(args: string[]): string[] {
	return args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3));
}

/** Rsync's destination, its last operand, unless that is on another host. */
function rsync(args: string[]): string[] {
	const parsed = parse(args, {
		short: "efT",
		long: [
			"exclude",
			"include",
			"exclude-from",
			"include-from",
			"files-from",
			"filter",
			"rsh",
			"rsync-path",
			"temp-dir",
			"compare-dest",
			"copy-dest",
			"link-dest",
			"backup-dir",
			"suffix",
			"chmod",
			"chown",
			"log-file",
			"partial-dir",
			"password-file",
			"port",
			"timeout",
			"max-size",
			"min-size",
			"bwlimit",
			"out-format",
		],
	});
	if (parsed.operands.length < 2) return [];
	const dest = parsed.operands.at(-1) ?? "";
	return /^[^/~.]*:/.test(dest) ? [] : [dest];
}

/** Every operand a command creates, once its valued options are skipped. */
function operandsOf(grammar: Grammar): (args: string[]) => string[] {
	return (args) => parse(args, grammar).operands;
}

/** The readers, by command name. */
const CREATORS: Record<string, (args: string[]) => string[]> = {
	cp: copier({ short: "tS", long: ["target-directory", "suffix"] }),
	mv: copier({ short: "tS", long: ["target-directory", "suffix"] }),
	install: (args) => {
		const parsed = parse(args, {
			short: "mogtS",
			long: ["mode", "owner", "group"],
		});
		if (has(parsed, "d", "directory")) return parsed.operands;
		return copier({ short: "mogtS" })(args);
	},
	ln: (args) => {
		const parsed = parse(args, {
			short: "tS",
			long: ["target-directory", "suffix"],
		});
		const [only] = parsed.operands;
		const into = last(parsed, "t", "target-directory");
		if (
			into === undefined &&
			parsed.operands.length === 1 &&
			only !== undefined
		) {
			return [basename(only)];
		}
		return copier({ short: "tS", long: ["target-directory", "suffix"] })(args);
	},
	rsync,
	mkdir: operandsOf({ short: "m", long: ["mode"] }),
	touch: operandsOf({ short: "tdrA", long: ["date", "reference"] }),
	dd,
	git,
	curl,
	wget,
	tar,
	gtar: tar,
	unzip,
};

/** Commands that run the command after them, and how many words they take. */
const WRAPPERS: Record<string, Grammar> = {
	nohup: {},
	time: {},
	command: {},
	exec: {},
	builtin: {},
	nice: { short: "n" },
	env: { short: "uCS" },
	sudo: { short: "ugCDhprtU" },
};

/**
 * The command a wrapper runs, with the wrapper and its options removed.
 *
 * `env` also takes the assignments before the command, and `nice -5` is
 * the old spelling of an adjustment, so neither is read as the command.
 */
export function unwrap(argv: readonly string[]): string[] {
	let words = [...argv];
	for (;;) {
		const grammar = WRAPPERS[words[0] ?? ""];
		if (!grammar) return words;
		let at = 1;
		while (at < words.length) {
			const word = words[at] ?? "";
			if (words[0] === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
				at++;
				continue;
			}
			if (!word.startsWith("-") || word === "-") break;
			if (word === "--") {
				at++;
				break;
			}
			const letter = word[1] ?? "";
			const valued = word.length === 2 && grammar.short?.includes(letter);
			at += valued ? 2 : 1;
		}
		words = words.slice(at);
	}
}

/** The files a command creates without a redirect, as the command names them. */
export function createdBy(argv: readonly string[]): string[] {
	const [name, ...args] = argv;
	const reader = name === undefined ? undefined : CREATORS[name];
	return reader ? reader(args) : [];
}

/** The readers of what a command removes, by command name. */
const REMOVERS: Record<string, (args: string[]) => string[]> = {
	rm: operandsOf({}),
	rmdir: operandsOf({}),
	unlink: operandsOf({}),
	mv: (args) => {
		const parsed = parse(args, {
			short: "tS",
			long: ["target-directory", "suffix"],
		});
		const into = last(parsed, "t", "target-directory");
		return into === undefined ? parsed.operands.slice(0, -1) : parsed.operands;
	},
};

/**
 * The files a command removes, as the command names them. A move removes
 * its sources, since what was there is no longer there.
 */
export function removedBy(argv: readonly string[]): string[] {
	const [name, ...args] = argv;
	const reader = name === undefined ? undefined : REMOVERS[name];
	return reader ? reader(args) : [];
}
