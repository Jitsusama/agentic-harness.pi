/**
 * What gcloud's ssh meets in `~/.ssh` inside the fence, through a real
 * bubblewrap rather than the order of its words: its known hosts writable
 * and written through to the session's copy, the folder still refusing a
 * new file, and its private key reading as the stand-in, never the
 * person's. It skips only where no bubblewrap can make a namespace, as
 * inside another sandbox.
 */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceArgs } from "../../../../lib/internal/fence/fence.ts";
import {
	fenceGcloudSsh,
	GCLOUD_KEY,
	GCLOUD_KNOWN_HOSTS,
	type GcloudSsh,
	KEY_STAND_IN,
} from "../../../../lib/internal/fence/fence-gcloud-ssh.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

describe.skipIf(bwrap === undefined)(
	"gcloud's files in the fence's ~/.ssh",
	() => {
		let base = "";
		let home = "";
		let ssh = "";
		let runtimeDir = "";
		let copies: GcloudSsh | undefined;

		/** What `script` says as a fenced command, and whether it succeeded. */
		function fenced(script: string): {
			readonly ok: boolean;
			readonly out: string;
		} {
			const args = fenceArgs({
				home,
				runtimeDir,
				...(copies ? { gcloudSsh: copies } : {}),
			});
			const ran = spawnSync(
				bwrap ?? "bwrap",
				["--unshare-user", ...args, "sh", "-c", script],
				{
					encoding: "utf8",
				},
			);
			return { ok: ran.status === 0, out: ran.stdout };
		}

		beforeAll(() => {
			base = mkdtempSync(join(tmpdir(), "fgb-"));
			// Beside each other, as /home and /run/user are.
			home = join(base, "home");
			ssh = join(home, ".ssh");
			mkdirSync(ssh, { recursive: true, mode: 0o700 });
			writeFileSync(join(ssh, GCLOUD_KEY), "the person's real key\n", {
				mode: 0o600,
			});
			writeFileSync(
				join(ssh, `${GCLOUD_KEY}.pub`),
				"ssh-ed25519 AAAA gcloud\n",
			);
			writeFileSync(
				join(ssh, GCLOUD_KNOWN_HOSTS),
				"compute.1 ssh-ed25519 AAAA\n",
			);
			runtimeDir = join(base, "run");
			mkdirSync(runtimeDir, { mode: 0o700 });
			copies = fenceGcloudSsh(runtimeDir, home, "one");
		});

		afterAll(() => {
			rmSync(base, { recursive: true, force: true });
		});

		it("makes the session's copies to bind", () => {
			expect(copies).toBeDefined();
		});

		it("lets gcloud write its known hosts, through to the session's copy alone", () => {
			const hosts = join(ssh, GCLOUD_KNOWN_HOSTS);
			expect(
				fenced(`printf 'compute.2 ssh-ed25519 BBBB\\n' >> '${hosts}'`).ok,
				"the append to known hosts runs",
			).toBe(true);
			expect(readFileSync(copies?.knownHosts ?? "", "utf8")).toContain(
				"compute.2",
			);
			expect(
				readFileSync(hosts, "utf8"),
				"the person's own file",
			).not.toContain("compute.2");
		});

		it("still refuses a new file in the folder", () => {
			expect(
				fenced(`touch '${join(ssh, "new")}'`).ok,
				"a new file in the folder is refused",
			).toBe(false);
		});

		it("reads gcloud's private key as the stand-in, never the person's", () => {
			const read = fenced(`cat '${join(ssh, GCLOUD_KEY)}'`);
			expect(read.ok, "the key reads").toBe(true);
			expect(read.out).toBe(KEY_STAND_IN);
		});
	},
);
