/**
 * A shell command read as its steps: heredocs and quotes set aside, and
 * the steps that only look at work rather than run it left out.
 */

/** A heredoc's body, from the line after `<<WORD` to WORD alone. */
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;

/** A quoted string: single quotes, or double with its escapes. */
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

/** Where a shell command's steps end. */
const STEPS = /\n|;|&&|\|\|/;

/**
 * A command's steps as the shell runs them: quoted prose and heredocs
 * blanked, and the steps that only look left out.
 */
export function runSteps(command: string): string[] {
	return shellSteps(command).filter((step) => !onlyLooks(step));
}

/**
 * Whether a step only looks, past what it runs under: a step finding a
 * tool, as `direnv exec . which changed-checks` does, or asking it how
 * it is called, as `changed-checks --help` does, runs none of its work.
 * On 10 November those three waited 964 s, 104 s and 754 s for a turn
 * as a run of changed-checks, while memory was short.
 */
function onlyLooks(step: string): boolean {
	let bare = step.replace(ASSIGNMENTS, "");
	for (let under = UNDER.exec(bare); under; under = UNDER.exec(bare)) {
		bare = bare.slice(under[0].length);
	}
	return LOOKS.test(bare) || asksHowToCall(bare);
}

/**
 * What a step runs under, as its first words: a subshell or a
 * substitution it opens, a loop over what one finds, a time limit, a
 * changed environment, or direnv's environment for a folder. A time
 * limit's options read one way only: `-s` and `-k` take the word after
 * them and no other option is read as either.
 */
const UNDER =
	/^\s*(?:\(\s*|\$\(\s*|for\s+\w+\s+in\s+\$\(\s*|timeout(?:\s+-[sk]\s+\S+|\s+--\w[\w-]*(?:=\S+)?|\s+-(?![sk](?:\s|$))\w[\w-]*(?:=\S+)?)*\s+\S+\s+|env(?:\s+-u\s+\S+|\s+-i|\s+[A-Za-z_]\w*=\S*)*\s+|direnv\s+exec\s+\S+\s+)/;

/** The flags that ask a tool how it is called or which version it is. */
const ASKS = new Set(["--help", "-h", "--version"]);

/** Whether a step's arguments, up to what it writes to, only ask {@link ASKS}. */
function asksHowToCall(step: string): boolean {
	const args: string[] = [];
	for (const word of step.trim().split(/\s+/).slice(1)) {
		if (/^(?:\d|&)?>|^[|;&)]/.test(word)) break;
		args.push(word);
	}
	return args.length > 0 && args.every((arg) => ASKS.has(arg));
}

/**
 * A quoted string or an escaped character, kept as it is, or a comment:
 * a `#` starting a word outside quotes, to the end of its line, which the
 * shell never runs. `$#`, `${#x}` and `.#checks` start no word.
 */
const COMMENT = /'[^']*'|"(?:[^"\\]|\\.)*"|\\[\s\S]|(^|[\s;&|()])#[^\n]*/g;

/**
 * A command with its heredocs' bodies and its comments taken out. On 22
 * November a `# cargo check` comment beside two systemd-run starts held
 * the whole command as a build (48UZ44).
 */
function withoutComments(command: string): string {
	return command
		.replace(HEREDOC, "\n")
		.replace(COMMENT, (match, before: string | undefined) =>
			before === undefined ? match : before,
		);
}

/** A command's steps as the shell runs them, quoted prose, comments and heredocs blanked. */
export function shellSteps(command: string): string[] {
	return (
		withoutComments(command)
			// A pipe or a semicolon inside the word is its own, as in
			// `pgrep -af 'run-subtests|changed-checks'`, and splits no step.
			// Spaces only inside a `$(...)`, as in a flake pinned with
			// `?rev=$(git rev-parse HEAD)`, still make one word.
			.replace(QUOTED, (quoted) =>
				/\s/.test(quoted.replace(/\$\([^()]*\)/g, ""))
					? "''"
					: quoted.slice(1, -1).replace(/[|;&]/g, " "),
			)
			.split(SEGMENTS)
	);
}

/** Where a command's steps and the parts of its pipes end. */
const SEGMENTS = /\n|;|&&|\|\|?/;

/**
 * A git command that only reads the history, past options such as
 * `-C <dir>` and `--no-pager`: `git grep -n 'changed-checks' origin/main`
 * waited 51 s for a turn as an evaluation of every check. Each option
 * reads one way only, as in world-walk.ts's `GIT_WALK`: `-c` and `-C`
 * take the word after them and no other option is read as either, so a
 * long run of options before a subcommand that isn't a read fails at
 * once rather than trying every way to split them.
 */
const GIT_READS = String.raw`git(?:\s+(?:-C\s+\S+|-c\s+\S+|--\w[\w-]*(?:=\S+)?|-(?![cC](?:\s|$))\w[\w-]*(?:=\S+)?))*\s+(?:grep|log|show|diff|blame|status|ls-files|ls-tree|rev-parse|rev-list|cat-file|shortlog|describe|merge-base)\b`;

/**
 * A step whose command finds processes or text, or reports on them, or
 * reads a file, a path or git's history, as
 * `readlink -f $d/bin/nixos-test-driver` does without running the driver.
 */
const LOOKS = new RegExp(
	String.raw`^\s*(?:sudo\s+)?(?:(?:pgrep|pkill|pidof|ps|kill|killall|grep|egrep|fgrep|rg|systemctl|journalctl|echo|printf|which|whereis|type|readlink|realpath|ls|stat|file|cat|head|tail|wc|test)\b|command\s+-[vV]\b|\[\s|${GIT_READS})`,
);

/**
 * Variables set at the start of a step, as `A=1 B="two" cmd` sets two.
 * One set from `$(` leaves the command inside, since that is what the
 * step runs: `w=$(readlink -f x)` reads, `d=$(nix build ...)` builds.
 */
const ASSIGNMENTS =
	/^\s*(?:export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:\$\(\s*|(?:"[^"]*"|'[^']*'|\S*)(?:\s+|$)))+/;

/** A command's steps, in order, each whole, never a line of a heredoc or a comment. */
export function stepsOf(command: string): string[] {
	return withoutComments(command)
		.split(STEPS)
		.map((step) => step.replace(ASSIGNMENTS, "").trim())
		.filter((step) => step !== "");
}
