/**
 * Steps: what a tool call is about, said in one short line.
 */
import { describe, expect, it } from "vitest";
import {
	DETAIL_CHARS,
	isStepDetail,
	stepName,
	toolDetail,
} from "../../../lib/mesh/step.ts";

describe("a step's detail", () => {
	it("is the argument that says what a call is about", () => {
		expect(toolDetail({ command: "pnpm check", timeout: 600 })).toBe(
			"pnpm check",
		);
		expect(toolDetail({ path: "lib/mesh/peer.ts", offset: 4 })).toBe(
			"lib/mesh/peer.ts",
		);
		expect(toolDetail({ query: "presence wanting", limit: 3 })).toBe(
			"presence wanting",
		);
	});

	it("is the first string given when no argument says, and empty with none", () => {
		expect(toolDetail({ limit: 3, text: "Shall I merge?" })).toBe(
			"Shall I merge?",
		);
		expect(toolDetail({ limit: 3 })).toBe("");
		expect(toolDetail(undefined)).toBe("");
	});

	it("is one line, cut short", () => {
		const long = `nix develop -c ${"changed-checks ".repeat(20)}`;

		expect(toolDetail({ command: "cd tree &&\n  pnpm check" })).toBe(
			"cd tree &&",
		);
		const cut = toolDetail({ command: long });
		expect(cut).toHaveLength(DETAIL_CHARS);
		expect(cut).toMatch(/\u2026$/);
	});
});

describe("a step read back", () => {
	it("is named for older readers as the tool, or what the run is doing", () => {
		expect(stepName({ kind: "tool", name: "bash", detail: "ls" })).toBe("bash");
		expect(stepName({ kind: "thinking", name: "", detail: "" })).toBe(
			"thinking",
		);
	});

	it("reads only as this version says it", () => {
		const step = {
			kind: "tool",
			name: "bash",
			detail: "ls",
			since: "2026-11-06T22:00:00.000Z",
		};

		expect(isStepDetail(step), "a step this version writes reads back").toBe(
			true,
		);
		expect(
			isStepDetail({ ...step, kind: "dreaming" }),
			"a step of an unknown kind does not read",
		).toBe(false);
		expect(
			isStepDetail({ ...step, since: 0 }),
			"a step whose since is no timestamp does not read",
		).toBe(false);
	});
});
