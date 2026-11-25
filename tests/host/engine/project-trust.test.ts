/**
 * The host's trust decision over a stand-in pi: the store, the check of
 * what needs trust, the settings and pi's own question are fakes, and the
 * folder's code and its pins are real files, so each case shows what the
 * decision does with the person's answers and the code as it changes.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HostPiModules } from "../../../host/engine/host-pi.ts";
import {
	PINS_FILE,
	pin,
	printable,
	projectCode,
	startPins,
} from "../../../host/engine/project-code.ts";
import {
	projectTrust,
	type TrustAsking,
	type TrustedServices,
} from "../../../host/engine/project-trust.ts";

/** pi's settings as a pi built with the host's patches has them: they read the .pi the host names. */
class Settings {
	trusted: boolean;
	/** Where the next reload reads the project's .pi; none is the tree's own. */
	dir: string | undefined;
	/** Where each reload read the project's .pi from, the tree's own as undefined. */
	readonly reads: (string | undefined)[] = [];
	constructor(trusted: boolean, dir?: string) {
		this.trusted = trusted;
		this.dir = dir;
	}
	setProjectConfigDir(dir: string): void {
		this.dir = dir === join(folder, ".pi") ? undefined : dir;
	}
	getDefaultProjectTrust(): string {
		return "ask";
	}
	isProjectTrusted(): boolean {
		return this.trusted;
	}
	setProjectTrusted(trusted: boolean): void {
		this.trusted = trusted;
	}
	async reload(): Promise<void> {
		duringLoad?.();
		this.reads.push(this.dir);
	}
	/** pi's own way in, a static on its class. */
	static create(
		_cwd: string,
		_agent: string,
		options?: { projectTrusted?: boolean; projectConfigDir?: string },
	): Settings {
		return new Settings(
			options?.projectTrusted ?? false,
			options?.projectConfigDir,
		);
	}
}

/** pi's settings as a pi without the host's patches has them: they read only the tree's .pi. */
class UnpatchedSettings {
	trusted: boolean;
	constructor(trusted: boolean) {
		this.trusted = trusted;
	}
	getDefaultProjectTrust(): string {
		return "ask";
	}
	isProjectTrusted(): boolean {
		return this.trusted;
	}
	setProjectTrusted(trusted: boolean): void {
		this.trusted = trusted;
	}
	async reload(): Promise<void> {}
	static create(
		_cwd: string,
		_agent: string,
		options?: { projectTrusted?: boolean },
	): UnpatchedSettings {
		return new UnpatchedSettings(options?.projectTrusted ?? false);
	}
}

let root: string;
let folder: string;
let agentDir: string;
/** What the person's trust store holds for the folder. */
let stored: boolean | null;
/** pi's own trust question, as the case has it answer. */
let piAnswers: () => Promise<boolean>;
let asked: number;
let warned: string[];
/** What happens to the tree as pi reads it in a load, after the host's check. */
let duringLoad: (() => void) | undefined;
/** What pi's own look at whether the folder needs trust answers, and what happens to the tree as it looks. */
let requires: () => boolean;

function modules(
	SettingsManager: typeof Settings | typeof UnpatchedSettings = Settings,
): Pick<HostPiModules, "codingAgent" | "projectTrust"> {
	const codingAgent = {
		ProjectTrustStore: class {
			get(): boolean | null {
				return stored;
			}
		},
		hasTrustRequiringProjectResources: () => requires(),
		SettingsManager,
	};
	const trust = { resolveProjectTrusted: () => piAnswers() };
	// The stand-ins carry only what projectTrust reads of pi's modules.
	return { codingAgent, projectTrust: trust } as unknown as Pick<
		HostPiModules,
		"codingAgent" | "projectTrust"
	>;
}

function write(place: string, text: string): void {
	const path = join(folder, place);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

/**
 * Move the pins' start back to nothing once the first look has pinned
 * what it found, so a file planted after counts as new however close
 * the disk's clock and the host's run.
 */
function firstLookDone(): void {
	const file = join(agentDir, PINS_FILE);
	const pins = JSON.parse(readFileSync(file, "utf8")) as object;
	writeFileSync(file, JSON.stringify({ ...pins, since: 0 }));
}

/** A person at the screen who answers the code question `answer`. */
function answering(answer: string | undefined): TrustAsking {
	return {
		ask: async () => {
			asked += 1;
			return answer;
		},
		warn: (message) => warned.push(message),
	};
}

/** Build the folder's services and settle its trust as pi would at the build. */
async function opened(
	trust: ReturnType<typeof projectTrust>,
	asking: TrustAsking,
): Promise<{
	services: TrustedServices;
	settings: Settings;
	trusted: boolean;
}> {
	const services = trust.services(folder, agentDir, asking);
	const settings = services.settingsManager as Settings;
	const resolving = services.resourceLoaderReloadOptions;
	if (resolving)
		settings.trusted = await resolving.resolveProjectTrust({
			extensionsResult: {},
		});
	return { services, settings, trusted: settings.trusted };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "project-trust-"));
	folder = join(root, "tree");
	agentDir = join(root, "agent");
	mkdirSync(folder);
	mkdirSync(agentDir);
	stored = null;
	piAnswers = async () => true;
	asked = 0;
	warned = [];
	duringLoad = undefined;
	requires = () => true;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("asks again at the next open when the code question closed unanswered, and not after a no", async () => {
	startPins(agentDir, () => 0);
	write(".pi/extensions/lint.ts", "one");
	const trust = projectTrust(modules());
	expect(
		(await opened(trust, answering(undefined))).trusted,
		"code nobody said yes to loads nothing",
	).toBe(false);
	expect(
		(await opened(trust, answering("No"))).trusted,
		"a no loads nothing",
	).toBe(false);
	expect(
		asked,
		"a question closed unanswered is not a no, so it is asked again",
	).toBe(2);
	await opened(trust, answering("Yes"));
	expect(asked, "a no holds for the host's life").toBe(2);
});

it("loads nothing when the code changed while pi's own question waited", async () => {
	startPins(agentDir, () => 0);
	write(".pi/extensions/lint.ts", "one");
	piAnswers = async () => {
		write(".pi/extensions/lint.ts", "planted");
		return true;
	};
	const trust = projectTrust(modules());
	expect(
		(await opened(trust, answering("Yes"))).trusted,
		"a yes to code that changed since loads nothing",
	).toBe(false);
	expect(warned.join("\n")).toContain("changed while you were asked");
});

it("loads nothing when code was planted while pi's own question waited in a folder that held none", async () => {
	startPins(agentDir, () => 0);
	write(".pi/skills/a/SKILL.md", "words");
	piAnswers = async () => {
		write(".pi/extensions/planted.ts", "planted");
		return true;
	};
	const trust = projectTrust(modules());
	expect(
		(await opened(trust, answering("Yes"))).trusted,
		"a yes to a folder that held no code loads nothing planted since",
	).toBe(false);
	expect(warned.join("\n")).toContain("changed while you were asked");
});

it.skipIf(process.getuid?.() === 0)(
	"holds a yes whose pins can't be written for the host's life, and says so",
	async () => {
		startPins(agentDir, () => 0);
		write(".pi/extensions/lint.ts", "one");
		chmodSync(agentDir, 0o500);
		try {
			const trust = projectTrust(modules());
			const { settings, trusted } = await opened(trust, answering("Yes"));
			expect(trusted, "a yes holds though its pins can't be written").toBe(
				true,
			);
			expect(warned.join("\n")).toContain(
				"can't keep the yes past its restart",
			);
			await settings.reload();
			expect(
				settings.trusted,
				"a load with no copy to read leaves the folder out",
			).toBe(false);
			expect(warned.join("\n")).toContain("couldn't write its copy");
			chmodSync(agentDir, 0o700);
			await settings.reload();
			expect(settings.trusted, "the next load with a copy keeps the yes").toBe(
				true,
			);
		} finally {
			chmodSync(agentDir, 0o700);
		}
	},
);

it("keeps the person's no over a yes this host gave the folder before it held code", async () => {
	write(".pi/skills/a/SKILL.md", "words");
	const trust = projectTrust(modules());
	expect(
		(await opened(trust, answering("Yes"))).trusted,
		"a folder with no code is trusted on a yes",
	).toBe(true);
	stored = false;
	write(".pi/extensions/planted.ts", "planted");
	expect(
		trust.services(folder, agentDir, answering("Yes")).settingsManager,
	).toMatchObject({
		trusted: false,
	});
});

it("checks a conversation still trusted after the person said no, before each load", async () => {
	write(".pi/extensions/lint.ts", "one");
	// Nobody at the screen, so only the first look's pin can trust it.
	const { settings } = await opened(projectTrust(modules()), {
		warn: (message) => warned.push(message),
	});
	expect(
		settings.trusted,
		"code there at the host's first look is pinned",
	).toBe(true);
	firstLookDone();
	stored = false;
	write(".pi/extensions/planted.ts", "planted");
	await settings.reload();
	expect(settings.trusted, "planted code drops the conversation's trust").toBe(
		false,
	);
});

it("gives back the trust it took once the code is pinned again, and none someone else set", async () => {
	write(".pi/extensions/lint.ts", "one");
	const trust = projectTrust(modules());
	const { settings } = await opened(trust, answering("Yes"));
	firstLookDone();
	write(".pi/extensions/more.ts", "two");
	await settings.reload();
	expect(settings.trusted, "new code drops the trust").toBe(false);
	const code = projectCode(folder);
	if (!code) throw new Error("the folder should hold code");
	pin(folder, agentDir, code);
	await settings.reload();
	expect(settings.trusted, "the guard's own drop is given back").toBe(true);

	write(".pi/extensions/more.ts", "three");
	await settings.reload();
	settings.setProjectTrusted(false);
	const again = projectCode(folder);
	if (!again) throw new Error("the folder should hold code");
	pin(folder, agentDir, again);
	await settings.reload();
	expect(
		settings.trusted,
		"a no set since is the setter's, not the guard's",
	).toBe(false);
});

it("keeps a folder untrusted when its code is pinned again after the person's no", async () => {
	write(".pi/extensions/lint.ts", "one");
	const trust = projectTrust(modules());
	const { settings } = await opened(trust, answering("Yes"));
	firstLookDone();
	write(".pi/extensions/more.ts", "two");
	await settings.reload();
	expect(settings.trusted, "new code drops the trust").toBe(false);
	stored = false;
	const code = projectCode(folder);
	if (!code) throw new Error("the folder should hold code");
	pin(folder, agentDir, code);
	await settings.reload();
	expect(
		settings.trusted,
		"the person's no outranks the guard's give-back",
	).toBe(false);
});

/** Where the last load read the folder's .pi, which must be a copy. */
function lastCopy(settings: Settings): string {
	const dir = settings.reads.at(-1);
	if (dir === undefined) throw new Error("the load read the tree's own .pi");
	return dir;
}

it("loads a trusted folder's .pi from a copy of what it checked, which code written as pi reads never reaches", async () => {
	write(".pi/extensions/lint.ts", "one");
	write(".pi/extensions/run.sh", "#!/bin/sh\n");
	chmodSync(join(folder, ".pi/extensions/run.sh"), 0o755);
	write(".pi/skills/a/SKILL.md", "words");
	write(".pi/settings.json", JSON.stringify({ theme: "dark" }));
	const { settings } = await opened(projectTrust(modules()), answering("Yes"));
	firstLookDone();
	duringLoad = () => write(".pi/extensions/lint.ts", "planted");
	await settings.reload();
	const dir = lastCopy(settings);
	expect(dir.startsWith(join(agentDir, "project-copies"))).toBe(true);
	expect(
		readFileSync(join(dir, "extensions/lint.ts"), "utf8"),
		"code written after the check isn't what loads",
	).toBe("one");
	expect(statSync(join(dir, "extensions/run.sh")).mode & 0o777).toBe(0o755);
	expect(readFileSync(join(dir, "skills/a/SKILL.md"), "utf8")).toBe("words");
	expect(readFileSync(join(dir, "settings.json"), "utf8")).toContain("dark");

	duringLoad = undefined;
	await settings.reload();
	expect(settings.trusted, "the planted code is caught at the next load").toBe(
		false,
	);
	expect(settings.reads.at(-1), "an untrusted load reads the tree").toBe(
		undefined,
	);
});

it("makes a copy as the settings are made, reuses it for the same bytes and makes another when they change", async () => {
	write(".pi/extensions/lint.ts", "one");
	const trust = projectTrust(modules());
	await opened(trust, answering("Yes"));
	const { settingsManager } = trust.services(
		folder,
		agentDir,
		answering("Yes"),
	);
	const settings = settingsManager as Settings;
	const made = settings.dir;
	expect(made, "settings made trusted read a copy").toBeDefined();
	await settings.reload();
	const first = lastCopy(settings);
	expect(first, "the load reuses the copy the settings were made with").toBe(
		made,
	);
	await settings.reload();
	expect(lastCopy(settings), "the same bytes reuse the copy").toBe(first);
	write(".pi/skills/a/SKILL.md", "new words");
	await settings.reload();
	expect(lastCopy(settings), "changed words make a new copy").not.toBe(first);
	expect(settings.trusted, "words are not code, so nothing asks").toBe(true);
});

it("leaves out a folder whose settings name code a copy can't hold, and says why", async () => {
	write("tools/ext.ts", "outside");
	write(".pi/extensions/lint.ts", "one");
	write(
		".pi/settings.json",
		JSON.stringify({
			extensions: [
				"../tools/ext.ts",
				join(folder, ".pi/extensions/lint.ts"),
				"./extensions/lint.ts",
			],
		}),
	);
	const { settings, trusted } = await opened(
		projectTrust(modules()),
		answering("Yes"),
	);
	expect(trusted, "the folder's code was pinned and trusted").toBe(true);
	await settings.reload();
	expect(settings.trusted, "code pi would read from the tree stays out").toBe(
		false,
	);
	const said = warned.join("\n");
	expect(
		said,
		"a path out of the .pi, and an absolute one into it, but not one within it",
	).toContain(
		`its settings name ../tools/ext.ts, ${printable(join(folder, ".pi/extensions/lint.ts"))}, which pi would load from where it is rather than from the copy`,
	);
	expect(
		projectTrust(modules()).services(folder, agentDir, answering("Yes"))
			.settingsManager,
		"settings made with no copy to stand in read nothing of the tree as trusted",
	).toMatchObject({ trusted: false, dir: undefined });
});

it("starts code with no copy to stand in untrusted, and gives the trust back at the first load once a copy can be made", async () => {
	write(".pi/extensions/lint.ts", "one");
	const trust = projectTrust(modules());
	await opened(trust, answering("Yes"));
	writeFileSync(join(agentDir, "project-copies"), "");
	const settings = trust.services(folder, agentDir, answering("Yes"))
		.settingsManager as Settings;
	expect(settings.trusted, "no copy, so made untrusted").toBe(false);
	rmSync(join(agentDir, "project-copies"));
	await settings.reload();
	expect(settings.trusted, "the copy now made gives the trust back").toBe(true);
	expect(
		readFileSync(join(lastCopy(settings), "extensions/lint.ts"), "utf8"),
	).toBe("one");
});

it("loads, in pi's own order, the code a person just allowed from a copy", async () => {
	startPins(agentDir, () => 0);
	write(".pi/extensions/lint.ts", "one");
	const { services, settings } = await opened(
		projectTrust(modules()),
		answering("Yes"),
	);
	expect(
		services.resourceLoaderReloadOptions,
		"the person was asked",
	).toBeDefined();
	// pi's resource loader sets the answer, then reloads the settings, before it loads anything.
	settings.setProjectTrusted(settings.trusted);
	duringLoad = () => write(".pi/extensions/lint.ts", "planted");
	await settings.reload();
	expect(settings.trusted).toBe(true);
	expect(
		readFileSync(join(lastCopy(settings), "extensions/lint.ts"), "utf8"),
	).toBe("one");
});

it("copies what it checked, whatever is written between the check and the copy", async () => {
	write(".pi/extensions/lint.ts", "one");
	const { settings } = await opened(projectTrust(modules()), answering("Yes"));
	firstLookDone();
	// pi's look at what needs trust comes between the host's read and its copy.
	requires = () => {
		write(".pi/extensions/lint.ts", "planted");
		return true;
	};
	await settings.reload();
	expect(
		readFileSync(join(lastCopy(settings), "extensions/lint.ts"), "utf8"),
	).toBe("one");
});

it("checks the code one read found, though pi's own look then finds nothing needing trust", async () => {
	write(".pi/extensions/lint.ts", "one");
	const trust = projectTrust(modules());
	const { settings } = await opened(trust, answering("Yes"));
	firstLookDone();
	write(".pi/extensions/planted.ts", "planted");
	// As a .pi removed between the host's read and pi's look would answer.
	requires = () => false;
	await settings.reload();
	expect(settings.trusted, "the code read is checked, and isn't pinned").toBe(
		false,
	);
	stored = null;
	expect(
		trust.services(folder, agentDir, {
			warn: (message) => warned.push(message),
		}).settingsManager,
		"nor does a new conversation trust it unasked",
	).toMatchObject({ trusted: false });
});

it.skipIf(process.getuid?.() === 0)(
	"loads a folder without the words it can't read, and says so once",
	async () => {
		write(".pi/skills/a/SKILL.md", "words");
		write(".pi/skills/b/SKILL.md", "hidden");
		chmodSync(join(folder, ".pi/skills/b/SKILL.md"), 0o000);
		const { settings } = await opened(
			projectTrust(modules()),
			answering("Yes"),
		);
		await settings.reload();
		await settings.reload();
		expect(settings.trusted).toBe(true);
		expect(
			readFileSync(join(lastCopy(settings), "skills/a/SKILL.md"), "utf8"),
		).toBe("words");
		expect(
			warned.filter((message) => message.includes("loads without some")),
		).toHaveLength(1);
	},
);

it("under a pi that can't load a copy, loads a folder from the tree checked against its pins, as before copies", async () => {
	write(".pi/extensions/lint.ts", "one");
	const { settings } = await opened(
		projectTrust(modules(UnpatchedSettings)),
		answering("Yes"),
	);
	await settings.reload();
	expect(settings.trusted, "pinned code loads as it did").toBe(true);
	expect(warned).toEqual([]);
	expect(
		existsSync(join(agentDir, "project-copies")),
		"no copy is made that nothing would read",
	).toBe(false);
	firstLookDone();
	write(".pi/extensions/planted.ts", "planted");
	await settings.reload();
	expect(settings.trusted, "new code still waits for a yes").toBe(false);
});
