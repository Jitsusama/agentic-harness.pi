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
