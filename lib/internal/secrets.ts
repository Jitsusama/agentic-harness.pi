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
 * own, a shell's export, declare or set listing, systemd's or launchd's
 * environment, a process's environ, or ps with its e flag. A command run
 * under env, as `env FOO=1 cargo test`, prints only what it prints.
 */
export function dumpsEnvironment(command: string): boolean {
	return ENVIRONMENT_DUMPS.some((dump) => dump.test(command));
}

/** The commands that print the environment, as `dumpsEnvironment` says. */
const ENVIRONMENT_DUMPS: readonly RegExp[] = [
	/(?:^|[\s;&|('"`])env(?:\s+-[0-9A-Za-z-]+)*\s*(?:$|[|;&)>'"`])/,
	/(?:^|[\s;&|('"`])printenv\b/,
	/(?:^|[\s;&|('"`])(?:export|declare|typeset)\s+-[px]\b/,
	/(?:^|[;&|('"`]\s*|^\s*)set\s*(?:$|[|;&)>'"`])/,
	/\bshow-environment\b/,
	/\blaunchctl\s+(?:print|getenv|export|procinfo)\b/,
	/\/proc\/[^\s/]+\/environ\b/,
	/(?:^|[\s;&|('"`])ps\s+(?:-\S*e\S*\s+-\S*w|\S*e\S*w|\S*w\S*e)/,
];

/** A variable's line in a dump: its name, what sits between, its value. */
const DUMPED_VARIABLE =
	/^(\s*(?:export\s+|declare\s+-x\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=>|=)\s*['"]?)([^\s'"]+)/gm;

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
 * an environment value. Paths and addresses read as they did.
 */
function scrubDump(text: string, kinds: string[]): string {
	const named = text.replace(
		DUMPED_VARIABLE,
		(whole: string, before: string, name: string, value: string) => {
			if (!looksLikeSecret(value)) return whole;
			kinds.push(name);
			return `${before}${scrubbedMark(name)}`;
		},
	);
	return named.replace(DUMPED_WORD, (word: string) => {
		if (word.startsWith("[secret scrubbed: ") || !looksLikeSecret(word)) {
			return word;
		}
		kinds.push(ENVIRONMENT_VALUE);
		return scrubbedMark(ENVIRONMENT_VALUE);
	});
}

/** What a dump's bare value is called where it was scrubbed. */
const ENVIRONMENT_VALUE = "environment value";

/** How a text is read: as any output, or as a dump of the environment. */
export interface ScrubOptions {
	/** The text is a command's printing of the environment. */
	readonly environment?: boolean;
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
 * The known values are the environment's unless given.
 */
export function scrubSecrets(
	text: string,
	known: readonly KnownSecret[] = knownSecrets(),
	options: ScrubOptions = {},
): { text: string; kinds: string[] } {
	const kinds: string[] = [];
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
