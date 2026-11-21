/**
 * The folders strict won't let a command write as its own, since what's
 * written there is read later outside every sandbox.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	SANDBOX_VARIABLE,
	STRICT,
} from "../../../../lib/internal/sandbox/sandbox.ts";
import {
	ASKED,
	unfencedFolder,
} from "../../../../lib/internal/sandbox/unfenced-folder.ts";

describe("a working folder the sandbox won't let commands write", () => {
	let home: string;

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "unfenced-home-"));
		mkdirSync(join(home, "checkout/.git"), { recursive: true });
		mkdirSync(join(home, "worktree"));
		writeFileSync(join(home, "worktree/.git"), "gitdir: elsewhere\n");
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	it("is the home folder, or one holding it", () => {
		expect(unfencedFolder(home, home)).toContain("startup files");
		expect(unfencedFolder(join(home, ".."), home)).toContain("startup files");
	});

	it("is one holding or inside the records a machine's node trusts, and not a tree beside them", () => {
		for (const holding of [
			".local",
			".local/state",
			".local/state/pi/agentic-harness.pi",
			".local/state/pi/agentic-harness.pi/hosts",
			".local/state/pi/agentic-harness.pi/hosts/sub",
			".local/state/mycelium",
			".local/state/mycelium/x",
		]) {
			expect(unfencedFolder(join(home, holding), home), holding).toContain(
				"node",
			);
		}
		expect(
			unfencedFolder(
				join(home, ".local/state/pi/agentic-harness.pi/work/trees/t"),
				home,
			),
		).toBeUndefined();
	});

	it("is one holding or inside the code pi and its host compiled", () => {
		for (const at of [
			".cache",
			".cache/pi/agentic-harness.pi/host-compile",
			".cache/pi/agentic-harness.pi/host-compile/v1/x",
			".local/state/pi/agentic-harness.pi/host-compile",
			".local/state/pi/agentic-harness.pi/host-compile/work-background-x",
			".local/state/pi/agentic-harness.pi/node-compile-cache",
		]) {
			expect(unfencedFolder(join(home, at), home), at).toContain("compiled");
		}
		for (const at of ["/tmp/jiti", "/tmp/node-compile-cache/v1"]) {
			expect(unfencedFolder(at, home), at).toContain("compiled");
		}
		// Refused whichever it names first: the test's own state lies there too.
		expect(unfencedFolder("/tmp", home), "/tmp").toContain("won't let");
		expect(
			unfencedFolder(
				join(home, ".cache/pi/agentic-harness.pi/quest-workspace/Q"),
				home,
			),
		).toBeUndefined();
	});

	it("is one holding or inside the code compiled into the runtime folder", () => {
		vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
		try {
			for (const at of [
				"/run/user/1000/pi-compile",
				"/run/user/1000/pi-compile/host",
				"/run/user/1000/pi-compile/node/v1",
			]) {
				expect(unfencedFolder(at, home), at).toContain("compiled");
			}
			expect(unfencedFolder("/run/user/1000/pi-fence", home)).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("names the sandbox as the variable that asks for it", () => {
		expect(ASKED).toBe(`${SANDBOX_VARIABLE}=${STRICT}`);
	});

	it("is one holding its repository's git folder, and not a worktree", () => {
		expect(unfencedFolder(join(home, "checkout"), home)).toContain("hooks");
		expect(unfencedFolder(join(home, "worktree"), home)).toBeUndefined();
		expect(unfencedFolder(join(home, "checkout/src"), home)).toBeUndefined();
	});
});
