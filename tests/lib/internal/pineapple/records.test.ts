import { describe, expect, it } from "vitest";
import { changesRecords } from "../../../../lib/internal/pineapple/records.ts";

const HOME = "/home/joel";
const RECORDS = "/home/joel/.local/state/pineapple";

const said = (tool: string, input: unknown, cwd = "/work/shop") =>
	changesRecords(tool, input, cwd, RECORDS, HOME) === undefined
		? "goes"
		: "refused";

const bash = (command: string, cwd?: string) => said("bash", { command }, cwd);

describe("changesRecords", () => {
	it("refuses editing or writing a stop, however the path is spelled", () => {
		expect(said("write", { path: `${RECORDS}/stops/a.json` })).toBe("refused");
		expect(
			said("edit", { path: "~/.local/state/pineapple/replies-switch" }),
		).toBe("refused");
		expect(said("write", { path: "stops/a.json" }, RECORDS)).toBe("refused");
		expect(said("write", { path: "/work/shop/pineapple.md" })).toBe("goes");
	});

	it("refuses a command that changes the records", () => {
		expect(bash(`rm ${RECORDS}/stops/a.json`)).toBe("refused");
		expect(bash("rm -rf ~/.local/state/pineapple")).toBe("refused");
		expect(bash('mv "$XDG_STATE_HOME/pineapple/stops/a.json" /tmp/')).toBe(
			"refused",
		);
		expect(bash(`echo '{}' > ${RECORDS}/stops/a.json`)).toBe("refused");
		expect(bash(`jq . a.json > ${RECORDS}/judged.json`)).toBe("refused");
		expect(bash(`find ${RECORDS} -name '*.json' -delete`)).toBe("refused");
		expect(bash(`cd ${RECORDS} && rm stops/a.json`)).toBe("refused");
	});

	it("refuses a resume, which is Joel's alone", () => {
		expect(bash("pineapple resume quest:QEST-A")).toBe("refused");
		expect(bash("env FOO=1 pineapple resume everything")).toBe("refused");
		expect(bash("for s in a; do pineapple resume $s; done")).toBe("refused");
	});

	it("lets reading the records go on", () => {
		expect(bash(`cat ${RECORDS}/stops/*.json`)).toBe("goes");
		expect(bash("ls -la ~/.local/state/pineapple/stops")).toBe("goes");
		expect(bash(`jq -c . ${RECORDS}/decisions.jsonl | tail -5`)).toBe("goes");
		expect(bash(`find ${RECORDS} -name '*.json'`)).toBe("goes");
		expect(bash("pineapple-slack heard")).toBe("goes");
		expect(bash("pineapple stops")).toBe("goes");
	});

	it("lets looking at where the records are go on", () => {
		const looked = [
			"readlink ~/.local/state/pineapple/stops; ls -la /var/lib/pineapple/stops; id",
			`realpath ${RECORDS}/stops`,
			`test -e ${RECORDS}/stops/a.json; echo $?`,
			`[ -L ${RECORDS}/stops ] && echo linked`,
			`sha256sum ${RECORDS}/stops/a.json`,
			`diff ${RECORDS}/stops/a.json /tmp/a.json`,
		];
		expect(looked.map((command) => [command, bash(command)])).toEqual(
			looked.map((command) => [command, "goes"]),
		);
	});

	it("still refuses a program that may write beside what it reads", () => {
		const writing = [
			`xxd ${RECORDS}/stops/a.json ${RECORDS}/stops/b.json`,
			`sort -o ${RECORDS}/judged.json ${RECORDS}/judged.json`,
			`cp /tmp/a.json ${RECORDS}/stops/a.json`,
			`readlink ${RECORDS}/stops > ${RECORDS}/where`,
		];
		expect(writing.map((command) => [command, bash(command)])).toEqual(
			writing.map((command) => [command, "refused"]),
		);
	});

	it("leaves everything else alone", () => {
		expect(bash("git push origin main")).toBe("goes");
		expect(said("read", { path: `${RECORDS}/stops/a.json` })).toBe("goes");
	});
});
