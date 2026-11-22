/**
 * Strict's shell, its file tools and pi-fence's run on a Mac each judge
 * the runtime folder the session's commands are given, not only pi's:
 * a session started with its own XDG_RUNTIME_DIR, working inside it,
 * is refused by each, whatever pi's own variable reads.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { fenceRunText } from "../../../../lib/internal/fence/fence-run.ts";
import { wrapFor } from "../../../../lib/internal/sandbox/sandbox.ts";
import { fileToolRefusal } from "../../../../lib/internal/sandbox/sandbox-files.ts";

let base: string;
let home: string;
let session: string;
let inner: string;

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "session-runtime-")));
	home = join(base, "home");
	session = join(base, "run-session");
	inner = join(session, "inner");
	mkdirSync(home, { recursive: true });
	mkdirSync(inner, { recursive: true });
	mkdirSync(join(base, "run-pi"), { recursive: true });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

afterEach(() => vi.unstubAllEnvs());

/** pi's own runtime folder somewhere else, so only the session's names this one. */
const pisElsewhere = () => vi.stubEnv("XDG_RUNTIME_DIR", join(base, "run-pi"));

const named = () => `which lies in ${session}, the runtime folder`;

it("refuses a strict command in the session's runtime folder", () => {
	pisElsewhere();

	const wrap = wrapFor(
		{ kind: "strict", landrun: "/nowhere/landrun" },
		{ cwd: inner, env: { PI_SANDBOX: "strict", XDG_RUNTIME_DIR: session } },
		home,
	);

	expect(wrap?.("true")).toContain(named());
});

it("refuses a strict file tool's write in the session's runtime folder", () => {
	pisElsewhere();

	const refused = fileToolRefusal(
		{ toolName: "write", input: { path: "made", content: "x" } },
		{
			cwd: inner,
			env: { PI_SANDBOX: "strict", XDG_RUNTIME_DIR: session },
			home,
		},
	);

	expect(refused).toContain(named());
});

it("refuses pi-fence's run on a Mac in the session's runtime folder", () => {
	pisElsewhere();

	const made = fenceRunText(
		{ kind: "fence", folder: inner, words: ["true"] },
		{
			env: { XDG_RUNTIME_DIR: session },
			home,
			platform: "darwin",
			sandboxExec: "/usr/bin/sandbox-exec",
		},
	);

	expect("refused" in made && made.refused).toContain(named());
});
