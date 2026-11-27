/**
 * The words a reviewer starts on a room with, held to what the room's
 * reviewer entry takes: each rewrite it makes, and each reviewer it
 * leaves here rather than have the entry refuse it.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_ROOM_BRIEF_BYTES,
	ROOM_BRIEF_CHUNK,
	type RoomPlace,
	roomLaunch,
} from "../../../../lib/subagent/runpi/room-launch.ts";

const place: RoomPlace = {
	mycelium: "mycelium",
	realm: "work",
	machine: "room-1",
	harnessRoot: "/pkg",
	entryLoads: ["/pkg/extensions/sandbox-file-interceptor/index.ts"],
};
const code = { repo: "agentic-harness.pi", commit: "a".repeat(40) };

/** A reviewer's words as composeArgs makes them, around one brief. */
const reviewer = (...more: string[]) => [
	"--mode",
	"json",
	"--no-session",
	"-p",
	"--model",
	"anthropic/claude-opus-5",
	"--no-extensions",
	"--extension",
	"/pkg/packs/review-journal/index.ts",
	"--extension",
	"/pkg/extensions/sandbox-file-interceptor/index.ts",
	"--skill",
	"/pkg/skills/review-contract/SKILL.md",
	...more,
	"@/tmp/brief.md",
];

describe("a reviewer started on a room", () => {
	it("asks the node to run the room's reviewer entry on the change's commit", () => {
		const launch = roomLaunch(place, code, reviewer(), "the brief");

		expect(launch).toEqual({
			binary: "mycelium",
			args: [
				"--realm=work",
				"run",
				"--need",
				"machine=room-1",
				"--",
				"pi",
				"--review",
				"--repo",
				"agentic-harness.pi",
				"--commit",
				code.commit,
				"--no-session",
				"--brief-b64",
				Buffer.from("the brief").toString("base64"),
				"--mode",
				"json",
				"-p",
				"--model",
				"anthropic/claude-opus-5",
				"--no-extensions",
				"--extension",
				"packs/review-journal/index.ts",
				"--skill",
				"skills/review-contract/SKILL.md",
			],
		});
	});

	it("sends a long brief in pieces that each decode alone", () => {
		const brief = "x".repeat(ROOM_BRIEF_CHUNK * 2);
		const launch = roomLaunch(place, code, reviewer(), brief);
		if (!("args" in launch)) throw new Error(launch.stays);

		const pieces = launch.args.flatMap((word, at) =>
			launch.args[at - 1] === "--brief-b64" ? [word] : [],
		);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces) {
			expect(piece.length).toBeLessThanOrEqual(ROOM_BRIEF_CHUNK);
			expect(piece.length % 4, "each piece decodes alone").toBe(0);
		}
		expect(Buffer.from(pieces.join(""), "base64").toString("utf8")).toBe(brief);
	});

	it("leaves out a session it could resume, which a room's home doesn't keep", () => {
		const launch = roomLaunch(
			place,
			code,
			["--session-dir", "/state/s", ...reviewer()],
			"b",
		);
		if (!("args" in launch)) throw new Error(launch.stays);

		expect(launch.args).not.toContain("--session-dir");
		expect(launch.args).not.toContain("/state/s");
	});
});

describe("a reviewer that stays here", () => {
	const stays = (
		args: readonly string[],
		brief: string | undefined = "b",
		at = code,
	) => {
		const launch = roomLaunch(place, at, args, brief);
		return "stays" in launch ? launch.stays : undefined;
	};

	it("stays for a repository the room keeps no checkout of", () => {
		expect(stays(reviewer(), "b", { ...code, repo: "world" })).toMatch(
			/no checkout of world/,
		);
	});

	it("stays for a commit the entry can't check out", () => {
		expect(stays(reviewer(), "b", { ...code, commit: "abc123" })).toMatch(
			/not a whole commit/,
		);
	});

	it("stays for an extension outside the harness", () => {
		expect(
			stays([...reviewer(), "--extension", "/elsewhere/index.ts"]),
		).toMatch(/not in the harness/);
	});

	it("stays for a brief past the cap, or an empty one", () => {
		expect(stays(reviewer(), "x".repeat(MAX_ROOM_BRIEF_BYTES + 1))).toMatch(
			/past/,
		);
		expect(stays(reviewer(), "")).toMatch(/empty/);
	});

	it("stays for more than one file to read", () => {
		expect(stays([...reviewer(), "@/tmp/other.md"])).toMatch(
			/more than one file/,
		);
	});

	it("stays for a system prompt the entry would read as an option", () => {
		expect(stays([...reviewer(), "--system-prompt", "-starts"])).toMatch(
			/--system-prompt/,
		);
	});
});
