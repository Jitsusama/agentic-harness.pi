/**
 * A strict command's wrap names what nix-offload needs of the builders,
 * and a language server's doesn't: on 24 November a strict command was
 * refused the lenders and its own journal, so `nix-offload there` said
 * no builder was lent while 18 were (80ECO2 [9b5c1cda]). With the
 * builders' key hidden, nix-offload logs in through pi's agent proxy, so
 * a command reaches that too, and a server never.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFor } from "../../../../lib/internal/sandbox/sandbox.ts";
import { quoted } from "../../../../lib/internal/sandbox/sandbox-shell.ts";

describe("a strict command's wrap", () => {
	let home = "";
	let journal = "";
	let key = "";
	let agent = "";

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "strict-builders-"));
		const state = join(home, ".local/state/nix-offload");
		mkdirSync(join(home, "work"), { recursive: true });
		mkdirSync(state, { recursive: true });
		journal = join(state, "there.jsonl");
		key = join(state, "store_ed25519");
		writeFileSync(journal, "");
		writeFileSync(key, "a key");
		// The proxy's place is all the wrap looks at; no agent answers there.
		agent = join(home, "runtime/pi-agent/agent.sock");
		mkdirSync(join(home, "runtime/pi-agent"), { recursive: true });
		writeFileSync(agent, "");
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	const wrapped = (served: boolean) =>
		wrapFor(
			{
				kind: "strict",
				landrun: "/bin/landrun",
				...(served ? { served } : {}),
			},
			{
				cwd: join(home, "work"),
				env: { XDG_RUNTIME_DIR: join(home, "runtime") },
			},
			home,
		)?.("true") ?? "";

	it("writes nix-offload's journal and the wants, and never names its login key", () => {
		const text = wrapped(false);

		expect(text, "the journal wasn't given").toContain(
			`--rw ${quoted(journal)}`,
		);
		expect(text, "the wants weren't given").toContain(
			`--rw ${quoted("/run/offload-wants")}`,
		);
		expect(text, "the login key was named").not.toContain(key);
	});

	it("logs in to the builders through pi's agent proxy", () => {
		const text = wrapped(false);

		expect(text, "the proxy can't be reached").toContain(
			`--unix ${quoted(agent)}`,
		);
		expect(text, "ssh isn't told of the proxy").toContain(
			`--env ${quoted(`SSH_AUTH_SOCK=${agent}`)}`,
		);
	});

	it("gives a language server none of the builders", () => {
		const text = wrapped(true);

		expect(text).not.toContain(journal);
		expect(text).not.toContain("/run/offload-wants");
		expect(text, "a server reaches the agent proxy").not.toContain(agent);
	});
});
