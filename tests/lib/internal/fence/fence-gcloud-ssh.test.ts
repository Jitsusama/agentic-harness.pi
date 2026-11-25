/**
 * The session's copies of what gcloud's ssh writes in `~/.ssh`, made on
 * a real disk: the known-hosts copy follows the person's file, is
 * written in place, and nothing is made where a link stands in its way.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fenceGcloudSsh,
	GCLOUD_KEY,
	GCLOUD_KNOWN_HOSTS,
	KEY_STAND_IN,
} from "../../../../lib/internal/fence/fence-gcloud-ssh.ts";

let root = "";
let home = "";
let runtime = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "gcloud-ssh-"));
	home = join(root, "home");
	runtime = join(root, "run");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(runtime);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Writes the person's known hosts, dated `at` seconds from the epoch. */
function personHosts(text: string, at: number): string {
	const path = join(home, ".ssh", GCLOUD_KNOWN_HOSTS);
	writeFileSync(path, text);
	utimesSync(path, at, at);
	return path;
}

describe("the session's copies for gcloud's ssh", () => {
	it("copies the person's known hosts and writes a stand-in for the key", () => {
		personHosts("compute.1 ssh-ed25519 AAAA\n", 1000);
		const copies = fenceGcloudSsh(runtime, home, "one");
		expect(copies).toEqual({
			knownHosts: join(runtime, "pi-fence/gcloud-ssh/one", GCLOUD_KNOWN_HOSTS),
			key: join(runtime, "pi-fence/gcloud-ssh/one", GCLOUD_KEY),
		});
		expect(readFileSync(copies?.knownHosts ?? "", "utf8")).toBe(
			"compute.1 ssh-ed25519 AAAA\n",
		);
		expect(readFileSync(copies?.key ?? "", "utf8")).toBe(KEY_STAND_IN);
		expect(statSync(copies?.key ?? "").mode & 0o777).toBe(0o600);
	});

	it("keeps what gcloud wrote in its copy until the person's file is newer", () => {
		personHosts("compute.1 ssh-ed25519 AAAA\n", 1000);
		const copies = fenceGcloudSsh(runtime, home, "one");
		const copy = copies?.knownHosts ?? "";
		writeFileSync(
			copy,
			"compute.1 ssh-ed25519 AAAA\ncompute.2 ssh-ed25519 BBBB\n",
		);
		utimesSync(copy, 2000, 2000);
		fenceGcloudSsh(runtime, home, "one");
		expect(
			readFileSync(copy, "utf8"),
			"an older file of the person's",
		).toContain("compute.2");
		const inode = statSync(copy).ino;
		personHosts("compute.3 ssh-ed25519 CCCC\n", 3000);
		fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copy, "utf8"), "a newer one").toBe(
			"compute.3 ssh-ed25519 CCCC\n",
		);
		expect(
			statSync(copy).ino,
			"written in place, so a bind still names it",
		).toBe(inode);
	});

	it("makes an empty copy where the person has no known hosts", () => {
		const copies = fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copies?.knownHosts ?? "", "utf8")).toBe("");
	});

	it("makes nothing where a link stands where a copy goes", () => {
		personHosts("compute.1 ssh-ed25519 AAAA\n", 1000);
		const folder = join(runtime, "pi-fence/gcloud-ssh/one");
		mkdirSync(folder, { recursive: true });
		const elsewhere = join(root, "elsewhere");
		writeFileSync(elsewhere, "");
		symlinkSync(elsewhere, join(folder, GCLOUD_KNOWN_HOSTS));
		expect(fenceGcloudSsh(runtime, home, "one")).toBeUndefined();
		expect(readFileSync(elsewhere, "utf8"), "nothing written through it").toBe(
			"",
		);
	});

	it("makes nothing with no runtime folder, or a session name a folder can't take", () => {
		expect(fenceGcloudSsh(undefined, home, "one")).toBeUndefined();
		expect(fenceGcloudSsh(runtime, home, "../away")).toBeUndefined();
	});
});
