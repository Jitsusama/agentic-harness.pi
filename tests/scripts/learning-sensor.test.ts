import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { restoreSessionModes } from "../../lib/guardian/policy.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import {
	shellEditRefusal,
	sleepRefusal,
} from "../../lib/internal/shell-habits.ts";
import {
	normalise,
	periodOf,
	readLine,
	renderReport,
	type Sighting,
	sense,
	signalsFromCall,
	signalsFromEntry,
	signalsFromResult,
	signalsFromTurn,
	tally,
	withoutHeredocs,
} from "../../scripts/learning-sensor.ts";

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

	it("counts any call a redirecting guard turned back, by its refusal's opening", () => {
		declareGuards(GUARDS.shellEdit);
		restoreSessionModes({});
		const redirected = (reason: string, subject: string) =>
			refusalUnder(GUARDS.shellEdit.name, { block: true, reason }, "t", subject)
				?.reason ?? "";
		const edit = redirected(shellEditRefusal(["/r/lib/x.ts"]), "sed -i x");
		const sleep = redirected(sleepRefusal("sleep 30") ?? "", "sleep 30");

		expect(
			[edit, sleep].flatMap((text) =>
				signalsFromResult("bash", text, true).map((s) => [s.kind, s.key]),
			),
		).toEqual([
			[
				"guard",
				"This rewrites `x` from the shell, which git tracks. Use the edit tool for a change in place, or writ",
			],
			[
				"guard",
				"A sleep of # s holds this session and hears nothing meanwhile. Run what you are waiting on with back",
			],
		]);
	});

	it("counts a redirect made again from the report it left, and nothing else", () => {
		const report = (kind: string) => ({
			customType: "guard-report",
			data: { guard: "sleep", kind, title: "A long sleep", body: "A sleep" },
		});

		expect(signalsFromEntry(report("overridden"))).toEqual([
			{ kind: "override", key: "sleep: A long sleep", sample: "A sleep" },
		]);
		expect(signalsFromEntry(report("waved"))).toEqual([]);
		expect(signalsFromEntry({ customType: "other", data: {} })).toEqual([]);
	});

	it("counts a compaction a run overtook, from the entry the trigger left", () => {
		const signals = signalsFromEntry({
			customType: "compaction-stalled",
			data: { contextTokens: 300_000, askedMsAgo: 2_000 },
		});

		expect(signals).toEqual([
			{
				kind: "context",
				key: "A compaction a run overtook",
				sample: '{"contextTokens":300000,"askedMsAgo":2000}',
			},
		]);
	});

	// From 8 to 10 November 20 blocked runs with nothing to wake them sat
	// half an hour or more, 124 hours in all.
	it("counts a blocked run with nothing to wake it, sent back or resting", () => {
		const unwoken = (sentBack: boolean) =>
			signalsFromEntry({
				customType: "away-blocked-unwoken",
				data: { line: "Blocked: waiting on #12 merging.", sentBack },
			});

		expect(unwoken(true)).toEqual([
			{
				kind: "waiting",
				key: "A blocked run with nothing to wake it, sent back",
				sample: "Blocked: waiting on #12 merging.",
			},
		]);
		expect(unwoken(false)).toMatchObject([
			{
				kind: "waiting",
				key: "A blocked run with nothing to wake it, left to rest",
			},
		]);
	});

	// On 9 November 3,599 turns in 148 sessions read 400k or more, most
	// of them behind compactions that waited hours.
	it("counts a turn that read 400k tokens or more, and none below", () => {
		const turn = (input: number, cacheRead: number, cacheWrite: number) =>
			signalsFromTurn({ input, cacheRead, cacheWrite });

		expect(turn(1_000, 390_000, 9_000)).toEqual([
			{
				kind: "context",
				key: "A turn reading 400k tokens or more",
				sample: "400,000 tokens",
			},
		]);
		expect(turn(1_000, 390_000, 8_999)).toEqual([]);
		expect(signalsFromTurn(undefined)).toEqual([]);
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
		expect(habits("cd x && nice -n 10 pnpm exec tsc")).toEqual([
			"nice or ionice added",
		]);
		expect(habits("git worktree add ../t main")).toEqual([
			"git worktree run by hand",
		]);
	});

	it("leaves to the guards and interceptors the habits they catch", () => {
		for (const command of [
			"perl -pi -e 's/a/b/' lib/x.ts",
			"sed -i 's/a/b/' lib/x.ts",
			"cat >> tests/a.test.ts",
			"git stash -q && pnpm test",
			"sleep 30; gh run list",
			"pnpm exec vitest run tests/a 2>&1 | tail -20",
		]) {
			expect(habits(command), command).toEqual([]);
		}
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
			"sleep 3; git log -1",
			"for i in 1 2 3; do curl -s x; sleep 2; done",
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
		period: string,
		key = "sleep used to wait",
	): Sighting => ({
		kind: "habit",
		key,
		sample: "s",
		session,
		period,
	});

	it("names a moment's period by its ISO week, or by its day", () => {
		const when = Date.parse("2026-10-26T13:14:00Z");
		expect(periodOf(when, "week")).toBe("2026-W44");
		expect(periodOf(when, "day")).toBe("2026-10-26");
	});

	it("counts distinct sessions per week, most sessions first", () => {
		const groups = tally([
			seen("a", "2026-W43"),
			seen("a", "2026-W43"),
			seen("b", "2026-W43"),
			seen("b", "2026-W44"),
			seen("c", "2026-W44", "git stash run directly"),
		]);
		expect(groups.map((g) => [g.key, g.sessions, g.calls, g.periods])).toEqual([
			["sleep used to wait", 2, 4, { "2026-W43": 2, "2026-W44": 1 }],
			["git stash run directly", 1, 1, { "2026-W44": 1 }],
		]);
	});

	it("counts a session read back from Drive as one of its own", () => {
		const root = mkdtempSync(join(tmpdir(), "sensor-"));
		try {
			const refused = (at: string) =>
				JSON.stringify({
					type: "message",
					timestamp: at,
					message: {
						role: "toolResult",
						toolName: "quest",
						content: [{ type: "text", text: "⊘ Nothing is focused." }],
					},
				});
			const sessionsDir = join(root, "sessions");
			mkdirSync(join(sessionsDir, "--a--"), { recursive: true });
			writeFileSync(
				join(sessionsDir, "--a--", "2026-10-27T10-00-00-000Z_s-here.jsonl"),
				`${refused("2026-10-27T10:00:00Z")}\n`,
			);
			const indexPath = join(root, "index.jsonl");
			const away = (id: string) =>
				JSON.stringify({
					name: `h/--a--/${id}.age`,
					id,
					ended: "2026-07-01T00:00:00Z",
				});
			writeFileSync(indexPath, `${away("s-1")}\n${away("s-2")}\n`);

			const { groups, read } = sense(Date.parse("2026-06-01"), "week", {
				sessionsDir,
				indexPath,
				fetch: (_name, to) =>
					writeFileSync(to, `${refused("2026-06-30T10:00:00Z")}\n`),
			});

			expect(groups.map((g) => [g.key, g.sessions])).toEqual([
				["quest: Nothing is focused.", 3],
			]);
			expect(read).toEqual({ here: 1, away: 2, unread: 0 });
			const overridden = JSON.stringify({
				type: "custom",
				customType: "guard-report",
				timestamp: "2026-10-27T10:01:00Z",
				data: { guard: "sleep", kind: "overridden", title: "A long sleep" },
			});
			writeFileSync(
				join(sessionsDir, "--a--", "2026-10-27T10-00-00-000Z_s-here.jsonl"),
				`${refused("2026-10-27T10:00:00Z")}\n${overridden}\n`,
			);
			expect(
				sense(Date.parse("2026-10-01"), "week", {
					sessionsDir,
					indexPath,
					hereOnly: true,
				}).groups.map((g) => [g.kind, g.key, g.sessions]),
			).toEqual([
				["refusal", "quest: Nothing is focused.", 1],
				["override", "sleep: A long sleep", 1],
			]);
			expect(
				sense(Date.parse("2026-06-01"), "week", {
					sessionsDir,
					indexPath,
					hereOnly: true,
				}).read,
			).toEqual({ here: 1, away: 0, unread: 2 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("counts large turns and stalls from a log, under a heading of their own", () => {
		const root = mkdtempSync(join(tmpdir(), "sensor-"));
		try {
			const turn = (at: string, cacheRead: number) =>
				JSON.stringify({
					type: "message",
					timestamp: at,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						usage: { input: 10, cacheRead, cacheWrite: 500 },
					},
				});
			const stalled = JSON.stringify({
				type: "custom",
				customType: "compaction-stalled",
				timestamp: "2026-11-09T03:35:18Z",
				data: { contextTokens: 180_000, askedMsAgo: 400 },
			});
			const sessionsDir = join(root, "sessions");
			mkdirSync(join(sessionsDir, "--a--"), { recursive: true });
			writeFileSync(
				join(sessionsDir, "--a--", "2026-11-09T03-00-00-000Z_s-a.jsonl"),
				[
					turn("2026-11-09T03:30:00Z", 180_000),
					stalled,
					turn("2026-11-09T09:00:00Z", 450_000),
					turn("2026-11-09T10:00:00Z", 520_000),
				].join("\n"),
			);

			const { groups, active } = sense(Date.parse("2026-11-09"), "day", {
				sessionsDir,
				indexPath: join(root, "index.jsonl"),
				hereOnly: true,
			});

			expect(groups.map((g) => [g.kind, g.key, g.sessions, g.calls])).toEqual([
				["context", "A turn reading 400k tokens or more", 1, 2],
				["context", "A compaction a run overtook", 1, 1],
			]);
			expect(
				renderReport(groups, active, { since: "2026-11-09", top: 5 }),
			).toContain("## Context Grown Large");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("says what it read, and what went unread and why", () => {
		expect(readLine({ here: 3, away: 2, unread: 0 })).toBe(
			"read 3 logs on the machine and 2 read back from Drive",
		);
		expect(
			readLine({ here: 3, away: 0, unread: 2, why: "Drive stayed busy" }),
		).toBe(
			"read 3 logs on the machine and 0 read back from Drive; 2 on Drive only went unread: Drive stayed busy",
		);
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
