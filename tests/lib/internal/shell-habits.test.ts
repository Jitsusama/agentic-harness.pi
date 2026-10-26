import { describe, expect, it } from "vitest";
import {
	sleepRefusal,
	stashRefusal,
	withoutOutputCut,
} from "../../../lib/internal/shell-habits.ts";
import {
	stripHeredocBodies,
	stripShellData,
} from "../../../lib/shell/index.ts";

/** The command as the interceptor reads it. */
const stripped = (command: string) =>
	stripShellData(stripHeredocBodies(command));

const uncut = (command: string) => withoutOutputCut(command, stripped(command));

describe("a build's output cut with tail or head", () => {
	it("is dropped from a test run", () => {
		expect(uncut("pnpm exec vitest run tests/lib 2>&1 | tail -20")).toBe(
			"pnpm exec vitest run tests/lib 2>&1",
		);
	});

	it("is dropped from a build, by either spelling of the count", () => {
		expect(uncut("cd core && cargo build --release | head -n 40")).toBe(
			"cd core && cargo build --release",
		);
		expect(uncut("nix build .#checks.x86_64-linux.formatting | tail -3")).toBe(
			"nix build .#checks.x86_64-linux.formatting",
		);
	});

	it("is kept on anything but a build or a test run", () => {
		expect(uncut("git log --oneline | head -5")).toBeUndefined();
		expect(uncut("ls ~/.local/state | tail -2")).toBeUndefined();
	});

	it("is kept where the pipe is not the command's last", () => {
		expect(uncut("pnpm test | tail -3; echo done")).toBeUndefined();
	});

	it("is kept where the pipe is inside quoted text", () => {
		expect(uncut('echo "run pnpm test | tail -3"')).toBeUndefined();
	});
});

describe("git stash", () => {
	it("is refused when it saves work, in any spelling", () => {
		for (const command of [
			"git stash",
			"git stash push -m wip",
			"git stash -u",
			"cd repo && git -C ../other stash save",
		]) {
			expect(stashRefusal(stripped(command)), command).toContain(
				"work's branch action",
			);
		}
	});

	it("goes ahead when it reads or restores a stash", () => {
		for (const command of [
			"git stash list",
			"git stash show -p",
			"git stash pop",
			"git stash apply stash@{1}",
		]) {
			expect(stashRefusal(stripped(command)), command).toBeUndefined();
		}
	});

	it("is not read in a message that only mentions it", () => {
		expect(
			stashRefusal(stripped('git commit -m "never git stash here"')),
		).toBeUndefined();
	});
});

describe("sleep", () => {
	it("is refused at ten seconds or more, in any unit", () => {
		expect(sleepRefusal(stripped("sleep 30; cat log"))).toContain("30 s");
		expect(sleepRefusal(stripped("make && sleep 2m"))).toContain("120 s");
		expect(sleepRefusal(stripped("while true; do sleep 10; done"))).toContain(
			"10 s",
		);
	});

	it("goes ahead between short polls", () => {
		expect(
			sleepRefusal(
				stripped(
					"for i in $(seq 1 10); do [ -e done ] && break; sleep 5; done",
				),
			),
		).toBeUndefined();
	});

	it("is not read inside a heredoc or a string", () => {
		expect(
			sleepRefusal(stripped("cat <<'EOF' > x.sh\nsleep 60\nEOF")),
		).toBeUndefined();
		expect(sleepRefusal(stripped('echo "sleep 60"'))).toBeUndefined();
	});
});
