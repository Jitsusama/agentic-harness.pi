/**
 * The fence's hidden list, read from the package's data file that core's
 * secret asks read too.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HIDDEN } from "../../../lib/internal/fence.ts";
import {
	FENCE_HIDDEN,
	FENCE_HIDDEN_FILE,
	readFenceHidden,
} from "../../../lib/internal/fence-hidden.ts";
import { NPMRC } from "../../../lib/internal/fence-npmrc.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

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
