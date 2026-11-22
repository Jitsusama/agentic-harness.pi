import { describe, expect, it } from "vitest";
import {
	elsewhereKindOf,
	reroutesElsewhere,
} from "../../../../lib/internal/priority/needs.ts";
import { wordsOf } from "../../../../lib/internal/shell/steps.ts";

const kindOf = (step: string) => elsewhereKindOf(wordsOf(step));

describe("elsewhereKindOf", () => {
	it("names the kind an elsewhere run sends, past what runs it", () => {
		const sent: [string, string][] = [
			["elsewhere run harness-check -- pnpm typecheck", "harness-check"],
			["elsewhere run delta-spec cargo test", "delta-spec"],
			["CI=1 elsewhere run harness-check -- pnpm test", "harness-check"],
			[
				"env -u SSH_AUTH_SOCK CI=1 elsewhere run delta-spec -- cargo test",
				"delta-spec",
			],
			["timeout 900 elsewhere run harness-check -- pnpm test", "harness-check"],
			[
				"timeout -s KILL -k 10 900 elsewhere run harness-check -- pnpm test",
				"harness-check",
			],
			["command elsewhere run harness-check -- pnpm test", "harness-check"],
			["exec elsewhere run harness-check -- pnpm test", "harness-check"],
			["elsewhere run harness-check -- vitest run -t --here", "harness-check"],
		];
		for (const [step, kind] of sent) {
			expect(kindOf(step), step).toBe(kind);
		}
	});

	it("names nothing for a run kept here or a step that runs something else", () => {
		for (const step of [
			"elsewhere run harness-check --here -- pnpm typecheck",
			"elsewhere run harness-check '--here' -- pnpm typecheck",
			'elsewhere run harness-check "--here" -- pnpm typecheck',
			'elsewhere run harness-check -""-here -- pnpm typecheck',
			"elsewhere run harness-check \\-\\-here -- pnpm typecheck",
			"elsewhere run harness-check $H -- pnpm typecheck",
			'elsewhere run harness-check "$STAY" -- pnpm typecheck',
			"elsewhere where harness-check",
			"elsewhere run --here",
			"elsewhere run",
			"./elsewhere run harness-check -- pnpm test",
			"bin/elsewhere run harness-check -- pnpm test",
			"/run/current-system/sw/bin/elsewhere run harness-check -- pnpm test",
			"/tmp/mine/elsewhere run harness-check -- pnpm test",
			"pnpm exec vitest run -t 'elsewhere run harness-check'",
			"echo elsewhere run harness-check",
		]) {
			expect(kindOf(step), step).toBeUndefined();
		}
	});

	it("names nothing for a step that changes what a sent run needs", () => {
		for (const step of [
			"PI_QUEST= elsewhere run harness-check -- pnpm test",
			"PATH=/tmp/x elsewhere run harness-check -- pnpm test",
			"env -u PI_QUEST elsewhere run harness-check -- pnpm test",
			'env -u PI_""QUEST elsewhere run harness-check -- pnpm test',
			"env '-u' PATH elsewhere run harness-check -- pnpm test",
			"env -i elsewhere run harness-check -- pnpm test",
			"env PI_QUEST=other elsewhere run harness-check -- pnpm test",
		]) {
			expect(kindOf(step), step).toBeUndefined();
		}
	});

	it("names nothing for a step that runs something here as it expands", () => {
		for (const step of [
			"elsewhere run harness-check -- pnpm test $(pnpm exec vitest list)",
			'elsewhere run harness-check -- pnpm test "$(cargo test)"',
			"elsewhere run harness-check -- pnpm test `cargo test`",
			"elsewhere run harness-check -- diff <(cargo test) x",
		]) {
			expect(kindOf(step), step).toBeUndefined();
		}
		expect(
			kindOf("elsewhere run harness-check -- echo '$(not run)'"),
			"a single-quoted word expands nothing",
		).toBe("harness-check");
	});
});

describe("reroutesElsewhere", () => {
	it("finds an earlier step that changes the quest, PATH or elsewhere itself", () => {
		for (const command of [
			"unset PI_QUEST; elsewhere run harness-check -- pnpm test",
			"export PATH=/tmp/x:$PATH && elsewhere run harness-check -- pnpm test",
			"PATH=/tmp/x; elsewhere run harness-check -- pnpm test",
			"elsewhere() { pnpm test; }; elsewhere run harness-check -- x",
			"function elsewhere { pnpm test; }; elsewhere run harness-check -- x",
			"alias elsewhere=pnpm; elsewhere run harness-check -- test",
		]) {
			expect(reroutesElsewhere(command), command).toBe(true);
		}
	});

	it("lets a command that changes neither through", () => {
		for (const command of [
			"elsewhere run harness-check -- pnpm test",
			"cd x && elsewhere run harness-check -- pnpm test",
			"MANPATH=/x elsewhere run harness-check -- pnpm test",
			"elsewhere run harness-check -- vitest run -t 'elsewhere where'",
		]) {
			expect(reroutesElsewhere(command), command).toBe(false);
		}
	});
});
