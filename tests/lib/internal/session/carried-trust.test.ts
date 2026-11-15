import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	carriedTrust,
	forgetUntrusted,
	leaveUntrusted,
} from "../../../../lib/internal/session/carried-trust.ts";

const SESSION = "01a1da78-defd-722b-94f8-51462424ef01";
const OTHER = "01a1da78-defd-722b-94f8-51462424ef02";
const CWD = "/home/someone/src/clone";
const LOG = `/home/someone/.pi/agent/sessions/--clone--/2026-11-15T10-53-25-000Z_${SESSION}.jsonl`;

let folder: string;
beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "carried-trust-"));
});
afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

/** How a pi started with `argv` in `cwd` answers, nothing saved for it. */
const answer = (
	argv: readonly string[],
	cwd = CWD,
	saved: boolean | null = null,
) => carriedTrust(cwd, { argv, saved: () => saved, folder });

describe("carriedTrust", () => {
	it("keeps a folder its host ran untrusted untrusted in the pi that takes it up", () => {
		leaveUntrusted(SESSION, CWD, folder);
		expect(answer(["node", "pi", "--session", SESSION])).toBe("no");
		expect(answer(["node", "pi", "--session", LOG])).toBe("no");
		expect(answer(["node", "pi", `--session=${SESSION}`, "-c"])).toBe("no");
	});

	it("leaves every other start to pi", () => {
		leaveUntrusted(SESSION, CWD, folder);
		expect(answer(["node", "pi"]), "a pi on no session, as a host").toBe(
			"undecided",
		);
		expect(answer(["node", "pi", "--session", OTHER]), "another session").toBe(
			"undecided",
		);
		expect(
			answer(["node", "pi", "--session", SESSION], "/tmp/elsewhere"),
			"the session gone on in another folder",
		).toBe("undecided");
		expect(
			answer(["node", "pi", "--", "--session", SESSION]),
			"words after --, not a flag",
		).toBe("undecided");
	});

	it("gives way to a decision saved since, and forgets its word", () => {
		leaveUntrusted(SESSION, CWD, folder);
		expect(answer(["node", "pi", "--session", SESSION], CWD, true)).toBe(
			"undecided",
		);
		expect(
			readdirSync(folder).filter((name) => name.endsWith(".json")),
			"its word forgotten",
		).toEqual([]);
		expect(answer(["node", "pi", "--session", SESSION])).toBe("undecided");
	});

	it("forgets a session's word when told", () => {
		leaveUntrusted(SESSION, CWD, folder);
		forgetUntrusted(SESSION, folder);
		expect(answer(["node", "pi", "--session", SESSION])).toBe("undecided");
		forgetUntrusted(OTHER, folder);
	});
});
