/**
 * The shapes a credential takes in a tool's output, and how one is put out
 * of sight.
 *
 * Each shape is one a service prints for a credential it issues, or the
 * place a credential sits in a file, so plain text, hashes and code read
 * the same as before. A shape that also matches ordinary output (a hash, a
 * function's name) would cost the agent more than it saves, so a shape with
 * no prefix of its own is kept to a name that says it holds a secret.
 *
 * Some credentials have no shape at all: a gateway's token or a proxy's
 * key is any long string. The session holds those in its own variables,
 * so each such variable's value is put out of sight wherever it appears,
 * named by the variable.
 */

import {
	hidden,
	looksLikeSecret,
	replaceWords,
	scrubbedMark,
	unescapedMarks,
} from "./words.ts";

export { scrubbedMark };

/** One shape: what it matches, what it is called, and what it keeps. */
interface SecretShape {
	readonly kind: string;
	readonly pattern: RegExp;
	/** How many leading groups name where the secret sits, kept as they are. */
	readonly keeps?: number;
}

/** A value long enough, and mixed enough, to be a credential's. */
const CREDENTIAL_VALUE = String.raw`(?=[^\s'"]*\d)(?=[^\s'"]*[A-Za-z])(?![$<{%])[^\s'"]{16,}`;

const SHAPES: readonly SecretShape[] = [
	{
		kind: "private key",
		pattern:
			/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
	},
	{ kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
	{ kind: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
	{ kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ kind: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ kind: "OpenAI key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
	{ kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ kind: "Google refresh token", pattern: /\b1\/\/0[A-Za-z0-9_-]{30,}/g },
	{ kind: "Google access token", pattern: /\bya29\.[A-Za-z0-9_-]{20,}/g },
	{ kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "Slack token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g },
	{ kind: "Slack token", pattern: /\bxapp-\d-[A-Za-z0-9-]{10,}/g },
	{ kind: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
	{ kind: "Shopify token", pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
	{ kind: "age identity", pattern: /\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g },
	{
		kind: "JSON web token",
		pattern:
			/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	},
	{
		kind: "bearer token",
		pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
		keeps: 1,
	},
	{
		kind: "credential",
		pattern: new RegExp(
			String.raw`(\bauthorization\s*[:=]\s*['"]?(?:[A-Za-z]+\s+)?)${CREDENTIAL_VALUE}`,
			"gi",
		),
		keeps: 1,
	},
	{
		// A git remote or a registry's address can carry its password or
		// token after the user's name, whatever its shape.
		kind: "credential",
		pattern: /(:\/\/[^/\s:@]+:)[^@\s]{16,}(@)/g,
		keeps: 2,
	},
	{
		kind: "AWS secret key",
		pattern:
			/(\baws_(?:secret_access_key|session_token)\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{16,}/gi,
		keeps: 1,
	},
	{
		kind: "npm token",
		pattern: new RegExp(
			String.raw`(_authToken\s*=\s*)${CREDENTIAL_VALUE}`,
			"g",
		),
		keeps: 1,
	},
	{
		kind: "credential",
		pattern:
			/("(?:access_token|refresh_token|id_token|client_secret|private_key|password)"\s*:\s*")[^"]{16,}(")/g,
		keeps: 2,
	},
	{
		// A shell's assignment, env's line, launchctl print's `NAME => value`
		// and a JSON or YAML field all put the name before the value, so the
		// name says what the value is, whatever sits between them. A public
		// key is no secret.
		kind: "credential",
		pattern: new RegExp(
			String.raw`(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTH_HEADER|APIKEY|(?<!PUBLIC)_KEY)['"]?\s*(?:=>?|:)\s*['"]?)${CREDENTIAL_VALUE}`,
			"g",
		),
		keeps: 1,
	},
];

/**
 * Whether a shell command prints the environment: env or printenv on their
 * own, by any path and with only options or assignments after env; a
 * shell's export, declare or set listing, bare or with its flags;
 * systemd's or launchd's environment, a process's environ, ps with its e
 * flag, or a script the command holds (`python3 -c`, `node -e`, a
 * heredoc, or one piped to an interpreter) reading its whole environment. A command run under env,
 * as `env FOO=1 cargo test`, prints only what it prints, and so does a
 * search for `process.env`. It errs towards a dump, since a dump read as
 * ordinary output shows every value no shape knows.
 */
export function dumpsEnvironment(command: string): boolean {
	if (ENVIRONMENT_DUMPS.some((dump) => dump.test(command))) return true;
	return (
		INLINE_SCRIPT.test(command) &&
		WHOLE_ENVIRONMENT.some((read) => read.test(command))
	);
}

/**
 * A value in a command: quoted whole, or a run of what ends no word. Each
 * use takes it whole, through a lookahead and a backreference, so it is
 * never cut short at a quote to end the command early, nor tried at
 * every length.
 */
const COMMAND_VALUE = String.raw`(?:'[^']*'|"[^"]*"|[^\s;&|)<>'"\`#}])*`;

/**
 * One of env's own words: flags ending in one that takes a value, given
 * it or the next word; a long option taking the next word or its own;
 * any other option; or an assignment, quoted whole or not. The first form
 * that fits is the one read.
 */
const ENV_WORD = [
	String.raw`-[0-9A-Za-z]*[uCSPLU]\s*(?=[^\s-])${COMMAND_VALUE}`,
	String.raw`--(?:unset|chdir|split-string)(?:=|\s+)${COMMAND_VALUE}`,
	String.raw`-[0-9A-Za-z-]+(?:=${COMMAND_VALUE})?`,
	String.raw`[A-Za-z_][A-Za-z0-9_]*=${COMMAND_VALUE}`,
	String.raw`'[A-Za-z_][A-Za-z0-9_]*=[^']*'`,
	String.raw`"[A-Za-z_][A-Za-z0-9_]*=[^"]*"`,
].join("|");

/**
 * env on its own: by any path, then only its own words, then the
 * command's end. Each word is taken whole, through a lookahead and a
 * backreference, so a long run of them is read one way.
 */
const ENV_ALONE = new RegExp(
	String.raw`(?:^|[\s;&|('"\`{])(?:[^\s;&|('"\`{]*\/)?env` +
		String.raw`(?:\s+(?=(${ENV_WORD}))\1)*` +
		// A quote ends it, as `sh -c 'env'` does, unless it opens a word.
		String.raw`\s*(?:$|[\n|;&)<>#\`}]|\d+>` +
		String.raw`|['"](?![A-Za-z_][A-Za-z0-9_]*=))`,
);

/** The commands that print the environment, as `dumpsEnvironment` says. */
const ENVIRONMENT_DUMPS: readonly RegExp[] = [
	ENV_ALONE,
	/(?:^|[\s;&|('"`{])(?:[^\s;&|('"`{]*\/)?printenv\b/,
	/(?:^|[\s;&|('"`{])(?:export|declare|typeset)\s+-[A-Za-z]*[px]/,
	/(?:^|[\n;&|('"`{]|\b(?:command|builtin|then|do|else|time|exec)\s|-[A-Za-z]*c\s+|\bssh\s+(?:\S+\s+)*?)\s*(?:export|declare|typeset|set)\s*(?:$|[\n|;&)<>#'"`}]|\d+>)/,
	/\bshow-environment\b/,
	/\blaunchctl\s+(?:print|getenv|export|procinfo)\b/,
	/\/proc\/\S*\/environ\b/,
	/(?:^|[\s;&|('"`])ps\s+(?:-\S*e\S*\s+-\S*w|\S*e\S*w|\S*w\S*e)/,
	// macOS's ps prints the environment with -E.
	/(?:^|[\s;&|('"`])ps\s+(?:[^\s|;&]+\s+)*-[A-Za-z]*E/,
	// A program's own `;` and `|` sit inside its quotes, so these read on.
	/\b[gnm]?awk\b[^\n]*\bENVIRON\b/,
	/\bjq\b[^\n]*(?:\$ENV\b|(?<![.\w$])env\b(?!\.))/,
	/\b(?:docker|podman)\s+(?:(?:container|image)\s+)?inspect\b/,
	/\bdocker(?:\s+|-)compose\b[^\n]*\bconfig\b/,
	/\bsystemctl\b[^\n]*\bshow\b[^\n]*\bEnvironment\b/,
	/\bkubectl\b[^\n]*\bset\s+env\b[^\n]*--list\b/,
	/\bheroku\s+config\b(?!:(?:set|unset|add|remove))/,
];

/**
 * An interpreter run on code the command itself holds: given it as an
 * argument on its line, written in a heredoc whatever then runs it, or
 * piped to one however it is wrapped or flagged.
 */
const INLINE_SCRIPT =
	/(?:^|[\s;&|('"`/])(?:python[\d.]*|node(?:js)?|deno|bun|ruby|perl|php|irb)[ \t]+(?:[^|;&\s]+[ \t]+)*?(?:-[A-Za-z]*[ecprE]\b|--(?:eval|print)\b|eval\b|-(?=\s|$))|<<|\|[^|;&\n]*?(?<![\w.-])(?:python[\d.]*|node(?:js)?|deno|bun|ruby|perl|php|irb)(?![\w.-])/;

/** An inline script's whole environment, as against one variable by name. */
const WHOLE_ENVIRONMENT: readonly RegExp[] = [
	/\bos\.environb?\b(?!\s*\[|\s*\.\s*(?:get|setdefault|pop)\b)/,
	/\bfrom\s+os\s+import\s+[^;\n]*\benviron\b/,
	/\b(?:process|Bun)\.env\b(?!\s*\[|\s*\??\.\s*[A-Za-z_$])/,
	/\bDeno\.env\.toObject\b/,
	/%ENV\b/,
	/\bENV\s*\.\s*(?:to_h|to_a|to_hash|to_s|inspect|values|each\w*|map|select|sort\w*)\b/,
	/\b(?:p|pp|puts|print)\s*\(?\s*ENV\b(?!\s*\[)/,
	/\bgetenv\(\s*\)/,
	/\$_(?:ENV|SERVER)\b(?!\s*\[)/,
];

/**
 * A line of output that sets one variable and nothing more, as a dump
 * prints each, its value quoted or as env prints it, spaces and all: not
 * a log line of several pairs, nor a pin like `a==1`. A terminal's
 * escapes opening it, a colour, a cleared line or a character set, are
 * read past, as a terminal shows the line without them. Each rule below
 * reads a control sequence, a character set and a cursor's escape as
 * `words.ts`'s ESCAPE does, written out in it.
 */
const ASSIGNED_LINE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is read past.
	/^[ \t]*(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>])[ \t]*)*(?:export[ \t]+|declare[ \t]+-[-A-Za-z]+[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=(?!=)(?:'[^']*'[ \t]*$|"[^"]*"[ \t]*$|(?![^\n\r\0]*\s[A-Za-z_][A-Za-z0-9_]*=))/;

/** The fewest such lines that make an output a dump, whatever printed it. */
const FEWEST_DUMPED_LINES = 5;

/**
 * Whether an output reads as a printing of the environment, whatever
 * printed it: at least five lines setting a variable, making up at least
 * half its lines that hold anything, or five such lines in a row. A line
 * ends at a newline or at a NUL, as `env -0` ends each. Each stretch a
 * carriage return ends, as a progress line redrawn over, is read on its
 * own for setting a variable, five in a row making a dump, but one
 * setting the name the stretch before it set is that line redrawn and
 * adds none; towards the half, a line counts once, and as setting one
 * when any stretch of it does, so a meter redrawn between a dump's lines
 * doesn't thin it out and one redrawn line alone makes none. A command no rule knows, as a
 * script or a program of the agent's own, still prints a dump this way.
 */
export function readsAsDump(text: string): boolean {
	if (!text.includes("=")) return false;
	let lines = 0;
	let assigned = 0;
	let run = 0;
	let named: string | undefined;
	let filled = false;
	let sets = false;
	let start = 0;
	for (let at = 0; at <= text.length; at++) {
		const code = at < text.length ? text.charCodeAt(at) : NEWLINE;
		if (code !== NEWLINE && code !== RETURN && code !== NUL) continue;
		const stretch = text.slice(start, at);
		start = at + 1;
		if (stretch.trim() !== "") {
			filled = true;
			if (ASSIGNED_LINE.test(stretch)) {
				sets = true;
				const name = SET_NAME.exec(stretch)?.[1];
				if (name !== named) run++;
				named = name;
				if (run >= FEWEST_DUMPED_LINES) return true;
			} else {
				run = 0;
				named = undefined;
			}
		}
		if (code !== RETURN) named = undefined;
		if (code !== RETURN && filled) {
			lines++;
			if (sets) assigned++;
			filled = false;
			sets = false;
		}
	}
	return assigned >= FEWEST_DUMPED_LINES && assigned * 2 >= lines;
}

/** The name a line setting a variable sets, read from its start. */
const SET_NAME =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is read past.
	/^[ \t]*(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>])[ \t]*)*(?:export[ \t]+|declare[ \t]+-[-A-Za-z]+[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)/;

const NEWLINE = 10;
const RETURN = 13;
const NUL = 0;

/**
 * A variable's line in a dump: its name, what sits between, its value,
 * escapes within it included, as a highlight splits a value.
 */
const DUMPED_VARIABLE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is read past.
	/^([ \t]*(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>])[ \t]*)*(?:export[ \t]+|declare[ \t]+-[-A-Za-z]+[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:=>|=)[ \t]*['"]?)((?:[^\s'"\x1b]|\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>]))+)/gm;

/**
 * The dump with every value that could be a credential put out of sight,
 * whatever its variable is called: a dump holds what no shape knows, as a
 * proxy's key under a name of its maker's choosing. A variable's value is
 * named by the variable, and a bare value, as launchctl getenv prints, as
 * an environment value. Paths and addresses read as they did. Each of
 * `env -0`'s NUL-ended entries is read as a line of its own. The marks
 * this scrub made are `marked`'s kinds, each a variable's added here.
 */
function scrubDump(
	text: string,
	kinds: string[],
	marked: Set<string>,
): string {
	return eachEntry(text, (entry) =>
		replaceWords(
			scrubAssigned(entry, kinds, marked),
			(word: string) => {
				const mark = hidden(word, ENVIRONMENT_VALUE);
				if (mark === undefined) return word;
				kinds.push(ENVIRONMENT_VALUE);
				return mark;
			},
			marked,
		),
	);
}

/**
 * An output read as a dump only by its lines, with each line that sets
 * one variable read as a dump and every other line left as it is, since
 * nothing says the rest is the environment.
 */
function scrubDumpedLines(
	text: string,
	kinds: string[],
	marked: Set<string>,
): string {
	if (!text.includes("=")) return text;
	return text.replace(EACH_LINE, (line: string) =>
		ASSIGNED_LINE.test(line) ? scrubDump(line, kinds, marked) : line,
	);
}

/** Each line of an output, ended by a newline, a return or env -0's NUL. */
const EACH_LINE = /[^\n\r\0]+/g;

/**
 * A partial with its last line, still being written, put out of sight
 * from where it sets a variable, however short the value so far: the rest
 * of a credential has yet to arrive to make it look like one, and the
 * settled answer replaces the partial. A dump's line is read however it
 * sets its value apart, as DUMPED_VARIABLE reads it.
 */
function scrubOpenLine(text: string, kinds: string[], dump: boolean): string {
	const start =
		Math.max(
			text.lastIndexOf("\n"),
			text.lastIndexOf("\r"),
			text.lastIndexOf("\0"),
		) + 1;
	const open = (dump ? OPEN_DUMPED_VALUE : OPEN_VALUE).exec(text.slice(start));
	if (!open) return text;
	const [, before = "", name = "", value = ""] = open;
	if (ONLY_MARKS.test(value)) return text;
	kinds.push(name);
	return `${text.slice(0, start)}${before}${scrubbedMark(name)}`;
}

/**
 * A line setting one variable, as ASSIGNED_LINE reads one, up to its
 * value, and the value so far, to the line's end: a pin, a spaced `=` or
 * a log line of several pairs is no variable's.
 */
const OPEN_VALUE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is read past.
	/^([ \t]*(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>])[ \t]*)*(?:export[ \t]+|declare[ \t]+-[-A-Za-z]+[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(?!=)['"]?)((?<=['"])[^\n]+|(?![^\n]*\s[A-Za-z_][A-Za-z0-9_]*=)[^\s'"][^\n]*)$/;

/** A dump's line setting a variable, as DUMPED_VARIABLE reads one. */
const OPEN_DUMPED_VALUE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's escape is read past.
	/^([ \t]*(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-9A-Za-z]|[78=>])[ \t]*)*(?:export[ \t]+|declare[ \t]+-[-A-Za-z]+[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:=>|=)[ \t]*['"]?)(\S[^\n]*)$/;

/** A value that is marks alone, already out of sight. */
const ONLY_MARKS = /^(?:\[secret scrubbed: [^\]\n]*\][ \t'"]*)+$/;

/** The text with each variable's value that could be a credential scrubbed. */
function scrubAssigned(
	text: string,
	kinds: string[],
	marked: Set<string>,
): string {
	return text.replace(
		DUMPED_VARIABLE,
		(whole: string, before: string, name: string, value: string) => {
			const mark = hidden(value, name);
			if (mark === undefined) return whole;
			kinds.push(name);
			marked.add(name);
			return `${before}${mark}`;
		},
	);
}

/** The text with `scrub` applied to each of its NUL-ended entries. */
function eachEntry(text: string, scrub: (entry: string) => string): string {
	if (!text.includes("\0")) return scrub(text);
	return text.split("\0").map(scrub).join("\0");
}

/** What a dump's bare value is called where it was scrubbed. */
const ENVIRONMENT_VALUE = "environment value";

/** How a text is read: as any output, or as a dump of the environment. */
export interface ScrubOptions {
	/** The text is a command's printing of the environment. */
	readonly environment?: boolean;
	/**
	 * The text is part of an answer still streaming, which its settled
	 * answer replaces: each line setting one variable is read as a dump's
	 * however few there are, since a viewer sees it before five arrive.
	 */
	readonly partial?: boolean;
}

/**
 * How a call's answer is read, from the call's input: as a printing of the
 * environment when the input is a shell command that prints it, and as
 * ordinary output otherwise, whatever the input is.
 */
export function scrubOptionsOf(input: unknown): ScrubOptions {
	if (typeof input !== "object" || input === null) {
		return { environment: false };
	}
	const command: unknown = Reflect.get(input, "command");
	return {
		environment: typeof command === "string" && dumpsEnvironment(command),
	};
}

/** The parts of a tool's answer that carry what it printed. */
export interface ToolAnswer<Part, Details, Structured> {
	/** The call failed, as one that throws is answered with its words. */
	readonly isError?: boolean;
	readonly content?: readonly Part[];
	readonly details?: Details;
	readonly structuredContent?: Structured;
}

/** What `scrubToolResult` answers with: the answer's fields, scrubbed. */
export interface ScrubbedAnswer<Part, Details, Structured> {
	content?: Part[];
	details?: Details;
	structuredContent?: Structured;
}

/**
 * A tool's answer with every credential in its text, details and
 * structured answer put out of sight, read as the call's input says (see
 * `scrubOptionsOf`): only the fields the answer has, or undefined when it
 * held nothing to hide. A picture is handed on as it is. The secret-scrub
 * extension and a host's tool round both answer with it, so a hosted
 * conversation is scrubbed alike whether or not it loads the extension.
 */
export function scrubToolResult<
	Part extends { readonly type: string },
	Details,
	Structured,
>(
	answer: ToolAnswer<Part, Details, Structured>,
	input: unknown,
	known: readonly KnownSecret[] = knownSecrets(),
): ScrubbedAnswer<Part, Details, Structured> | undefined {
	return scrubAnswer(answer, scrubOptionsOf(input), known);
}

/**
 * A streamed update of a tool's answer scrubbed as `scrubToolResult`
 * scrubs a settled one, with each line setting one variable to a value
 * that could be a credential scrubbed too, however few such lines it
 * holds. A host streams each update to its viewers, a window on another
 * machine among them, before a dump's lines are enough to count; a mark
 * the settled answer would not make costs nothing, since that answer
 * replaces the update.
 */
export function scrubToolPartial<
	Part extends { readonly type: string },
	Details,
	Structured,
>(
	answer: ToolAnswer<Part, Details, Structured>,
	input: unknown,
	known: readonly KnownSecret[] = knownSecrets(),
): ScrubbedAnswer<Part, Details, Structured> | undefined {
	return scrubAnswer(
		answer,
		{ ...scrubOptionsOf(input), partial: true },
		known,
	);
}

/** A tool's answer scrubbed field by field as `options` reads it. */
function scrubAnswer<
	Part extends { readonly type: string },
	Details,
	Structured,
>(
	answer: ToolAnswer<Part, Details, Structured>,
	options: ScrubOptions,
	known: readonly KnownSecret[],
): ScrubbedAnswer<Part, Details, Structured> | undefined {
	let found = false;
	const content = answer.content?.map((part): Part => {
		if (!isTextPart(part)) return part;
		const { text, kinds } = scrubSecrets(part.text, known, options);
		if (kinds.length === 0) return part;
		found = true;
		return { ...part, text };
	});
	const details = scrubDeep(answer.details, known, options);
	const structured = scrubDeep(answer.structuredContent, known, options);
	if (!found && details.kinds.length === 0 && structured.kinds.length === 0) {
		return undefined;
	}
	return {
		...("content" in answer ? { content } : {}),
		...("details" in answer ? { details: details.value } : {}),
		...("structuredContent" in answer
			? { structuredContent: structured.value }
			: {}),
	};
}

/** Whether a part of an answer is text, which is all that is scrubbed. */
function isTextPart<Part extends { readonly type: string }>(
	part: Part,
): part is Part & { readonly text: string } {
	return part.type === "text" && typeof Reflect.get(part, "text") === "string";
}

/** A variable's name that says its value is a credential. */
const SECRET_NAME =
	/^(?:CLOUDSMITH_\w+|\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTH_HEADER)|\w*(?<!PUBLIC)_KEY)$/;

/** One credential known by its value, named by the variable holding it. */
export interface KnownSecret {
	readonly name: string;
	readonly value: string;
}

/**
 * The credentials the environment holds by value: each variable whose name
 * says it holds one, and each word of its value long and mixed enough to
 * be one, longest first. A path or an address is left out, since a
 * variable named for a token sometimes names the program that makes it.
 */
export function knownSecrets(
	env: NodeJS.ProcessEnv = process.env,
): KnownSecret[] {
	const known: KnownSecret[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || !SECRET_NAME.test(name)) continue;
		const words = value.includes(" ")
			? [value, ...value.split(/\s+/)]
			: [value];
		for (const word of words) {
			if (looksLikeSecret(word)) known.push({ name, value: word });
		}
	}
	return known.sort((one, other) => other.value.length - one.value.length);
}

/**
 * The text with every credential it holds put out of sight, and the kinds
 * found, in the order found; the same text, and none, when it holds none.
 * The known values are the environment's unless given. The text is read
 * as a dump when `options` says it is one; one that only reads as a dump
 * by its lines, or a partial one however few such lines it holds, has
 * just its variables' values read as one.
 */
export function scrubSecrets(
	text: string,
	known: readonly KnownSecret[] = knownSecrets(),
	options: ScrubOptions = {},
): { text: string; kinds: string[] } {
	const kinds: string[] = [];
	// Read before any value is marked: a mark is no value a line sets.
	const dumped =
		!options.environment && (options.partial === true || readsAsDump(text));
	let scrubbed = text;
	for (const { name, value } of known) {
		if (!scrubbed.includes(value)) continue;
		const parts = scrubbed.split(value);
		for (let found = 1; found < parts.length; found++) kinds.push(name);
		scrubbed = parts.join(scrubbedMark(name));
	}
	for (const shape of SHAPES) {
		scrubbed = scrubbed.replace(shape.pattern, (...match: unknown[]) => {
			kinds.push(shape.kind);
			const [before = "", after = ""] = match
				.slice(1, 1 + (shape.keeps ?? 0))
				.map(String);
			return `${before}${scrubbedMark(shape.kind)}${after}`;
		});
	}
	// A terminal, and the word scan, read a bare escape and a mark's
	// bracket as one sequence: dropped before the scan and after it.
	if (kinds.length) scrubbed = unescapedMarks(scrubbed);
	const marked = new Set(kinds);
	if (options.environment) scrubbed = scrubDump(scrubbed, kinds, marked);
	else if (dumped) scrubbed = scrubDumpedLines(scrubbed, kinds, marked);
	if (options.partial === true) {
		scrubbed = scrubOpenLine(scrubbed, kinds, options.environment === true);
	}
	if (kinds.length) scrubbed = unescapedMarks(scrubbed);
	return { text: scrubbed, kinds };
}

/**
 * The value with every string in it scrubbed, however deep, and the kinds
 * found; the very same value, and none, when nothing in it held a secret,
 * so a result with nothing to hide is handed on untouched. Strings stay
 * strings and every array and object keeps its shape, so the value keeps
 * its type.
 */
export function scrubDeep<T>(
	value: T,
	known: readonly KnownSecret[] = knownSecrets(),
	options: ScrubOptions = {},
): { value: T; kinds: string[] } {
	const scrubbed = scrubAny(value, known, options);
	return { value: scrubbed.value as T, kinds: scrubbed.kinds };
}

/** scrubDeep over a value of no known type. */
function scrubAny(
	value: unknown,
	known: readonly KnownSecret[],
	options: ScrubOptions,
): { value: unknown; kinds: string[] } {
	if (typeof value === "string") {
		const { text, kinds } = scrubSecrets(value, known, options);
		return { value: kinds.length > 0 ? text : value, kinds };
	}
	if (Array.isArray(value)) {
		const kinds: string[] = [];
		const items = value.map((item) => {
			const scrubbed = scrubAny(item, known, options);
			kinds.push(...scrubbed.kinds);
			return scrubbed.value;
		});
		return { value: kinds.length > 0 ? items : value, kinds };
	}
	if (isPlainObject(value)) {
		const kinds: string[] = [];
		const entries = Object.entries(value).map(([key, item]) => {
			const scrubbed = scrubAny(item, known, options);
			kinds.push(...scrubbed.kinds);
			return [key, scrubbed.value] as const;
		});
		return {
			value: kinds.length > 0 ? Object.fromEntries(entries) : value,
			kinds,
		};
	}
	return { value, kinds: [] };
}

/** Whether the value is an object made of entries, not a class's instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
