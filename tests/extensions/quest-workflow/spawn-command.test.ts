import { describe, expect, it } from "vitest";
import { resolveSpawnCommand } from "../../../extensions/quest-workflow/verbs/session";

describe("resolveSpawnCommand", () => {
	it("resumes the single picked session with pi --session", () => {
		expect(resolveSpawnCommand(undefined, { id: "019abc" })).toEqual({
			command: "pi --session 019abc",
			resumedSessionId: "019abc",
		});
	});

	it("starts a fresh pi when no session is resumable", () => {
		expect(resolveSpawnCommand(undefined, undefined)).toEqual({
			command: "pi",
		});
	});

	it("starts a fresh pi when the pick is ambiguous", () => {
		expect(resolveSpawnCommand(undefined, { ambiguous: [] })).toEqual({
			command: "pi",
		});
	});

	it("lets an explicit command win over a resumable session", () => {
		expect(resolveSpawnCommand("pi --model x", { id: "019abc" })).toEqual({
			command: "pi --model x",
		});
	});
});
