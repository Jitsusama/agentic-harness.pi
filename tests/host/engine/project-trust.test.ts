/**
 * The host's trust decision over a stand-in pi: the store, the check of
 * what needs trust, the settings and pi's own question are fakes, and the
 * folder's code and its pins are real files, so each case shows what the
 * decision does with the person's answers and the code as it changes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HostPiModules } from "../../../host/engine/host-pi.ts";
import {
	pin,
	projectCode,
	startPins,
} from "../../../host/engine/project-code.ts";
import {
	projectTrust,
	type TrustAsking,
	type TrustedServices,
} from "../../../host/engine/project-trust.ts";

class Settings {
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
	/** pi's own way in, a static on its class. */
	static create(
		_cwd: string,
		_agent: string,
		options?: { projectTrusted?: boolean },
	): Settings {
		return new Settings(options?.projectTrusted ?? false);
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

function modules(): Pick<HostPiModules, "codingAgent" | "projectTrust"> {
	const codingAgent = {
		ProjectTrustStore: class {
			get(): boolean | null {
				return stored;
			}
		},
		hasTrustRequiringProjectResources: () => true,
		SettingsManager: Settings,
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
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("asks again at the next open when the code question closed unanswered, and not after a no", async () => {
	startPins(agentDir, () => 0);
	write(".pi/extensions/lint.ts", "one");
	const trust = projectTrust(modules());
	expect((await opened(trust, answering(undefined))).trusted).toBe(false);
	expect((await opened(trust, answering("No"))).trusted).toBe(false);
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
	expect((await opened(trust, answering("Yes"))).trusted).toBe(false);
	expect(warned.join("\n")).toContain("changed while you were asked");
});

it("keeps the person's no over a yes this host gave the folder before it held code", async () => {
	write(".pi/skills/a/SKILL.md", "words");
	const trust = projectTrust(modules());
	expect((await opened(trust, answering("Yes"))).trusted).toBe(true);
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
	const { settings } = await opened(projectTrust(modules()), answering("Yes"));
	expect(
		settings.trusted,
		"code there at the host's first look is pinned",
	).toBe(true);
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
	write(".pi/extensions/more.ts", "two");
	await settings.reload();
	expect(settings.trusted).toBe(false);
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
