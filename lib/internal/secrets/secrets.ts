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
 * flag, or a script run inline (`python3 -c`, `node -e`, a heredoc)
 * reading its interpreter's whole environment. A command run under env,
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
 * env on its own: by any path, then only options and assignments, then
 * the command's end. Each option form starts differently from the
 * others, so a long run of options is read one way.
 */
const ENV_ALONE = new RegExp(
	String.raw`(?:^|[\s;&|('"\`{])(?:[^\s;&|('"\`{]*\/)?env` +
		String.raw`(?:\s+(?:-[uCS]\s*(?=[^\s-])(?=(${COMMAND_VALUE}))\1` +
		String.raw`|-(?![uCS])[0-9A-Za-z-]+(?:=(?=(${COMMAND_VALUE}))\2)?` +
		String.raw`|[A-Za-z_][A-Za-z0-9_]*=(?=(${COMMAND_VALUE}))\3))*` +
		String.raw`\s*(?:$|[\n|;&)<>#'"\`}]|\d+>)`,
);

/** The commands that print the environment, as `dumpsEnvironment` says. */
const ENVIRONMENT_DUMPS: readonly RegExp[] = [
	ENV_ALONE,
	/(?:^|[\s;&|('"`{])(?:[^\s;&|('"`{]*\/)?printenv\b/,
	/(?:^|[\s;&|('"`{])(?:export|declare|typeset)\s+-[A-Za-z]*[px]/,
	/(?:^|[\n;&|('"`{]|\b(?:command|builtin|then|do|else|time|exec)\s|-c\s+|\bssh\s+(?:\S+\s+)*?)\s*(?:export|declare|typeset|set)\s*(?:$|[\n|;&)<>#'"`}]|\d+>)/,
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
 * argument, piped to it, or written in a heredoc, whatever then runs it.
 */
const INLINE_SCRIPT =
	/(?:^|[\s;&|('"`/])(?:python[\d.]*|node(?:js)?|deno|bun|ruby|perl|php|irb)(?:\s+(?:[^|;&\s]+\s+)*?(?:-[A-Za-z]*[ecprE]\b|--(?:eval|print)\b|eval\b|-(?=\s|$))|(?<=\|\s*(?:\S*\/)?[\w.]+)\s*(?:$|[\n;&|)]))|<</;

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
 * prints each: not a log line of several pairs, nor a pin like `a==1`.
 */
const ASSIGNED_LINE =
	/^\s*(?:export\s+|declare\s+-[-A-Za-z]+\s+)?[A-Za-z_][A-Za-z0-9_]*=(?!=)(?:'[^']*'|"[^"]*"|[^\s'"]*)\s*$/;

/** The fewest such lines that make an output a dump, whatever printed it. */
const FEWEST_DUMPED_LINES = 5;

/**
 * Whether an output reads as a printing of the environment, whatever
 * printed it: at least five lines setting a variable, making up at least
 * half its lines that hold anything, or five such lines in a row. A line
 * ends at a newline or at a NUL, as `env -0` ends each. A command no rule
 * knows, as a script or a program of the agent's own, still prints a dump
 * this way.
 */
export function readsAsDump(text: string): boolean {
	if (!text.includes("=")) return false;
	let lines = 0;
	let assigned = 0;
	let run = 0;
	let start = 0;
	while (start <= text.length) {
		let end = start;
		while (end < text.length && !isLineEnd(text.charCodeAt(end))) end++;
		const line = text.slice(start, end);
		start = end + 1;
		if (line.trim() === "") continue;
		lines++;
		if (!ASSIGNED_LINE.test(line)) {
			run = 0;
			continue;
		}
		assigned++;
		run++;
		if (run >= FEWEST_DUMPED_LINES) return true;
	}
	return assigned >= FEWEST_DUMPED_LINES && assigned * 2 >= lines;
}

/** Whether a character ends a line of a dump: a newline, or env -0's NUL. */
function isLineEnd(code: number): boolean {
	return code === NEWLINE || code === NUL;
}

const NEWLINE = 10;
const NUL = 0;

/** A variable's line in a dump: its name, what sits between, its value. */
const DUMPED_VARIABLE =
	/^([ \t]*(?:export[ \t]+|declare[ \t]+-[-A-Za-z]+[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:=>|=)[ \t]*['"]?)([^\s'"]+)/gm;

/**
 * A mark already standing where a secret was, kept as it is, or a word
 * long enough to be a credential anywhere in a line, a variable's name
 * before its value aside.
 */
const DUMPED_WORD =
	/\[secret scrubbed: [^\]]*\]|(?<![^\s'"=])[^\s'"=]{16,}(?![^\s'"])(?!\s*=)/g;

/**
 * The dump with every value that could be a credential put out of sight,
 * whatever its variable is called: a dump holds what no shape knows, as a
 * proxy's key under a name of its maker's choosing. A variable's value is
 * named by the variable, and a bare value, as launchctl getenv prints, as
 * an environment value. Paths and addresses read as they did. Each of
 * `env -0`'s NUL-ended entries is read as a line of its own.
 */
function scrubDump(text: string, kinds: string[]): string {
	return eachEntry(text, (entry) =>
		scrubAssigned(entry, kinds).replace(DUMPED_WORD, (word: string) => {
			if (word.startsWith("[secret scrubbed: ") || !looksLikeSecret(word)) {
				return word;
			}
			kinds.push(ENVIRONMENT_VALUE);
			return scrubbedMark(ENVIRONMENT_VALUE);
		}),
	);
}

/**
 * An output read as a dump only by its lines, with each line that sets
 * one variable read as a dump and every other line left as it is, since
 * nothing says the rest is the environment.
 */
function scrubDumpedLines(text: string, kinds: string[]): string {
	return text.replace(EACH_LINE, (line: string) =>
		ASSIGNED_LINE.test(line) ? scrubDump(line, kinds) : line,
	);
}

/** Each line of an output, ended by a newline or by env -0's NUL. */
const EACH_LINE = /[^\n\0]+/g;

/** The text with each variable's value that could be a credential scrubbed. */
function scrubAssigned(text: string, kinds: string[]): string {
	return text.replace(
		DUMPED_VARIABLE,
		(whole: string, before: string, name: string, value: string) => {
			if (!looksLikeSecret(value)) return whole;
			kinds.push(name);
			return `${before}${scrubbedMark(name)}`;
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
	const options = scrubOptionsOf(input);
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

/** The words that stand where a secret was, naming what it was. */
export function scrubbedMark(kind: string): string {
	return `[secret scrubbed: ${kind}]`;
}

/** A variable's name that says its value is a credential. */
const SECRET_NAME =
	/^(?:CLOUDSMITH_\w+|\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTH_HEADER)|\w*(?<!PUBLIC)_KEY)$/;

/** The shortest value taken as a credential's, as CREDENTIAL_VALUE has it. */
const SHORTEST_SECRET = 16;

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

/** Whether a value is long and mixed enough, and not a path or address. */
function looksLikeSecret(value: string): boolean {
	return (
		value.length >= SHORTEST_SECRET &&
		/\d/.test(value) &&
		/[A-Za-z]/.test(value) &&
		!value.startsWith("/") &&
		!value.includes("://")
	);
}

/**
 * The text with every credential it holds put out of sight, and the kinds
 * found, in the order found; the same text, and none, when it holds none.
 * The known values are the environment's unless given. The text is read
 * as a dump when `options` says it is one; one that only reads as a dump
 * by its lines has just its variables' values read as one.
 */
export function scrubSecrets(
	text: string,
	known: readonly KnownSecret[] = knownSecrets(),
	options: ScrubOptions = {},
): { text: string; kinds: string[] } {
	const kinds: string[] = [];
	// Read before any value is marked: a mark is no value a line sets.
	const dumped = !options.environment && readsAsDump(text);
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
	if (options.environment) scrubbed = scrubDump(scrubbed, kinds);
	else if (dumped) scrubbed = scrubDumpedLines(scrubbed, kinds);
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
