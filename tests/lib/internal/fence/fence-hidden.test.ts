/**
 * The fence's hidden list, read from the package's data file that core's
 * secret asks read too.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HIDDEN } from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";
import {
	DOCKER_CONFIG,
	dockerArgs,
	dockerHoldsCredentials,
} from "../../../../lib/internal/fence/fence-docker.ts";
import {
	FENCE_HIDDEN,
	FENCE_HIDDEN_FILE,
	readFenceHidden,
} from "../../../../lib/internal/fence/fence-hidden.ts";
import { NPMRC } from "../../../../lib/internal/fence/fence-npmrc.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("the fence's hidden list", () => {
	it("lives at data/fence-hidden.json, where core reads it", () => {
		expect(
			fileURLToPath(FENCE_HIDDEN_FILE),
			"the file is at the package's data folder",
		).toBe(`${root}data/fence-hidden.json`);
	});

	it("is what the fence hides", () => {
		expect(HIDDEN, "the fence hides the file's home paths").toEqual(
			FENCE_HIDDEN.home,
		);
		expect(HIDDEN, "the builders' key is hidden").toContain(
			".local/state/nix-offload/store_ed25519",
		);
		expect(HIDDEN, "the login keyring is hidden whole").toContain(
			".local/share/keyrings/",
		);
		expect(NPMRC, "npm's settings are the file's").toBe(FENCE_HIDDEN.npmrc);
	});

	it("keeps only public keys, settings and known hosts in ~/.ssh", () => {
		const kept = ["config", "known_hosts", "id_ed25519.pub"].filter((name) =>
			FENCE_HIDDEN.sshKept.test(name),
		);
		expect(kept, "what names hosts and keys is kept").toEqual([
			"config",
			"known_hosts",
			"id_ed25519.pub",
		]);
		const leaked = ["id_ed25519", "id_rsa", "tpm.key", "config.d"].filter(
			(name) => FENCE_HIDDEN.sshKept.test(name),
		);
		expect(leaked, "no private key is kept").toEqual([]);
	});

	it("refuses a file of another version or missing a field", () => {
		const file = JSON.parse(readFileSync(FENCE_HIDDEN_FILE, "utf8")) as Record<
			string,
			unknown
		>;
		expect(
			() => readFenceHidden(JSON.stringify({ ...file, version: 2 })),
			"another version is refused",
		).toThrow(/version 2/);
		const { home: _home, ...noHome } = file;
		expect(
			() => readFenceHidden(JSON.stringify(noHome)),
			"a file with no home paths is refused",
		).toThrow(/needs home/);
	});
});

describe("Docker's settings, emptied when they hold a credential", () => {
	const home = "/home/someone";
	const holds = (settings: unknown) =>
		dockerHoldsCredentials(home, (path) =>
			path === `${home}/${DOCKER_CONFIG}`
				? JSON.stringify(settings)
				: undefined,
		);

	it("holds to a registry's login and to a keychain helper", () => {
		const login = { auths: { "ghcr.io": { auth: "bm90LWEtbG9naW4=" } } };
		const token = { auths: { "x.example": { identitytoken: "not-a-token" } } };
		expect(holds(login), "a registry's login").toBe(true);
		expect(holds(token), "an identity token").toBe(true);
		expect(holds({ credsStore: "osxkeychain" }), "the keychain's helper").toBe(
			true,
		);
	});

	it("lets through settings naming only per-registry helpers, or no login", () => {
		const helpers = {
			auths: { "ghcr.io": {} },
			credHelpers: { "gcr.io": "gcloud" },
		};
		expect(holds(helpers), "per-registry helpers only").toBe(false);
		expect(holds({ credsStore: "" }), "an empty helper").toBe(false);
	});

	it("holds to logins however their names are cased, and to headers sent everywhere", () => {
		const cased = { Auths: { "ghcr.io": { Auth: "bm90LWEtbG9naW4=" } } };
		const store = { CredsStore: "desktop" };
		const headers = { HttpHeaders: { Authorization: "Bearer not-a-token" } };
		expect(holds(cased), "a login cased otherwise").toBe(true);
		expect(holds(store), "a helper cased otherwise").toBe(true);
		expect(holds(headers), "headers").toBe(true);
		expect(holds({ HttpHeaders: {} }), "no headers").toBe(false);
	});

	it("holds to a proxy's address carrying a login, but not to a plain one", () => {
		const login = {
			proxies: {
				default: {
					httpProxy: "http://someone:not-a-password@proxy.example:3128",
				},
			},
		};
		const plain = {
			proxies: { default: { httpProxy: "http://proxy.example:3128" } },
		};
		expect(holds(login), "a proxy's login").toBe(true);
		expect(holds(plain), "a plain proxy").toBe(false);
	});

	it("holds to settings that aren't an object", () => {
		expect(holds(["not", "settings"]), "a list").toBe(true);
		expect(holds("settings"), "a string").toBe(true);
	});

	it("empties the settings file, through a link to it, and nothing else", () => {
		const home = "/home/someone";
		const at = `${home}/${DOCKER_CONFIG}`;
		const disk = (kinds: Record<string, "file" | "folder" | "link">): Disk => ({
			kind: (path) => kinds[path],
			entries: () => [],
			real: () => "/store/docker-config.json",
		});

		expect(dockerArgs(home, disk({ [at]: "file" }))).toEqual([
			"--ro-bind",
			"/dev/null",
			at,
		]);
		expect(
			dockerArgs(
				home,
				disk({ [at]: "link", "/store/docker-config.json": "file" }),
			),
		).toEqual(["--ro-bind", "/dev/null", "/store/docker-config.json"]);
		expect(dockerArgs(home, disk({ [at]: "folder" }))).toEqual([]);
		expect(dockerArgs(home, disk({}))).toEqual([]);
	});

	it("holds to settings it can't read, and lets through none at all", () => {
		const unparsed = dockerHoldsCredentials(home, () => "{ not json");
		const none = dockerHoldsCredentials(home, () => undefined);
		expect(unparsed, "unparseable settings").toBe(true);
		expect(none, "no settings").toBe(false);
	});
});

describe("the key files the fence hides beside the rest", () => {
	it("names gpg's secret keys, Docker's older logins and its TLS keys", () => {
		for (const key of [
			".gnupg/private-keys-v1.d/",
			".gnupg/secring.gpg",
			".dockercfg",
			".docker/key.pem",
			".docker/contexts/tls/",
		]) {
			expect(HIDDEN, key).toContain(key);
		}
	});

	it("names the shell's history, where a pasted token lingers", () => {
		for (const history of [
			".zsh_history",
			".zsh_sessions/",
			".bash_history",
			".local/share/zsh/",
		]) {
			expect(HIDDEN, history).toContain(history);
		}
	});
});
