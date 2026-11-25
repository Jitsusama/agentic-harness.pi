/**
 * The session's copies of what gcloud's ssh writes in `~/.ssh`, made on
 * a real disk: the known-hosts copy follows the person's file, is
 * renamed into place, starts afresh in each process, and nothing is
 * written through a link or into a folder that isn't the account's own.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fenceGcloudSsh,
	GCLOUD_KEY,
	GCLOUD_KNOWN_HOSTS,
	holdsStandIn,
	KEY_STAND_IN,
} from "../../../../lib/internal/fence/fence-gcloud-ssh.ts";
import { readsAsStandIn } from "../../../../lib/internal/fence/fence-preflight-checks.ts";

let root = "";
let home = "";
let runtime = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "gcloud-ssh-"));
	home = join(root, "home");
	runtime = join(root, "run");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(runtime, { mode: 0o700 });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** The session `one`'s folder of copies. */
function sessionFolder(): string {
	return join(runtime, "pi-fence/gcloud-ssh/one");
}

/** Writes the person's known hosts. */
function personHosts(text: string): string {
	const path = join(home, ".ssh", GCLOUD_KNOWN_HOSTS);
	writeFileSync(path, text);
	return path;
}

/**
 * Writes `text` at `path` in place, then dates it `when`, so only what it
 * says tells it from what it was: the same inode, and the same size
 * wherever the texts are.
 */
function rewrite(
	path: string,
	text: string,
	when = statSync(path).mtime,
): void {
	writeFileSync(path, text);
	utimesSync(path, when, when);
}

/** A time `days` from now, before it where negative. */
function daysOn(days: number): Date {
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

describe("the session's copies for gcloud's ssh", () => {
	it("copies the person's known hosts and writes a stand-in for the key", () => {
		personHosts("compute.1 ssh-ed25519 AAAA\n");
		const copies = fenceGcloudSsh(runtime, home, "one");
		expect(copies).toEqual({
			knownHosts: join(sessionFolder(), GCLOUD_KNOWN_HOSTS),
			key: join(sessionFolder(), GCLOUD_KEY),
		});
		expect(readFileSync(copies?.knownHosts ?? "", "utf8")).toBe(
			"compute.1 ssh-ed25519 AAAA\n",
		);
		expect(readFileSync(copies?.key ?? "", "utf8")).toBe(KEY_STAND_IN);
		expect(statSync(copies?.key ?? "").mode & 0o777).toBe(0o600);
		for (const folder of [
			"pi-fence",
			"pi-fence/gcloud-ssh",
			"pi-fence/gcloud-ssh/one",
		]) {
			expect(statSync(join(runtime, folder)).mode & 0o777, folder).toBe(0o700);
		}
	});

	it("keeps what gcloud wrote in its copy until the person's file changes", () => {
		const person = personHosts("compute.1 ssh-ed25519 AAAA\n");
		const copy = fenceGcloudSsh(runtime, home, "one")?.knownHosts ?? "";
		writeFileSync(
			copy,
			"compute.1 ssh-ed25519 AAAA\ncompute.2 ssh-ed25519 BBBB\n",
		);
		fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copy, "utf8"), "the person's unchanged").toContain(
			"compute.2",
		);
		rewrite(person, "compute.3 ssh-ed25519 CCCC\n");
		fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copy, "utf8"), "the person's changed").toBe(
			"compute.3 ssh-ed25519 CCCC\n",
		);
	});

	it("renews the copy when the person's file changes, whatever dates either carries", () => {
		const person = personHosts("compute.1 ssh-ed25519 AAAA\n");
		const copy = fenceGcloudSsh(runtime, home, "one")?.knownHosts ?? "";
		// A copy dated after the person's file, as gcloud writing it makes
		// it, once kept a newer file of theirs from being copied in.
		writeFileSync(copy, "planted ssh-ed25519 ZZZZ\n");
		utimesSync(copy, daysOn(1), daysOn(1));
		rewrite(person, "compute.4 ssh-ed25519 DDDD\n", daysOn(-1));
		fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copy, "utf8")).toBe("compute.4 ssh-ed25519 DDDD\n");
	});

	it("renews the copy when the person's file says something else at the same size, inode and date", () => {
		const person = personHosts("compute.1 ssh-ed25519 AAAA\n");
		const copy = fenceGcloudSsh(runtime, home, "one")?.knownHosts ?? "";
		const { ino, size } = statSync(person);
		rewrite(person, "compute.6 ssh-ed25519 FFFF\n");
		expect(statSync(person).ino).toBe(ino);
		expect(statSync(person).size).toBe(size);
		fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copy, "utf8")).toBe("compute.6 ssh-ed25519 FFFF\n");
	});

	it("removes the copies of sessions unused for a day, and no other", async () => {
		personHosts("compute.1 ssh-ed25519 AAAA\n");
		const sessions = join(runtime, "pi-fence/gcloud-ssh");
		for (const name of ["ended", "recent"]) {
			fenceGcloudSsh(runtime, home, name);
		}
		// A killed pi's half-written copy, among an ended session's.
		writeFileSync(join(sessions, "ended", `${GCLOUD_KNOWN_HOSTS}.left`), "");
		utimesSync(join(sessions, "ended"), daysOn(-2), daysOn(-2));
		// A folder elsewhere, reached by a link, is never walked.
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		writeFileSync(join(elsewhere, "kept"), "kept\n");
		symlinkSync(elsewhere, join(sessions, "linked"));
		utimesSync(elsewhere, daysOn(-2), daysOn(-2));
		// A new pi sweeps once, at its first ask.
		vi.resetModules();
		const fresh = await import(
			"../../../../lib/internal/fence/fence-gcloud-ssh.ts"
		);
		fresh.fenceGcloudSsh(runtime, home, "one");
		expect(existsSync(join(sessions, "ended")), "ended").toBe(false);
		expect(existsSync(join(sessions, "recent")), "recent").toBe(true);
		expect(existsSync(join(sessions, "one")), "its own").toBe(true);
		expect(readFileSync(join(elsewhere, "kept"), "utf8")).toBe("kept\n");
	});

	it("renames a renewed copy into place, so a command reading the old one keeps it whole", () => {
		const person = personHosts("compute.1 ssh-ed25519 AAAA\n");
		const copy = fenceGcloudSsh(runtime, home, "one")?.knownHosts ?? "";
		const before = statSync(copy).ino;
		rewrite(person, "compute.5 ssh-ed25519 EEEE\n");
		fenceGcloudSsh(runtime, home, "one");
		expect(statSync(copy).ino).not.toBe(before);
	});

	it("copies afresh in a new process, so a session resumed keeps no hosts it didn't copy", async () => {
		personHosts("compute.1 ssh-ed25519 AAAA\n");
		const copy = fenceGcloudSsh(runtime, home, "one")?.knownHosts ?? "";
		writeFileSync(copy, "planted ssh-ed25519 ZZZZ\n");
		vi.resetModules();
		const fresh = await import(
			"../../../../lib/internal/fence/fence-gcloud-ssh.ts"
		);
		fresh.fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copy, "utf8")).toBe("compute.1 ssh-ed25519 AAAA\n");
	});

	it("rewrites the stand-in whenever it reads other than it should", () => {
		const key = fenceGcloudSsh(runtime, home, "one")?.key ?? "";
		for (const text of [
			"",
			`${KEY_STAND_IN}more\n`,
			"-----BEGIN OPENSSH PRIVATE KEY-----\n",
		]) {
			writeFileSync(key, text);
			fenceGcloudSsh(runtime, home, "one");
			expect(readFileSync(key, "utf8"), JSON.stringify(text)).toBe(
				KEY_STAND_IN,
			);
		}
	});

	it("makes an empty copy where the person has no known hosts", () => {
		const copies = fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copies?.knownHosts ?? "", "utf8")).toBe("");
	});

	it("reads the person's known hosts only as a plain file, never through a link", () => {
		const secret = join(root, "secret");
		writeFileSync(secret, "PRIVATE\n");
		symlinkSync(secret, join(home, ".ssh", GCLOUD_KNOWN_HOSTS));
		const copies = fenceGcloudSsh(runtime, home, "one");
		expect(readFileSync(copies?.knownHosts ?? "", "utf8")).toBe("");
	});

	it.each([
		["the known-hosts copy", GCLOUD_KNOWN_HOSTS],
		["the key's stand-in", GCLOUD_KEY],
	])("replaces a link where %s goes, never writing through it", (_, name) => {
		personHosts("compute.1 ssh-ed25519 AAAA\n");
		mkdirSync(sessionFolder(), { recursive: true, mode: 0o700 });
		chmodSync(join(runtime, "pi-fence"), 0o700);
		chmodSync(join(runtime, "pi-fence/gcloud-ssh"), 0o700);
		const elsewhere = join(root, "elsewhere");
		writeFileSync(elsewhere, "");
		symlinkSync(elsewhere, join(sessionFolder(), name));
		const copies = fenceGcloudSsh(runtime, home, "one");
		expect(copies).toBeDefined();
		expect(lstatSync(join(sessionFolder(), name)).isFile()).toBe(true);
		expect(readFileSync(elsewhere, "utf8"), "nothing written through it").toBe(
			"",
		);
	});

	it("replaces a link put where the copy was after this process copied it, never writing through it", () => {
		personHosts("compute.1 ssh-ed25519 AAAA\n");
		const copy = fenceGcloudSsh(runtime, home, "one")?.knownHosts ?? "";
		const elsewhere = join(root, "elsewhere");
		writeFileSync(elsewhere, "");
		rmSync(copy);
		symlinkSync(elsewhere, copy);
		expect(fenceGcloudSsh(runtime, home, "one")).toBeDefined();
		expect(lstatSync(copy).isFile(), "a plain file again").toBe(true);
		expect(readFileSync(copy, "utf8")).toBe("compute.1 ssh-ed25519 AAAA\n");
		expect(readFileSync(elsewhere, "utf8"), "nothing written through it").toBe(
			"",
		);
	});

	it.each([
		["pi's folder", "pi-fence"],
		["the sessions' folder", "pi-fence/gcloud-ssh"],
		["the session's folder", "pi-fence/gcloud-ssh/one"],
	])("makes nothing where a link stands for %s", (_, folder) => {
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		const parent = join(runtime, folder, "..");
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		symlinkSync(elsewhere, join(runtime, folder));
		expect(fenceGcloudSsh(runtime, home, "one")).toBeUndefined();
	});

	it("makes nothing in a folder others can reach", () => {
		mkdirSync(sessionFolder(), { recursive: true, mode: 0o700 });
		chmodSync(join(runtime, "pi-fence"), 0o700);
		chmodSync(join(runtime, "pi-fence/gcloud-ssh"), 0o700);
		chmodSync(sessionFolder(), 0o755);
		expect(fenceGcloudSsh(runtime, home, "one")).toBeUndefined();
		chmodSync(sessionFolder(), 0o700);
		chmodSync(runtime, 0o755);
		expect(
			fenceGcloudSsh(runtime, home, "one"),
			"the runtime folder",
		).toBeUndefined();
	});

	it("makes nothing with no runtime folder, or a session name a folder can't take", () => {
		expect(fenceGcloudSsh(undefined, home, "one")).toBeUndefined();
		expect(fenceGcloudSsh(runtime, home, "../away")).toBeUndefined();
	});
});

describe("whether gcloud's key read inside as the stand-in", () => {
	const standIn = createHash("sha256").update(KEY_STAND_IN).digest("hex");
	const real = createHash("sha256").update("PRIVATE\n").digest("hex");

	it.each([
		["the stand-in's digest", { code: 0, out: `${standIn}  -\n` }, true],
		[
			"after what the wrap printed",
			{ code: 0, out: `pi: note\n${standIn}  -\n` },
			true,
		],
		["not read, or empty", { code: 1, out: "" }, true],
		["another key's digest", { code: 0, out: `${real}  -\n` }, false],
		["nothing said, though it ran", { code: 0, out: "" }, false],
	])("takes %s as %s", (_, ran, standsIn) => {
		expect(readsAsStandIn(ran)).toBe(standsIn);
	});
});

describe("whether a file is the key's stand-in", () => {
	it("holds only for the stand-in itself, read as it stands", () => {
		const path = join(root, "key");
		writeFileSync(path, KEY_STAND_IN);
		expect(holdsStandIn(path)).toBe(true);
		writeFileSync(path, `${KEY_STAND_IN}PRIVATE\n`);
		expect(holdsStandIn(path), "with more after it").toBe(false);
		const link = join(root, "link");
		writeFileSync(path, KEY_STAND_IN);
		symlinkSync(path, link);
		expect(holdsStandIn(link), "through a link").toBe(false);
		expect(holdsStandIn(join(root, "none")), "not there").toBe(false);
	});
});
