import { describe, expect, it } from "vitest";
import {
	bashWriteTargets,
	classifyBashWrite,
} from "../../../../lib/internal/quest/bash-write";

describe("classifyBashWrite", () => {
	it("flags a genuinely git-mutating command as git-mutating", () => {
		expect(classifyBashWrite('git commit -m "wip"')).toBe("git-mutating");
	});

	it("flags a redirect or in-place write as bash-write", () => {
		expect(classifyBashWrite("cat > foo.txt")).toBe("bash-write");
		expect(classifyBashWrite("sed -i 's/a/b/' foo.txt")).toBe("bash-write");
	});

	it("treats a mutating verb in a quoted literal as read-only", () => {
		expect(classifyBashWrite('grep -n "branch -d" file.ts')).toBe("read-only");
		expect(classifyBashWrite('rg "git push origin" extensions/')).toBe(
			"read-only",
		);
	});

	it("treats a mutating verb inside a heredoc body as read-only", () => {
		const command = "python3 - <<'PY'\nprint('git reset --hard')\nPY";
		expect(classifyBashWrite(command)).toBe("read-only");
	});
});

describe("bashWriteTargets", () => {
	it("extracts redirect destinations", () => {
		expect(bashWriteTargets("cat > /tmp/dump.json")).toEqual([
			"/tmp/dump.json",
		]);
		expect(bashWriteTargets("echo hi >> notes.md")).toEqual(["notes.md"]);
	});

	it("extracts a tee destination, skipping flags", () => {
		expect(bashWriteTargets("echo x | tee -a out.log")).toEqual(["out.log"]);
	});

	it("ignores heredoc bodies", () => {
		const command = "cat > real.txt <<'EOF'\necho not > a-target\nEOF";
		expect(bashWriteTargets(command)).toEqual(["real.txt"]);
	});

	it("resolves the file argument of an in-place editor", () => {
		expect(bashWriteTargets("sed -i 's/a/b/' src/foo.ts")).toContain(
			"src/foo.ts",
		);
		expect(bashWriteTargets("gsed -i.bak 's/a/b/g' lib/x.ts")).toContain(
			"lib/x.ts",
		);
		expect(bashWriteTargets("perl -i -pe 's/a/b/' a/b.ts")).toContain("a/b.ts");
	});

	it("does not treat a non-in-place editor as a write target", () => {
		expect(bashWriteTargets("perl -pe 's/a/b/' foo.ts")).toEqual([]);
	});

	it("ignores fd redirects such as 2> and &>", () => {
		expect(bashWriteTargets("cat foo 2> err.log")).not.toContain("err.log");
	});

	it("does not capture a redirect that lived inside quoted data", () => {
		expect(bashWriteTargets('echo "a > b" > real.ts')).toEqual(["real.ts"]);
	});

	it("returns empty when there is no parseable write target", () => {
		expect(bashWriteTargets("ls -la")).toEqual([]);
	});
});

describe("a target the command names through a variable", () => {
	// A path held in a shell variable used to come back as the literal
	// `$Q/plans/P.md`, which the gate then resolved against the cwd. That
	// named a file in whatever tree the session happened to be standing in,
	// so a legitimate write to a quest directory was blocked with adoption
	// guidance pointing at an unrelated repository.

	it("resolves an assignment made in the same command", () => {
		expect(bashWriteTargets("Q=/tmp/quest; echo hi >> $Q/plans/P.md")).toEqual([
			"/tmp/quest/plans/P.md",
		]);
	});

	it("reads a quoted destination, which is the ordinary spelling", () => {
		// This was pinned as "sees no target at all", on the reasoning that
		// reading a quoted target meant giving up the strip that stops a `>`
		// inside a string looking like a redirect. That reasoning was wrong:
		// the two are separate questions, because what makes a redirect real
		// is the operator being unquoted, not its target being bare.
		// It also made the expansion above nearly inert, since a path built
		// from a variable is conventionally quoted.
		expect(bashWriteTargets('echo hi >> "/tmp/plain.md"')).toEqual([
			"/tmp/plain.md",
		]);
		expect(bashWriteTargets('Q=/tmp/q; echo hi >> "$Q/f.md"')).toEqual([
			"/tmp/q/f.md",
		]);
		expect(bashWriteTargets("echo hi >> '/tmp/single.md'")).toEqual([
			"/tmp/single.md",
		]);
	});

	it("reads a quoted destination for tee and for an in-place editor", () => {
		expect(bashWriteTargets('Q=/tmp/q; tee "$Q/f.md"')).toEqual([
			"/tmp/q/f.md",
		]);
		// The sed case was answering worse than nothing: it reported the
		// script `s/x/y/` as though it were the file, and missed the file.
		expect(bashWriteTargets('sed -i "" -e s/x/y/ "lib/thing.ts"')).toContain(
			"lib/thing.ts",
		);
	});

	it("still refuses a quoted target it cannot expand", () => {
		expect(bashWriteTargets('echo hi > "$UNKNOWN/f.txt"')).toEqual([]);
	});

	it("reads a write the command grammar declines to model", () => {
		// The command model does not describe a loop or a subshell, and such a
		// command writes as readily as any other. This is why the patterns are
		// kept alongside the model rather than replaced by it.
		expect(
			bashWriteTargets("for f in a b; do echo x >> tracked.ts; done"),
		).toContain("tracked.ts");
		expect(bashWriteTargets("(echo x > inner.ts)")).toContain("inner.ts");
	});

	it("reads the braced spelling too", () => {
		// Assembled rather than written literally, because `${D}` in a plain
		// string is a template placeholder somebody forgot to interpolate as
		// far as the linter can tell, and it is right to say so.
		const braced = `D=/tmp/x; echo hi > $${"{D}"}/out.txt`;

		expect(bashWriteTargets(braced)).toEqual(["/tmp/x/out.txt"]);
	});

	it("takes the last assignment, which is what the shell would use", () => {
		expect(
			bashWriteTargets("P=/tmp/one; P=/tmp/two; echo hi > $P/f.txt"),
		).toEqual(["/tmp/two/f.txt"]);
	});

	it("declines to judge a target it cannot expand", () => {
		// Guessing is worse than declining: resolving an unexpanded sigil
		// against the cwd invents a path nobody wrote to, and blocking the
		// wrong tree is a worse failure than not judging this one.
		expect(bashWriteTargets("echo hi > $UNKNOWN/f.txt")).toEqual([]);
		expect(bashWriteTargets("echo hi > $(dirname x)/f.txt")).toEqual([]);
	});

	it("still reads a plain target alongside one it cannot expand", () => {
		expect(
			bashWriteTargets("echo a > plain.txt; echo b > $NOPE/other.txt"),
		).toEqual(["plain.txt"]);
	});
});
