/**
 * A shell gh pr that asks people to look goes to review_offer, which
 * waits for our own council; one that asks nobody goes through.
 *
 * review_offer holds every door it has until a council of ours has read
 * the change, and the shell had the same doors beside it. Each case runs
 * through the gate as pi runs it: the quoted data stripped for
 * detection, the fail-closed check, then the reading and the refusal.
 */

import { afterEach, describe, expect, it } from "vitest";
import { councilFirstGuardian } from "../../../extensions/pr-guardian/council-first.ts";
import prGuardianExtension from "../../../extensions/pr-guardian/index.ts";
import { registerGuardian } from "../../../lib/guardian/index.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import { setGuardReportSink } from "../../../lib/guardian/report.ts";
import { GUARDS } from "../../../lib/internal/guardian/guards.ts";
import { fakePi } from "../../support/fake-pi.ts";

type Verdict = { block?: boolean; reason?: string } | undefined;
type ToolCall = (event: unknown, ctx: unknown) => Promise<Verdict>;

/** The tool_call handlers a registration left on a fake pi, in order. */
function toolCalls(pi: ReturnType<typeof fakePi>): ToolCall[] {
	return (pi.recorded.handlers.get("tool_call") ?? []) as ToolCall[];
}

/** A bash call carrying `command`, as pi hands it to a handler. */
function bash(command: string) {
	return {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	};
}

/** The council-first guard as pi runs it, headless. */
function gate(): (command: string) => Promise<Verdict> {
	const pi = fakePi();
	registerGuardian(pi, councilFirstGuardian, {
		declaration: GUARDS.councilFirst,
		enforceWithoutUI: true,
	});
	const [handler] = toolCalls(pi);
	if (!handler) throw new Error("no tool_call handler registered");
	return (command) => handler(bash(command), { hasUI: false });
}

afterEach(() => {
	restoreSessionModes({});
	setGuardReportSink(undefined);
});

describe("a shell gh pr that asks people to look", () => {
	const asking: [command: string, move: string, instead: string][] = [
		[
			"gh pr create --title T --body B",
			"without --draft",
			"propose with draft",
		],
		["gh pr create --fill", "without --draft", "propose with draft"],
		["gh pr new --fill", "without --draft", "propose with draft"],
		[
			"gh pr create --draft=false --fill",
			"without --draft",
			"propose with draft",
		],
		["gh pr create -d=false --fill", "without --draft", "propose with draft"],
		[
			"gh pr create --title --draft --fill",
			"without --draft",
			"propose with draft",
		],
		[
			"gh pr create --fill # not --draft yet",
			"without --draft",
			"propose with draft",
		],
		[
			"gh pr create --draft --reviewer evan --fill",
			"--reviewer",
			"then review_offer reviewers",
		],
		[
			"gh pr create -d -r evan --fill",
			"--reviewer",
			"then review_offer reviewers",
		],
		["gh pr create -dfr evan", "--reviewer", "then review_offer reviewers"],
		["gh pr ready 1797", "gh pr ready", "review_offer ready"],
		["gh pr ready 1797 --undo=false", "gh pr ready", "review_offer ready"],
		[
			"gh pr -R Jitsusama/agentic-harness.pi ready 1797",
			"gh pr ready",
			"review_offer ready",
		],
		['gh pr "ready" 1797', "gh pr ready", "review_offer ready"],
		["timeout 60 gh pr ready 1797", "gh pr ready", "review_offer ready"],
		[
			"env GH_REPO=a/b /usr/bin/gh pr ready 1797",
			"gh pr ready",
			"review_offer ready",
		],
		[
			"gh pr ready 1797 # with --undo if wrong",
			"gh pr ready",
			"review_offer ready",
		],
		[
			"gh pr edit 1797 --add-reviewer evan",
			"--add-reviewer",
			"review_offer reviewers",
		],
		[
			"git push -u origin topic && gh pr create --fill",
			"without --draft",
			"propose with draft",
		],
		["gh pr view 1 && gh pr ready 1", "gh pr ready", "review_offer ready"],
	];

	for (const [command, move, instead] of asking) {
		it(`is sent to review_offer: ${command}`, async () => {
			const result = await gate()(command);

			expect(result).toMatchObject({ block: true });
			expect(result?.reason).toContain(`${move} puts the change`);
			expect(result?.reason).toContain("Use review_offer ");
			expect(result?.reason).toContain(instead);
			expect(result?.reason).toContain("our own council");
		});
	}

	it("says what else an edit did, which still wants running", async () => {
		const result = await gate()(
			"gh pr edit 1797 --title 'A Better Title' --add-reviewer evan",
		);

		expect(result?.reason).toContain(
			"its other edits (--title) still want running",
		);
	});

	it("asks for a simpler form of one inside a subshell or control flow", async () => {
		for (const command of [
			"(gh pr ready 1797)",
			"true && { gh pr ready 1797; }",
			"if true; then gh pr ready 1797; fi",
		]) {
			const result = await gate()(command);

			expect(result?.block, command).toBe(true);
			expect(result?.reason, command).toContain("simple form");
		}
	});
});

describe("a shell gh pr that asks nobody", () => {
	const quiet = [
		"gh pr create --draft --fill",
		"gh pr create -d --fill",
		"gh pr create -fd",
		"gh pr create --draft=true --fill",
		"gh pr create --draft --title T --body-file - <<'EOF'\nBody.\nEOF",
		"gh pr create --web",
		"gh pr create --dry-run --fill",
		"gh pr ready 1797 --undo",
		"gh pr edit 1797 --title 'A Better Title'",
		"gh pr edit 1797 --title --add-reviewer",
		"gh pr view 1797",
		"gh pr list --author @me",
		"gh issue create --title T --body B",
		"echo gh pr ready",
		"git commit -m 'gh pr ready'",
	];

	for (const command of quiet) {
		it(`goes through: ${command}`, async () => {
			expect(await gate()(command)).toBeUndefined();
		});
	}
});

describe("a refusal let through under redirect", () => {
	it("lets only the command it refused through on a repeat, not another change's", async () => {
		setSessionMode(GUARDS.councilFirst.name, "redirect");
		setGuardReportSink(() => {});
		const ask = gate();

		expect(await ask("gh pr ready 1")).toMatchObject({ block: true });
		expect(await ask("gh pr ready 2")).toMatchObject({ block: true });
		expect(await ask("gh pr ready 1")).toBeUndefined();
	});

	it("only reports one under off", async () => {
		setSessionMode(GUARDS.councilFirst.name, "off");
		const reported: unknown[] = [];
		setGuardReportSink((report) => reported.push(report));

		expect(await gate()("gh pr ready 1")).toBeUndefined();
		expect(reported).toHaveLength(1);
	});
});

describe("the pr guardian's order", () => {
	it("refuses a create before its description panel would ask anyone", async () => {
		const pi = fakePi();
		prGuardianExtension(pi);
		const [first] = toolCalls(pi);

		const result = await first?.(
			bash("gh pr create --title T --body-file - <<'EOF'\nBody.\nEOF"),
			{ hasUI: true },
		);

		expect(result?.reason).toContain("our own council");
	});
});
