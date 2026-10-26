import { describe, expect, it } from "vitest";
import {
	normalise,
	renderReport,
	type Sighting,
	signalsFromCall,
	signalsFromResult,
	tally,
	withoutHeredocs,
} from "../../scripts/learning-sensor";

const bash = (command: string) => ({ name: "bash", arguments: { command } });
const habits = (command: string) =>
	signalsFromCall(bash(command)).map((s) => s.key);

describe("reading a tool's answer", () => {
	it("groups a refusal by its first line and counts each reason under it", () => {
		const signals = signalsFromResult(
			"review_offer",
			"⊘ This pull request body is not yet in the shape the skill asks.\n\n- TL;DR is 52 words; it may be at most 40, so cut 12 words.\n- Solution has 9 code spans; it may have at most 8.",
			false,
		);
		expect(signals.map((s) => [s.kind, s.key])).toEqual([
			[
				"refusal",
				"review_offer: This pull request body is not yet in the shape the skill asks.",
			],
			[
				"reason",
				"review_offer: TL;DR is # words; it may be at most #, so cut # words.",
			],
			[
				"reason",
				"review_offer: Solution has # code spans; it may have at most #.",
			],
		]);
	});

	it("counts a guard's block but not an ordinary failed command", () => {
		expect(
			signalsFromResult(
				"bash",
				"Blocked: --amend is not allowed. Make a new commit instead.",
				true,
			),
		).toEqual([
			expect.objectContaining({
				kind: "guard",
				key: "Blocked: --amend is not allowed. Make a new commit instead.",
			}),
		]);
		expect(
			signalsFromResult(
				"bash",
				"grep: no match\n\nCommand exited with code 1",
				true,
			),
		).toEqual([]);
		expect(signalsFromResult("read", "fine", false)).toEqual([]);
	});

	it("folds paths, ids, numbers and quotes so alike refusals group", () => {
		expect(
			normalise(
				'No held tree called "feat-x" at ~/src/a/b, 3 of 392 (4f3a9c1d).',
			),
		).toBe('No held tree called "x" at <path>, # of # (#).');
	});
});

describe("reading a tool call for habits", () => {
	it("names each habit a shell command shows", () => {
		expect(habits("perl -pi -e 's/a/b/' lib/x.ts")).toEqual([
			"tracked file edited from the shell",
		]);
		expect(habits("sed -i 's/a/b/' lib/x.ts")).toEqual([
			"tracked file edited from the shell",
		]);
		expect(habits("cat >> tests/a.test.ts")).toEqual([
			"tracked file edited from the shell",
		]);
		expect(habits("git stash -q && pnpm test")).toEqual([
			"git stash run directly",
		]);
		expect(habits("sleep 30; gh run list")).toEqual(["sleep used to wait"]);
		expect(habits("cd x && nice -n 10 pnpm exec tsc")).toEqual([
			"nice or ionice added",
		]);
		expect(habits("pnpm exec vitest run tests/a 2>&1 | tail -20")).toEqual([
			"build or test output cut with tail or head",
		]);
		expect(habits("git worktree add ../t main")).toEqual([
			"git worktree run by hand",
		]);
	});

	it("leaves alone what only looks like a habit", () => {
		for (const command of [
			"ls runs | head",
			"git stash list",
			"printf 'x' >> $TMPDIR/notes.md",
			"cat > /tmp/a.ts",
			"echo nice work",
			'echo "$(cat $t/comm) | nice $17"',
			"cd $TMPDIR && sed -i 's/a/b/' probe.mjs",
			"sed -i 's#a#b#' $TMPDIR/hookprobe.mjs && node x",
			"perl -pi -e 's/a/b/' /tmp/x.ts",
			"grep -n x ~/.local/share/pi/agentic-harness.pi/quest-workflow/quests/QEST-1/README.md tests/plans/a.ts",
			"grep -rn sleep lib",
		]) {
			expect(habits(command), command).toEqual([]);
		}
	});

	it("does not read a heredoc's body as the command", () => {
		const command =
			"python3 - <<'EOF'\nimport os\nos.system('sed -i s/a/b/ x.ts')\nEOF\necho done";
		expect(withoutHeredocs(command)).toBe("python3 - \necho done");
		expect(habits(command)).toEqual([]);
	});

	it("counts a quest document read whole or searched from the shell", () => {
		const doc =
			"/h/.local/share/pi/agentic-harness.pi/quest-workflow/quests/QEST-1/plans/PLAN-1.md";
		const read = (args: Record<string, unknown>) =>
			signalsFromCall({ name: "read", arguments: { path: doc, ...args } }).map(
				(s) => s.key,
			);
		expect(read({ offset: null, limit: null })).toEqual([
			"quest document read whole",
		]);
		expect(read({ offset: 10, limit: 40 })).toEqual([]);
		expect(habits(`grep -n "^- \\[" ${doc}`)).toEqual([
			"quest document searched from the shell",
		]);
	});
});

describe("counting and reporting", () => {
	const seen = (
		session: string,
		week: string,
		key = "sleep used to wait",
	): Sighting => ({
		kind: "habit",
		key,
		sample: "s",
		session,
		week,
	});

	it("counts distinct sessions per week, most sessions first", () => {
		const groups = tally([
			seen("a", "2026-W43"),
			seen("a", "2026-W43"),
			seen("b", "2026-W43"),
			seen("b", "2026-W44"),
			seen("c", "2026-W44", "git stash run directly"),
		]);
		expect(groups.map((g) => [g.key, g.sessions, g.calls, g.weeks])).toEqual([
			["sleep used to wait", 2, 4, { "2026-W43": 2, "2026-W44": 1 }],
			["git stash run directly", 1, 1, { "2026-W44": 1 }],
		]);
	});

	it("reports each kind's top groups beside the sessions active each week", () => {
		const report = renderReport(
			tally([seen("a", "2026-W43"), seen("b", "2026-W44")]),
			{ "2026-W43": 10, "2026-W44": 3 },
			{ since: "2026-10-18", top: 5 },
		);
		expect(report).toBe(
			[
				"# Learning Sensor, Since 2026-10-18",
				"",
				"Sessions active: 2026-W43 10, 2026-W44 3.",
				"",
				"## Habits",
				"",
				"| Sessions | Calls | 2026-W43 | 2026-W44 | What |",
				"| ---: | ---: | ---: | ---: | --- |",
				"| 2 | 2 | 1 | 1 | sleep used to wait |",
				"",
			].join("\n"),
		);
	});
});
