/**
 * What a conversation's extensions registered of its providers, kept as
 * it parks and registered again on a warm's runtime: in memory whole,
 * and on disk only where it is plain data, over real files.
 */
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	keptProviders,
	readKept,
	registerKept,
	writeKept,
} from "../../../host/engine/kept-providers.ts";
import type { ModelRuntime } from "../../../host/engine/pi-session.ts";

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

function providersFile(): string {
	const folder = mkdtempSync(join(tmpdir(), "kept-providers-"));
	folders.push(folder);
	return join(folder, "providers.json");
}

/** A runtime holding registrations by name and whole, noting what is registered on it. */
function runtime(
	configs: Record<string, object> = {},
	natives: Record<string, object> = {},
) {
	const registered: { configs: [string, object][]; natives: object[] } = {
		configs: [],
		natives: [],
	};
	const model: ModelRuntime = {
		getModel: () => undefined,
		completeSimple: () => Promise.reject(new Error("not asked")),
		getRegisteredProviderIds: () => [
			...new Set([...Object.keys(configs), ...Object.keys(natives)]),
		],
		getRegisteredProviderConfig: (id) => configs[id],
		getRegisteredNativeProvider: (id) => natives[id],
		registerProvider: (id, config) => {
			registered.configs.push([id, config]);
		},
		registerNativeProvider: (provider) => {
			registered.natives.push(provider);
		},
	};
	return { model, registered };
}

const PROXIED = {
	baseUrl: "https://proxy.invalid/apis/anthropic",
	apiKey: "$SHOPIFY_PROXY_KEY",
	headers: { "pi-session-id": "s1" },
};

describe("kept providers", () => {
	it("registers on a warm's runtime what the conversation's extensions had", () => {
		const native = { id: "own", stream: () => undefined };
		const kept = keptProviders(
			runtime({ anthropic: PROXIED }, { own: native }).model,
		);
		const warm = runtime();
		registerKept(warm.model, kept);
		expect(warm.registered.configs).toEqual([["anthropic", PROXIED]]);
		expect(warm.registered.natives).toEqual([native]);
	});

	it("keeps on disk, for its owner alone, what is plain data, and reads it back", () => {
		const file = providersFile();
		const streamed = { ...PROXIED, streamSimple: () => undefined };
		writeKept(
			file,
			keptProviders(runtime({ anthropic: PROXIED, own: streamed }).model),
		);
		expect(readKept(file)).toEqual({
			configs: { anthropic: PROXIED },
			natives: [],
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("keeps on disk a registration a field of which is left undefined, without it", () => {
		const file = providersFile();
		const flex = {
			...PROXIED,
			models: [{ id: "m", contextWindow: 1000, capContextWindow: undefined }],
		};
		writeKept(file, keptProviders(runtime({ flex }).model));
		expect(readKept(file)?.configs).toEqual({
			flex: { ...PROXIED, models: [{ id: "m", contextWindow: 1000 }] },
		});
	});

	it("keeps a key on disk only by its variable, and no credential header", () => {
		const file = providersFile();
		const literal = {
			baseUrl: "https://vendor.invalid",
			apiKey: "sk-written-out-in-full",
			headers: {
				Authorization: "Bearer header-secret",
				"x-api-key": "another-secret",
				"pi-session-id": "s1",
			},
			models: [
				{ id: "m", headers: { "X-Token": "model-secret", "x-team": "pi" } },
			],
		};
		// pi's braced form of a key's variable, its dollar apart so nothing reads it as a placeholder.
		const dollar = "$";
		const braced = { ...PROXIED, apiKey: `${dollar}{SHOPIFY_PROXY_KEY}` };
		writeKept(
			file,
			keptProviders(runtime({ literal, braced, anthropic: PROXIED }).model),
		);
		expect(readKept(file)?.configs).toEqual({
			literal: {
				baseUrl: "https://vendor.invalid",
				headers: { "pi-session-id": "s1" },
				models: [{ id: "m", headers: { "x-team": "pi" } }],
			},
			braced,
			anthropic: PROXIED,
		});
		const written = readFileSync(file, "utf8");
		for (const secret of ["sk-written", "header-secret", "another-secret"])
			expect(written).not.toContain(secret);
		expect(written).not.toContain("model-secret");
	});

	it("leaves no file when nothing it registered is plain data", () => {
		const file = providersFile();
		writeKept(file, keptProviders(runtime({ anthropic: PROXIED }).model));
		writeKept(
			file,
			keptProviders(runtime({ own: { oauth: { login: () => "" } } }).model),
		);
		expect(readKept(file)).toBeUndefined();
	});

	it("reads nothing from a file it can't parse", () => {
		const file = providersFile();
		writeFileSync(file, "{ half");
		expect(readKept(file)).toBeUndefined();
	});
});
