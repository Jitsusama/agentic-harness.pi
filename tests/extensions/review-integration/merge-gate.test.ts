import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	gateFor,
	gateRefusal,
	type RunGate,
} from "../../../extensions/review-integration/merge-gate.ts";

const CORE = "github:Jitsusama/core.nix";
const HEAD = "4dca0632e1f0a6b3c9d27f4e5a8b1c0d2e3f4a5b";
const review = { merge: { gates: { [CORE]: "merge-net ready" } } };

/** The gate run by a real shell, as review_offer runs it. */
const shell: RunGate = async (line, cwd) => {
	const ran = spawnSync("bash", ["-c", line], { cwd, encoding: "utf8" });
	return {
		code: ran.status ?? 1,
		stdout: ran.stdout,
		stderr: ran.stderr,
		killed: false,
	};
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// 8 November: four checks went red on core.nix's main, each named by
// changed-checks at its merge, from branches that built before rebasing.
describe("a repo's merge gate", () => {
	it("is read by the repo's key, and none for a repo that names none", () => {
		expect(gateFor(review, CORE)).toEqual({
			kind: "gate",
			command: "merge-net ready",
		});
		expect(gateFor(review, "github:Jitsusama/agentic-harness.pi")).toEqual({
			kind: "none",
		});
		expect(gateFor(undefined, CORE)).toEqual({ kind: "none" });
	});

	it("says what's wrong with a gate it can't read, so the merge stops", () => {
		expect(gateFor({ merge: { gates: [] } }, CORE)).toMatchObject({
			kind: "malformed",
		});
		expect(gateFor({ merge: { gates: { [CORE]: "" } } }, CORE)).toMatchObject({
			kind: "malformed",
			problem: expect.stringContaining(CORE),
		});
	});

	it("lets a head through only when the gate, handed it, exits 0 in the checkout", async () => {
		const passing = `test "$(pwd -P)" = ${JSON.stringify(realpathSync(dir))} && test`;
		expect(await gateRefusal(passing, HEAD, dir, shell)).toBeUndefined();
	});

	it("refuses with what the gate said", async () => {
		const refusing =
			"sh -c 'echo \"origin/main is not an ancestor of $0\" >&2; exit 3'";
		const said = await gateRefusal(refusing, HEAD, dir, shell);
		expect(said).toContain("exit 3");
		expect(said).toContain(`origin/main is not an ancestor of ${HEAD}`);
	});

	it("refuses when the gate isn't there to ask, or ran past its time", async () => {
		expect(await gateRefusal("no-such-gate-here", HEAD, dir, shell)).toMatch(
			/isn't on this machine/,
		);
		const slow: RunGate = async () => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: true,
		});
		expect(await gateRefusal("merge-net ready", HEAD, dir, slow)).toMatch(
			/ran past/,
		);
		const broken: RunGate = async () => {
			throw new Error("spawn bash ENOENT");
		};
		expect(await gateRefusal("merge-net ready", HEAD, dir, broken)).toMatch(
			/couldn't run.*ENOENT/,
		);
	});
});
