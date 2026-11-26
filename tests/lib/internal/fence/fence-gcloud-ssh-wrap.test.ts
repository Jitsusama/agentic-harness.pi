/**
 * What the fence's wrap binds for gcloud's ssh, through the same text
 * every caller runs: the session's known-hosts copy and the key's
 * stand-in, nothing where the copies can't be kept, and nothing for a
 * server. The copies themselves are in fence-gcloud-ssh.test.ts, and a
 * real bubblewrap over them in fence-gcloud-ssh-bwrap.test.ts.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FENCE } from "../../../../lib/internal/fence/fence.ts";
import {
	type Sandbox,
	sandboxFor,
	wrapFor,
} from "../../../../lib/internal/sandbox/sandbox.ts";
import { quoted } from "../../../../lib/internal/sandbox/sandbox-shell.ts";

/**
 * `text` with the arguments bubblewrap reads from a file written into
 * it, as the text would carry them had there been no file.
 */
function argsReadIn(text: string): string {
	return text.replace(/--args 3 3<'([^']+)'/, (_, file: string) =>
		readFileSync(file, "utf8").split("\0").slice(0, -1).map(quoted).join(" "),
	);
}

/** A broker that never answers, so a test never asks the real one for a token. */
const noCloud = () => ({ reason: "no broker in this test" });

/** A mint that gives nothing, so a test never mints Delta's token. */
const noDelta = () => undefined;

/** The programs the fence needs, as PATH would find them. */
const programs: Record<string, string> = {
	bwrap: "/bin/bwrap",
	landrun: "/bin/landrun",
	"nix-offload": "/nix/store/0000-nix-offload/bin/nix-offload",
	env: "/nix/store/0000-coreutils/bin/env",
};
const all = (program: string) => programs[program];

describe("what the fence binds for gcloud's ssh", () => {
	it("binds the session's copies for gcloud's ssh, none where they can't be kept, and none for a server", () => {
		const fence = sandboxFor(
			{ PI_SANDBOX: FENCE },
			"linux",
			all,
			undefined,
			noCloud,
			undefined,
			undefined,
			undefined,
			noDelta,
		);
		const base = realpathSync(mkdtempSync(join(tmpdir(), "fence-gcloud-")));
		const home = join(base, "home");
		const runtimeDir = join(base, "run");
		const ssh = join(home, ".ssh");
		mkdirSync(ssh, { recursive: true, mode: 0o700 });
		writeFileSync(join(ssh, "google_compute_engine.pub"), "ssh-rsa AAAA\n");
		writeFileSync(join(ssh, "google_compute_known_hosts"), "compute.1 AAAA\n");
		mkdirSync(runtimeDir, { mode: 0o700 });
		const session = basename(base);
		const copies = join(runtimeDir, "pi-fence", "gcloud-ssh", session);
		const knownHosts = `'--bind' '${join(copies, "google_compute_known_hosts")}' '${join(ssh, "google_compute_known_hosts")}'`;
		const standIn = `'--ro-bind' '${join(copies, "google_compute_engine")}' '${join(ssh, "google_compute_engine")}'`;
		// The note's words past its apostrophes, which the shell quotes apart.
		const UNMADE = "be copied for this session (fence-gcloud-ssh.ts)";
		// Wrapped afresh for each command, as every caller wraps.
		const wrapped = (sandbox: Sandbox, command: string): string =>
			wrapFor(
				sandbox,
				{
					cwd: home,
					env: { XDG_RUNTIME_DIR: runtimeDir, PI_SESSION_ID: session },
				},
				home,
			)?.(command) ?? "";
		try {
			const first = wrapped(fence, "gcloud compute ssh one");
			expect(argsReadIn(first), "the known-hosts copy isn't bound").toContain(
				knownHosts,
			);
			expect(argsReadIn(first), "the key's stand-in isn't bound").toContain(
				standIn,
			);
			expect(first, "a note though the copies were made").not.toContain(UNMADE);
			// A folder others can reach can't be trusted to hold the copies, so
			// the next command runs as it did before they existed, and a
			// gcloud command is told why its ssh fails.
			chmodSync(copies, 0o755);
			const after = wrapped(fence, "gcloud compute ssh one");
			expect(
				argsReadIn(after),
				"a copy in an untrusted folder was bound",
			).not.toContain(join(copies, "google_compute_known_hosts"));
			expect(
				argsReadIn(after),
				"the stand-in was bound without it",
			).not.toContain(join(copies, "google_compute_engine"));
			expect(argsReadIn(after), "the command itself was refused").toContain(
				"'--tmpfs'",
			);
			expect(after, "the gcloud command wasn't told why").toContain(UNMADE);
			expect(
				wrapped(fence, "true"),
				"a command not naming the cloud was told",
			).not.toContain(UNMADE);
			expect(
				wrapped(fence, "gsutil ls gs://one"),
				"a cloud command that runs no ssh was told",
			).not.toContain(UNMADE);
			expect(
				wrapped(fence, "gcloud compute scp a one:b"),
				"gcloud's scp wasn't told",
			).toContain(UNMADE);
			chmodSync(copies, 0o700);
			expect(
				argsReadIn(wrapped(fence, "true")),
				"the copies once they can be kept again",
			).toContain(knownHosts);
			// A language server runs no one's ask, so it gets no copies, and
			// makes no session's folder for them.
			rmSync(join(runtimeDir, "pi-fence", "gcloud-ssh"), {
				recursive: true,
				force: true,
			});
			if (fence.kind !== "fence") throw new Error("no fence to serve in");
			const served = argsReadIn(wrapped({ ...fence, served: true }, "true"));
			expect(served, "a server was given the copies").not.toContain(copies);
			expect(
				existsSync(join(runtimeDir, "pi-fence", "gcloud-ssh")),
				"a server made the copies' folder",
			).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
