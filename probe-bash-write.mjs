import { resolveBashWrites } from "@jitsusama/agentic-harness.core/quest/bash-write";

const cases = [
	"wc -l < /etc/hosts",
	"python3 script.py < input.json",
	"sort < a.txt > b.txt",
	"sed -E 's/<set>/x/' file.txt",
	"sed -n '/<a>/,/<\\/a>/p' page.html",
	"grep -c '>' notes.md",
	"echo 'a > b'",
	'echo "x >> y"',
	"python3 - <<'EOF'\nprint(1 > 0)\nopen('/etc/x','w')\nEOF",
	"cat <<EOF > out.txt\nhello\nEOF",
	"node -e 'if (a > b) {}'",
	"cmd 2>&1",
	"cmd 2>/dev/null",
	"cmd &> log.txt",
	"diff <(ls a) <(ls b)",
	"tee -a log.txt < in",
	"x=$((3 > 2))",
	"[[ 3 > 2 ]]",
	"awk '$1 > 5 { print }' data",
	"git log --format='%h <%ae>'",
];
for (const c of cases) {
	const r = resolveBashWrites(c, { cwd: "/w", home: "/h" });
	console.log(JSON.stringify(c).padEnd(60), "->", JSON.stringify(r.paths));
}
