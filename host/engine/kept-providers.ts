/**
 * The providers a conversation's extensions registered, kept past its
 * park so a warm of its cache reaches what its own requests did. A
 * warm's model runtime loads no extensions, so it knows only pi's
 * built-ins and models.json: Shopify's proxy registers anthropic with
 * the proxy's address, the gateway key's variable and its own headers,
 * and every warm on 14 November failed "Provider is not configured:
 * anthropic" on pi's own, which has no key. Kept in memory while the
 * host runs, and on disk beside the conversation's store for the next
 * host, which warms one resting parked without loading anything of it.
 * Only a registration that is plain data goes on disk; one holding a
 * function (its own stream, an OAuth flow) warms in this host alone.
 * The disk copy names a key only by the variable that holds it and
 * drops every header named as a credential, so nothing secret is
 * written: a provider whose key was written out, or came from a
 * command, warms in this host alone too.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isRecord } from "../../lib/internal/record.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import type { ModelRuntime } from "./pi-session.ts";

/** Only its owner reads it: its headers are what the proxy is sent. */
const OWNER_ONLY = 0o600;
/** A key named by the variable that holds it, as pi reads `$NAME` or `${NAME}`. */
const KEY_BY_NAME = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/;
/** A header whose name says it carries a credential, as the warming carry judges one. */
const CREDENTIAL_HEADER =
	/authorization|api[-_]?key|cookie|token|secret|password/i;

/** What a conversation's extensions registered, by provider. */
export interface KeptProviders {
	/** Each registration by name, as the extension gave it. */
	readonly configs: Readonly<Record<string, object>>;
	/** Each provider an extension registered whole, held only while this host runs. */
	readonly natives: readonly object[];
}

/** What the runtime's extensions registered, read before the runtime goes. */
export function keptProviders(runtime: ModelRuntime): KeptProviders {
	const configs: Record<string, object> = {};
	const natives: object[] = [];
	for (const id of runtime.getRegisteredProviderIds()) {
		const native = runtime.getRegisteredNativeProvider(id);
		if (native) natives.push(native);
		const config = runtime.getRegisteredProviderConfig(id);
		if (config) configs[id] = config;
	}
	return { configs, natives };
}

/** Register on `runtime` what a conversation's extensions had, as they did. */
export function registerKept(runtime: ModelRuntime, kept: KeptProviders): void {
	for (const native of kept.natives) runtime.registerNativeProvider(native);
	for (const [id, config] of Object.entries(kept.configs))
		runtime.registerProvider(id, config);
}

/** Keep on disk the registrations that are plain data, or none when no such one is left. */
export function writeKept(file: string, kept: KeptProviders): void {
	const configs = Object.fromEntries(
		Object.entries(kept.configs)
			.filter(([, config]) => plainData(config))
			.map(([id, config]) => [id, withoutSecrets(config)]),
	);
	if (Object.keys(configs).length === 0) {
		rmSync(file, { force: true });
		return;
	}
	writeWhole(file, JSON.stringify({ configs }), { mode: OWNER_ONLY });
}

/** The registrations a host before this one kept on disk, or none it can read. */
export function readKept(file: string): KeptProviders | undefined {
	if (!existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// Half a file or none: its warms fail saying the provider is unknown, as before.
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.configs)) return undefined;
	const configs: Record<string, object> = {};
	for (const [id, config] of Object.entries(parsed.configs))
		if (isRecord(config)) configs[id] = config;
	return { configs, natives: [] };
}

/** A registration as it may be written: its key by name alone, no credential in a header of it or its models. */
function withoutSecrets(config: object): object {
	const { apiKey, headers, models, ...rest } = isRecord(config) ? config : {};
	return {
		...rest,
		...(typeof apiKey === "string" && KEY_BY_NAME.test(apiKey)
			? { apiKey }
			: {}),
		...(isRecord(headers) ? { headers: plainHeaders(headers) } : {}),
		...(Array.isArray(models)
			? {
					models: models.map((model) =>
						isRecord(model) && isRecord(model.headers)
							? { ...model, headers: plainHeaders(model.headers) }
							: model,
					),
				}
			: {}),
	};
}

/** Headers less every one named as a credential. */
function plainHeaders(
	headers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADER.test(name)),
	);
}

/**
 * Whether a value comes back from JSON as it went in: no function,
 * symbol or undefined in it, save a field left undefined, which JSON
 * leaves out and pi reads as unset.
 */
function plainData(value: unknown): boolean {
	if (value === null) return true;
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value);
		case "object":
			return Array.isArray(value)
				? value.every(plainData)
				: Object.getPrototypeOf(value) === Object.prototype &&
						Object.values(value).every(
							(field) => field === undefined || plainData(field),
						);
		default:
			return false;
	}
}
