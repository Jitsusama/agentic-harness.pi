/**
 * What a command runs of another command, read from its words alone: the
 * program past any wrapper, and the command a launcher, a shell or a
 * runner of its own kind hands on. The write guard (writes.ts) judges
 * what is found here as it judges any command, so a start of agents is
 * seen however many programs stand in front of it.
 *
 * A runner that hands its command on some way this can't follow to the
 * letter (on another host, in a terminal or a multiplexer, once per
 * input, or from a package) is named as `opaque`, and only the starts in
 * what it runs are kept, without a directory, since where it runs isn't
 * known.
 *
 * The programs known here are a closed list, so one it doesn't know
 * hands its command on unseen: this reads the usual ways a command runs
 * another, and is no wall against a session set on getting past it.
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
	["doas", { letters: "uC", takes: 0 }],
	[
		"ionice",
		{
			letters: "cnp",
			long: new Set(["--class", "--classdata", "--pid", "--pgid", "--uid"]),
			takes: 0,
		},
	],
	["caffeinate", { letters: "wt", takes: 0 }],
]);

/** `command`'s options that look a name up rather than run it. */
const LOOKS_UP = /^-[A-Za-z]*[vV]/;

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

/** flock's options, before the file it locks. */
const FLOCK: Options = {
	letters: "wE",
	long: new Set(["--timeout", "--wait", "--conflict-exit-code"]),
};

/** watch's options, before the command it runs again and again. */
const WATCH: Options = {
	letters: "nq",
	long: new Set(["--interval", "--equexit"]),
};

/** Programs that run a script, and the harness's own that runs a program after its `--`. */
const SCRIPT_RUNNERS = new Set(["node", "tsx", "bun", "deno"]);
const FENCE = /(?:^|\/)pi-fence\.[cm]?[jt]s$/;

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

/**
 * tmux's own options, and the verbs that run a command, by the options
 * of each that take a value, as its manual gives them.
 */
const TMUX: Options = { letters: "cfLST" };
const TMUX_RUNS = new Map<string, Options>(
	(
		[
			[["new-session", "new"], "cefFnstxy"],
			[["new-window", "neww"], "ceFnt"],
			[["split-window", "splitw"], "celtF"],
			[["respawn-pane", "respawnp", "respawn-window", "respawnw"], "cet"],
			[["run-shell", "run"], "cdt"],
			[["send-keys", "send"], "cNt"],
			[["display-popup", "popup"], "bcdehsStTwxy"],
		] as const
	).flatMap(([verbs, letters]) =>
		verbs.map((verb): [string, Options] => [verb, { letters }]),
	),
);

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

/**
 * Privilege wrappers that open a shell of their own, reading stdin, when
 * left with no command: given one of these options, or, for `run0`, any.
 */
const OPENS_SHELL = new Map<string, RegExp>([
	["sudo", /^(-[A-Za-z]*[is][A-Za-z]*|--login|--shell)$/],
	["doas", /^-[A-Za-z]*s[A-Za-z]*$/],
	["run0", /^/],
]);

/** The shell a wrapper with no command opens, standing for any. */
const OPENED = ["sh"];

/** su's long options that hand it a line to run. */
const SU_LINES = new Set(["--command", "--session-command"]);

/** su's long options that take the next word as their value. */
const SU_LONG_VALUED = new Set([
	"--shell",
	"--group",
	"--supp-group",
	"--whitelist-environment",
]);

/** su's short options that take a value, as `-s /bin/zsh` does. */
const SU_VALUED = "sgGw";

/**
 * The line su runs, read as getopt reads its words wherever they sit:
 * from `-c`, alone or in a cluster such as `-lc`, its line the rest of
 * the cluster or else the next word, or from `--command` or
 * `--session-command`; none when it is given no line and opens a shell.
 */
function suLine(args: string[]): string | undefined {
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (word === "--") return undefined;
		if (word.startsWith("--")) {
			const equals = word.indexOf("=");
			const name = equals < 0 ? word : word.slice(0, equals);
			const value = equals < 0 ? undefined : word.slice(equals + 1);
			if (SU_LINES.has(name)) return value ?? args[at + 1];
			if (SU_LONG_VALUED.has(name) && value === undefined) at += 1;
			continue;
		}
		if (!word.startsWith("-") || word === "-") continue;
		for (let letter = 1; letter < word.length; letter += 1) {
			const option = word[letter] ?? "";
			if (option !== "c" && !SU_VALUED.includes(option)) continue;
			const joined = word.slice(letter + 1);
			if (option === "c") return joined === "" ? args[at + 1] : joined;
			if (joined === "") at += 1;
			break;
		}
	}
	return undefined;
}

/**
 * Words from the program they run, past any wrapper; none when a wrapper
 * only looks the program up, as `command -v` does. A wrapper opening a
 * shell with no command, as `sudo -i` and `su` do, runs a shell reading
 * stdin.
 */
export function unwrapped(argv: string[]): string[] {
	let words = argv;
	let at = 0;
	while (at < words.length) {
		// A wrapper given by its path (/usr/bin/env, /run/wrappers/bin/sudo)
		// is the same wrapper, as everything after this reads it.
		const word = (words[at] ?? "").split("/").at(-1) ?? "";
		if (word === "command" && LOOKS_UP.test(words[at + 1] ?? "")) return [];
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
		if (word === "su")
			return suLine(words.slice(at + 1)) === undefined
				? OPENED
				: words.slice(at);
		const wrapper = WRAPPERS.get(word);
		if (wrapper === undefined) break;
		const end = optionsEnd(words, wrapper, at + 1) + wrapper.takes;
		const opens = OPENS_SHELL.get(word);
		if (
			end >= words.length &&
			opens !== undefined &&
			(word === "run0" ||
				words.slice(at + 1, end).some((option) => opens.test(option)))
		)
			return OPENED;
		at = end;
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

/** A shell's long options that take the next word as their value. */
const SHELL_VALUED = new Set(["--rcfile", "--init-file"]);

/** Scripts that are stdin under another name. */
const STDIN = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);

/** Builtins that run a script in the shell they are given in. */
const SOURCES = new Set(["source", "."]);

/**
 * Whether a command runs stdin as script in the shell it is given in, as
 * `source /dev/stdin` does.
 */
export function sourcesStdin(name: string, args: string[]): boolean {
	return SOURCES.has(name) && STDIN.has(args[0] ?? "");
}

/**
 * Where a shell's options end, as it reads them: past `-o` and `-O` and
 * their value, alone or in a cluster, each taking the next word in turn,
 * as in `-euo pipefail` or `-oc pipefail 'line'`, its long
 * options that take one, and a lone `-` or `--`. Whether `-c` was among
 * them, and whether `-s` was, come with it.
 */
function shellOptions(args: string[]): {
	end: number;
	line: boolean;
	stdin: boolean;
} {
	let line = false;
	let stdin = false;
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (word === "--" || word === "-") return { end: at + 1, line, stdin };
		if (/^[-+][A-Za-z]+$/.test(word)) {
			line ||= RUNS_LINE.test(word);
			stdin ||= word.startsWith("-") && word.includes("s");
			at += word.slice(1).replace(/[^oO]/g, "").length;
		} else if (SHELL_VALUED.has(word)) at += 1;
		else if (!word.startsWith("--")) return { end: at, line, stdin };
	}
	return { end: args.length, line, stdin };
}

/**
 * Whether a shell given `args` reads its commands on stdin: given no `-c`
 * line and no script but stdin itself, or told to with `-s`, whatever
 * words follow.
 */
export function readsStdin(args: string[]): boolean {
	const { end, line, stdin } = shellOptions(args);
	if (line) return false;
	const script = args[end];
	return stdin || script === undefined || STDIN.has(script);
}

/** How many launchers deep `ranAtLast` looks before it gives up. */
const LAUNCHED_DEPTH = 8;

/**
 * The words of the program a command runs at last, past every wrapper
 * and every launcher that hands its words on, such as `nice`, `setsid`
 * or `flock`; an opaque runner, or one handing on a line, is where it
 * stops.
 */
export function ranAtLast(argv: string[]): string[] {
	let words = unwrapped(argv);
	for (let depth = 0; depth < LAUNCHED_DEPTH; depth += 1) {
		const [program, ...args] = words;
		if (program === undefined) return words;
		const ran = runs(program.split("/").at(-1) ?? "", args);
		if (ran === undefined || !("argv" in ran) || ran.opaque !== undefined)
			return words;
		words = unwrapped(ran.argv);
	}
	return words;
}

/**
 * Where ssh reads the commands it runs on stdin: given a host and no
 * command, or a shell there that reads its own on stdin.
 */
export function sshReadsStdin(args: string[]): boolean {
	const host = optionsEnd(args, SSH);
	if (host >= args.length) return false;
	const there = args.slice(optionsEnd(args, SSH, host + 1)).join(" ");
	const command = there.split(/\s+/).filter(Boolean);
	if (command.length === 0) return true;
	const [program, ...rest] = ranAtLast(command);
	if (program === undefined) return false;
	return SHELLS.has(program.split("/").at(-1) ?? "") && readsStdin(rest);
}

/** What a command runs of another command, if it runs one. */
export function runs(name: string, args: string[]): Runs | undefined {
	if (SHELLS.has(name)) {
		// The line is the first word past the options, wherever `-c` sat.
		const { end, line } = shellOptions(args);
		const given = line ? args[end] : undefined;
		return given === undefined ? undefined : { line: given };
	}
	if (name === "su") {
		const given = suLine(args);
		return given === undefined ? undefined : { line: given };
	}
	if (name === "eval")
		return args.length === 0 ? undefined : { line: args.join(" ") };
	// jobs-broker is what a fenced session is told to run in place of
	// systemd-run, and like mycelium it runs only what follows `--`.
	if (
		name === "mycelium" ||
		name === "jobs-broker" ||
		(SCRIPT_RUNNERS.has(name) && args.some((word) => FENCE.test(word)))
	) {
		const after = args.indexOf("--");
		return after < 0 ? undefined : { argv: args.slice(after + 1) };
	}
	const ran = LINE_RUNNERS.get(name)?.(args);
	if (ran !== undefined) return ran;
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

/** Programs that run a command of their own, after a lock or again and again. */
const LINE_RUNNERS = new Map<string, (args: string[]) => Runs | undefined>([
	[
		"flock",
		(args) => {
			// Past its options comes the file it locks, then what runs.
			const rest = args.slice(optionsEnd(args, FLOCK) + 1);
			if (rest[0] === "-c" || rest[0] === "--command")
				return rest[1] === undefined ? undefined : { line: rest[1] };
			return argvFrom(rest[0] === "--" ? rest.slice(1) : rest);
		},
	],
	[
		"watch",
		(args) => {
			const at = optionsEnd(args, WATCH);
			const rest = args.slice(at);
			if (rest.length === 0) return undefined;
			const exec = args
				.slice(0, at)
				.some((word) => word === "--exec" || /^-[A-Za-z]*x/.test(word));
			// Without -x, watch hands its words to a shell as one line.
			return exec ? { argv: rest } : { line: rest.join(" ") };
		},
	],
	[
		"script",
		(args) => {
			const flag = args.findIndex(
				(word) => word === "-c" || word === "--command",
			);
			const line = flag < 0 ? undefined : args[flag + 1];
			return line === undefined ? undefined : { line };
		},
	],
]);

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
			// Past ssh's options comes the host, then what runs there, which
			// ssh reads more options and a `--` ahead of, as its own source does.
			const host = optionsEnd(args, SSH);
			const rest = args.slice(optionsEnd(args, SSH, host + 1));
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
			const options = TMUX_RUNS.get(args[verbAt] ?? "");
			if (options === undefined) return undefined;
			const said: string[] = [];
			for (let at = verbAt + 1; at < args.length; at += 1) {
				const word = args[at] ?? "";
				if (word.startsWith("-") && word !== "-") {
					if (takesNext(word, options)) at += 1;
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
	...terminals(),
]);

/**
 * The terminals the harness opens sessions in, each running the command
 * after its `--` or `-e`, or after its own options: kitty, and its
 * remote control's `launch`; wezterm's `start` and `cli spawn`; ghostty,
 * alacritty, foot, xterm and konsole; zellij and niri, past their verbs;
 * and macOS's `open`, past its `--args`.
 */
function terminals(): [string, (args: string[]) => Runs | undefined][] {
	const KITTY: Options = {
		letters: "cdoT",
		long: new Set([
			"--config",
			"--override",
			"--directory",
			"--title",
			"--class",
			"--name",
			"--session",
			"--listen-on",
			"--start-as",
			"--watcher",
		]),
	};
	const LAUNCH: Options = {
		letters: "m",
		long: new Set([
			"--match",
			"--to",
			"--title",
			"--tab-title",
			"--type",
			"--cwd",
			"--env",
			"--var",
			"--location",
			"--next-to",
			"--os-window-title",
			"--os-window-name",
			"--os-window-class",
			"--os-window-state",
			"--color",
			"--spacing",
			"--watcher",
			"--marker",
			"--stdin-source",
			"--source-window",
			"--bias",
			"--logo",
			"--remote-control-password",
		]),
	};
	const WEZTERM: Options = {
		letters: "",
		long: new Set([
			"--cwd",
			"--class",
			"--workspace",
			"--position",
			"--domain",
			"--domain-name",
			"--pane-id",
			"--window-id",
			"--config-file",
			"--config",
		]),
	};
	const FOOT: Options = { letters: "coftTawWDpd" };
	// kitty, or its remote control's launch, past its own options.
	const kitty = (args: string[]): Runs | undefined => {
		if (args[0] === "@") {
			const launch = args.indexOf("launch");
			return launch < 0
				? undefined
				: argvFrom(args.slice(optionsEnd(args, LAUNCH, launch + 1)));
		}
		return argvFrom(args.slice(optionsEnd(args, KITTY)));
	};
	// What follows `-e` or `--`, as most terminals take it.
	const after = (args: string[], flags: string[]): Runs | undefined => {
		const flag = args.findIndex((word) => flags.includes(word));
		return flag < 0 ? undefined : argvFrom(args.slice(flag + 1));
	};
	return [
		["kitty", kitty],
		["kitten", kitty],
		[
			"wezterm",
			(args) => {
				const verb = args.findIndex(
					(word) => word === "start" || word === "spawn",
				);
				return verb < 0
					? undefined
					: argvFrom(args.slice(optionsEnd(args, WEZTERM, verb + 1)));
			},
		],
		["ghostty", (args) => after(args, ["-e"])],
		["alacritty", (args) => after(args, ["-e", "--command"])],
		["xterm", (args) => after(args, ["-e"])],
		["konsole", (args) => after(args, ["-e"])],
		["gnome-terminal", (args) => after(args, ["--"])],
		["foot", (args) => argvFrom(args.slice(optionsEnd(args, FOOT)))],
		["zellij", (args) => after(args, ["--"])],
		[
			"niri",
			(args) => {
				const sh = args.indexOf("spawn-sh");
				if (sh >= 0) {
					const line = args.slice(sh + 1).filter((word) => word !== "--");
					return line.length === 0 ? undefined : { line: line.join(" ") };
				}
				return after(args, ["--"]);
			},
		],
		[
			"open",
			(args) => {
				const passed = args.indexOf("--args");
				return passed < 0
					? undefined
					: after(args.slice(passed + 1), ["-e", "--"]);
			},
		],
	];
}

/** The words a runner runs, or nothing when there are none. */
function argvFrom(argv: string[]): Runs | undefined {
	return argv.length === 0 ? undefined : { argv };
}
