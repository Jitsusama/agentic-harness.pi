import { describe, expect, it } from "vitest";
import { classifyBashWrite } from "../../../../lib/internal/quest/bash-write";

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
