import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	mixedTurnRefusal,
	shellEditRefusal,
	sleepRefusal,
	stashRefusal,
	trackedShellEdits,
	withoutOutputCut,
} from "../../../lib/internal/shell-habits.ts";
import {
	stripHeredocBodies,
	stripShellData,
} from "../../../lib/shell/index.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

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

describe("a tracked file rewritten from the shell", () => {
	let repo: string;
	const home = "/home/nobody";
	const edits = (command: string, cwd = "/") =>
		trackedShellEdits(command, { cwd, home });

	beforeAll(async () => {
		repo = await freshRepo("shell-edit");
		writeFileSync(join(repo, "a.test.ts"), "it();\n");
		await git(repo, "add", "a.test.ts");
		await git(repo, "commit", "-q", "-m", "a test");
	});
	afterAll(() => disposeRepo(repo));

	it("is found by each way the shell rewrites a file", () => {
		const file = join(repo, "a.test.ts");
		for (const command of [
			`cat >> ${file} <<'EOF'\nit();\nEOF`,
			`echo x > ${file}`,
			`printf x | tee -a ${file}`,
			`sed -i 's/a/b/' ${file}`,
			`perl -pi -e 's/a/b/' ${file}`,
		]) {
			expect(edits(command), command).toEqual([file]);
		}
	});

	it("is placed where the command changes directory to", () => {
		expect(edits(`cd ${repo} && cat >> a.test.ts <<'EOF'\nx\nEOF`)).toEqual([
			join(repo, "a.test.ts"),
		]);
	});

	it("leaves alone a new file, scratch, and a mere read", () => {
		for (const command of [
			`cat > ${join(repo, "zz-debug.test.ts")} <<'EOF'\nx\nEOF`,
			`cd ${repo} && pnpm test > /tmp/run.log 2>&1`,
			`grep -n it ${join(repo, "a.test.ts")} > /dev/null`,
			`echo "> ${join(repo, "a.test.ts")}"`,
		]) {
			expect(edits(command), command).toEqual([]);
		}
	});

	it("names each file and the tools to use instead", () => {
		const reason = shellEditRefusal(["/r/a.ts", "/r/b.ts"]);
		expect(reason).toContain("`/r/a.ts`, `/r/b.ts`");
		expect(reason).toContain("Use the edit tool");
	});
});

describe("a VM run chained after other heavy work", () => {
	// 28 October: 32 of 41 VM-test jobs held their VM slot through a build
	// or changed-checks run before the VM, 9.6 of 10.6 slot hours.
	it("refuses changed-checks then subtests, printing the split with the VM last", () => {
		const reason = mixedTurnRefusal(
			"nix develop -c run-subtests vm-desktop-launcher-answers warmth > $L/s.log 2>&1 && nix develop -c changed-checks --no-vm > $L/cc.log 2>&1",
		);

		expect(reason).toBeDefined();
		expect(reason).toContain("own call");
		const listed = (reason ?? "")
			.split("\n")
			.filter((line) => /^\d\./.test(line));
		expect(listed).toEqual([
			"1. `nix develop -c changed-checks --no-vm > $L/cc.log 2>&1` (a build)",
			"2. `nix develop -c run-subtests vm-desktop-launcher-answers warmth > $L/s.log 2>&1` (a VM test)",
		]);
	});

	it("refuses a lint build then a VM check's build", () => {
		expect(
			mixedTurnRefusal(
				"nix build .#checks.x86_64-linux.formatting\nnix build .#checks.x86_64-linux.vm-desktop-works",
			),
		).toContain("(a VM check)");
	});

	it("refuses building a test's driver and then running it", () => {
		expect(
			mixedTurnRefusal(
				"nix build .#checks.x86_64-linux.vm-desktop-works.driver && ./result/bin/nixos-test-driver",
			),
		).toBeDefined();
	});

	it("lets through builds alone, VMs alone, and one build naming VM checks among others", () => {
		expect(
			mixedTurnRefusal(
				"cd ~/src/core.nix && changed-checks --no-vm > $L/cc.log 2>&1",
			),
		).toBeUndefined();
		expect(
			mixedTurnRefusal(
				"run-subtests vm-desktop-launcher-answers warmth; run-subtests vm-desktop-starts-clean",
			),
		).toBeUndefined();
		expect(
			mixedTurnRefusal(
				"nix build --keep-going .#checks.x86_64-linux.formatting .#checks.x86_64-linux.vm-desktop-works",
			),
		).toBeUndefined();
		expect(mixedTurnRefusal("git status && ls")).toBeUndefined();
	});

	it("reads a heredoc's words as words, not steps", () => {
		expect(
			mixedTurnRefusal(
				"git commit -F - <<'EOF'\nfix: run-subtests after changed-checks\nEOF\nchanged-checks --no-vm",
			),
		).toBeUndefined();
	});
});
