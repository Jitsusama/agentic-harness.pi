/**
 * What a command runs of another command, read from its words alone: the
 * program past any wrapper, and the command a launcher, a shell or a
 * runner of its own kind hands on. The write guard (writes.ts) judges
 * what is found here as it judges any command, so a start of agents is
 * seen however many programs stand in front of it.
 *
 * A runner that hands its command on some way this can't follow to the
 * letter (on another host, in a terminal multiplexer, once per input, or
 * from a package) is named as `opaque`, and only the starts in what it
 * runs are kept, without a directory, since where it runs isn't known.
 */

/** What a command runs: its words, or a line a shell reads. */
export type Runs =
	| { readonly argv: string[]; readonly opaque?: string }
	| { readonly line: string; readonly opaque?: string };

/** Shells, whose `-c` runs a line of its own. */
export const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** A shell's options word that holds `-c`, alone or among others. */
const RUNS_LINE = /^-[A-Za-z]*c[A-Za-z]*$/;

/**
 * A program's options: the single letters that take a value, and the
 * long options that do, written without their `=`.
 */
interface Options {
	readonly letters: string;
	readonly long?: ReadonlySet<string>;
}

/** Words that run the command after them: their options, and how many words they take. */
const WRAPPERS = new Map<string, Options & { readonly takes: number }>([
	["command", { letters: "", takes: 0 }],
	["exec", { letters: "a", takes: 0 }],
	["nohup", { letters: "", takes: 0 }],
	[
		"time",
		{ letters: "fo", long: new Set(["--format", "--output"]), takes: 0 },
	],
	[
		"sudo",
		{
			letters: "CDghprtTuU",
			long: new Set([
				"--user",
				"--group",
				"--prompt",
				"--chdir",
				"--host",
				"--role",
				"--type",
				"--other-user",
				"--close-from",
				"--command-timeout",
			]),
			takes: 0,
		},
	],
	[
		"run0",
		{
			letters: "uDg",
			long: new Set([
				"--user",
				"--group",
				"--nice",
				"--chdir",
				"--setenv",
				"--unit",
				"--property",
				"--description",
				"--slice",
				"--machine",
				"--background",
			]),
			takes: 0,
		},
	],
	[
		"timeout",
		{ letters: "ks", long: new Set(["--kill-after", "--signal"]), takes: 1 },
	],
]);

/** env's options. */
const ENV: Options = {
	letters: "uCS",
	long: new Set(["--unset", "--chdir", "--split-string"]),
};

/**
 * Programs that run another command after their own options, those of
 * their options that take a value, so the command they run is found.
 */
const LAUNCHERS = new Map<string, Options>([
	[
		"systemd-run",
		{
			letters: "upEMH",
			long: new Set([
				"--unit",
				"--property",
				"--slice",
				"--setenv",
				"--description",
				"--working-directory",
				"--machine",
				"--host",
				"--uid",
				"--gid",
				"--nice",
				"--on-active",
				"--on-boot",
				"--on-startup",
				"--on-unit-active",
				"--on-unit-inactive",
				"--on-calendar",
				"--timer-property",
				"--service-type",
			]),
		},
	],
	["setsid", { letters: "" }],
	["nice", { letters: "n", long: new Set(["--adjustment"]) }],
	["stdbuf", { letters: "ioe" }],
]);

/** ssh's options. */
const SSH: Options = { letters: "BbcDEeFIiJLlmOoPpQRSWw" };

/** xargs's options. */
const XARGS: Options = {
	letters: "adEILnPs",
	long: new Set([
		"--arg-file",
		"--delimiter",
		"--max-args",
		"--max-procs",
		"--max-chars",
		"--process-slot-var",
	]),
};

/** npx's options. */
const NPX: Options = {
	letters: "pc",
	long: new Set([
		"--package",
		"--call",
		"--cache",
		"--registry",
		"--userconfig",
		"--prefix",
	]),
};

/** pnpm's options, and the verbs that run a program by name. */
const PNPM: Options = {
	letters: "CF",
	long: new Set([
		"--dir",
		"--filter",
		"--workspace-dir",
		"--reporter",
		"--loglevel",
		"--package",
	]),
};
const PNPM_RUNS = new Set(["exec", "dlx", "x"]);

/** tmux's options, and the verbs that run a command. */
const TMUX: Options = { letters: "cfLSTtsnexyFlNw" };
const TMUX_RUNS = new Set([
	"new-session",
	"new",
	"new-window",
	"neww",
	"split-window",
	"splitw",
	"respawn-pane",
	"respawnp",
	"respawn-window",
	"respawnw",
	"run-shell",
	"run",
	"send-keys",
	"send",
	"display-popup",
	"popup",
]);

/** screen's options, and those that only reach a session already there. */
const SCREEN: Options = { letters: "SctehpTsX" };
const SCREEN_REACHES = new Set([
	"-r",
	"-R",
	"-x",
	"-D",
	"-ls",
	"-list",
	"-wipe",
	"-Q",
	"-X",
]);

/**
 * Where a program's own options end: the index of its first word that
 * isn't one, past a `--`. A short option whose last letter takes a value
 * takes the next word; one whose value follows its letter, or a long
 * option written with `=`, takes none.
 */
function optionsEnd(args: string[], options: Options, from = 0): number {
	let at = from;
	while (at < args.length) {
		const word = args[at] ?? "";
		if (word === "--") return at + 1;
		if (!word.startsWith("-") || word === "-") return at;
		at += takesNext(word, options) ? 2 : 1;
	}
	return at;
}

/** Whether an option word takes the word after it as its value. */
function takesNext(word: string, options: Options): boolean {
	if (word.startsWith("--"))
		return !word.includes("=") && (options.long?.has(word) ?? false);
	const letters = word.slice(1);
	for (let at = 0; at < letters.length; at += 1) {
		if (options.letters.includes(letters[at] ?? ""))
			return at === letters.length - 1;
	}
	return false;
}

/** Words from the program they run, past any wrapper. */
export function unwrapped(argv: string[]): string[] {
	let words = argv;
	let at = 0;
	while (at < words.length) {
		const word = words[at] ?? "";
		if (word === "env") {
			at += 1;
			while (at < words.length) {
				const next = words[at] ?? "";
				const split = splitString(next, words[at + 1]);
				if (split !== undefined) {
					const after = next === "-S" || next === "--split-string" ? 2 : 1;
					words = [...words.slice(0, at), ...split, ...words.slice(at + after)];
					break;
				}
				if (next.startsWith("-")) at += takesNext(next, ENV) ? 2 : 1;
				else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) at += 1;
				else break;
			}
			continue;
		}
		if (word === "direnv" && words[at + 1] === "exec") {
			at += 3;
			continue;
		}
		const wrapper = WRAPPERS.get(word);
		if (wrapper === undefined) break;
		at = optionsEnd(words, wrapper, at + 1) + wrapper.takes;
	}
	return words.slice(at);
}

/** The words `env -S` splits its string into, when this is that option. */
function splitString(
	word: string,
	next: string | undefined,
): string[] | undefined {
	const value =
		word === "-S" || word === "--split-string"
			? next
			: word.startsWith("--split-string=")
				? word.slice("--split-string=".length)
				: word.startsWith("-S")
					? word.slice(2)
					: undefined;
	return value?.split(/\s+/).filter(Boolean);
}

/** What a command runs of another command, if it runs one. */
export function runs(name: string, args: string[]): Runs | undefined {
	if (SHELLS.has(name)) {
		const flag = args.findIndex((word) => RUNS_LINE.test(word));
		const line = flag < 0 ? undefined : args[flag + 1];
		return line === undefined ? undefined : { line };
	}
	if (name === "mycelium") {
		const after = args.indexOf("--");
		return after < 0 ? undefined : { argv: args.slice(after + 1) };
	}
	if (name === "nix") return nixRuns(args);
	if (name === "nix-shell") {
		const flag = args.findIndex(
			(word) => word === "--run" || word === "--command",
		);
		const line = flag < 0 ? undefined : args[flag + 1];
		return line === undefined ? undefined : { line };
	}
	const opaque = OPAQUE.get(name);
	if (opaque !== undefined) {
		const ran = opaque(args);
		return ran === undefined ? undefined : { ...ran, opaque: name };
	}
	const launcher = LAUNCHERS.get(name);
	return launcher === undefined
		? undefined
		: { argv: args.slice(optionsEnd(args, launcher)) };
}

/** `nix shell …` and `nix develop …`, whose `-c` runs the words after it. */
function nixRuns(args: string[]): Runs | undefined {
	if (args[0] !== "shell" && args[0] !== "develop") return undefined;
	const flag = args.findIndex((word) => word === "-c" || word === "--command");
	return flag < 0 ? undefined : { argv: args.slice(flag + 1) };
}

/** Each opaque runner, and how it hands on what it runs. */
const OPAQUE = new Map<string, (args: string[]) => Runs | undefined>([
	[
		"ssh",
		(args) => {
			// Past ssh's options comes the host, then what runs there.
			const rest = args.slice(optionsEnd(args, SSH) + 1);
			return rest.length === 0 ? undefined : { line: rest.join(" ") };
		},
	],
	["xargs", (args) => argvFrom(args.slice(optionsEnd(args, XARGS)))],
	[
		"npx",
		(args) => {
			const call = args.findIndex((word) => word === "-c" || word === "--call");
			const line = call < 0 ? undefined : args[call + 1];
			if (line !== undefined) return { line };
			return argvFrom(args.slice(optionsEnd(args, NPX)));
		},
	],
	[
		"pnpm",
		(args) => {
			const verbAt = optionsEnd(args, PNPM);
			const verb = args[verbAt];
			if (verb === undefined) return undefined;
			// pnpm runs a program by name where no script or verb has it.
			if (!PNPM_RUNS.has(verb)) return { argv: args.slice(verbAt) };
			return argvFrom(args.slice(optionsEnd(args, PNPM, verbAt + 1)));
		},
	],
	[
		"tmux",
		(args) => {
			const verbAt = optionsEnd(args, TMUX);
			const shell = args.findIndex((word, at) => at < verbAt && word === "-c");
			if (shell >= 0 && args[shell + 1] !== undefined)
				return { line: args[shell + 1] ?? "" };
			const verb = args[verbAt];
			if (verb === undefined || !TMUX_RUNS.has(verb)) return undefined;
			const said: string[] = [];
			for (let at = verbAt + 1; at < args.length; at += 1) {
				const word = args[at] ?? "";
				if (word.startsWith("-") && word !== "-") {
					if (takesNext(word, TMUX)) at += 1;
					continue;
				}
				said.push(word);
			}
			return said.length === 0 ? undefined : { line: said.join(" ") };
		},
	],
	[
		"screen",
		(args) => {
			if (args.some((word) => SCREEN_REACHES.has(word))) return undefined;
			return argvFrom(args.slice(optionsEnd(args, SCREEN)));
		},
	],
]);

/** The words a runner runs, or nothing when there are none. */
function argvFrom(argv: string[]): Runs | undefined {
	return argv.length === 0 ? undefined : { argv };
}
