/**
 * The shapes a credential takes in a tool's output, and how one is put out
 * of sight.
 *
 * Each shape is one a service prints for a credential it issues, or the
 * place a credential sits in a file, so plain text, hashes and code read
 * the same as before. A shape that also matches ordinary output (a hash, a
 * function's name) would cost the agent more than it saves, so a shape with
 * no prefix of its own is kept to a name that says it holds a secret.
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
		kind: "credential",
		pattern: new RegExp(
			String.raw`(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY)\s*=\s*['"]?)${CREDENTIAL_VALUE}`,
			"g",
		),
		keeps: 1,
	},
];

/** The words that stand where a secret was, naming what it was. */
export function scrubbedMark(kind: string): string {
	return `[secret scrubbed: ${kind}]`;
}

/**
 * The text with every credential it holds put out of sight, and the kinds
 * found, in the order found; the same text, and none, when it holds none.
 */
export function scrubSecrets(text: string): { text: string; kinds: string[] } {
	const kinds: string[] = [];
	let scrubbed = text;
	for (const shape of SHAPES) {
		scrubbed = scrubbed.replace(shape.pattern, (...match: unknown[]) => {
			kinds.push(shape.kind);
			const [before = "", after = ""] = match
				.slice(1, 1 + (shape.keeps ?? 0))
				.map(String);
			return `${before}${scrubbedMark(shape.kind)}${after}`;
		});
	}
	return { text: scrubbed, kinds };
}

/**
 * The value with every string in it scrubbed, however deep, and the kinds
 * found; the very same value, and none, when nothing in it held a secret,
 * so a result with nothing to hide is handed on untouched. Strings stay
 * strings and every array and object keeps its shape, so the value keeps
 * its type.
 */
export function scrubDeep<T>(value: T): { value: T; kinds: string[] } {
	const scrubbed = scrubAny(value);
	return { value: scrubbed.value as T, kinds: scrubbed.kinds };
}

/** scrubDeep over a value of no known type. */
function scrubAny(value: unknown): { value: unknown; kinds: string[] } {
	if (typeof value === "string") {
		const { text, kinds } = scrubSecrets(value);
		return { value: kinds.length > 0 ? text : value, kinds };
	}
	if (Array.isArray(value)) {
		const kinds: string[] = [];
		const items = value.map((item) => {
			const scrubbed = scrubAny(item);
			kinds.push(...scrubbed.kinds);
			return scrubbed.value;
		});
		return { value: kinds.length > 0 ? items : value, kinds };
	}
	if (isPlainObject(value)) {
		const kinds: string[] = [];
		const entries = Object.entries(value).map(([key, item]) => {
			const scrubbed = scrubAny(item);
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
