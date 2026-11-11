/** Two conversations share a host, never a quest lease or launch hint. */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	captureSessionIdentity,
	releaseSessionOnShutdown,
	resolveStartup,
	sayFirstWords,
} from "../../../extensions/quest-workflow/lifecycle.ts";
import { livePeers } from "../../../extensions/quest-workflow/peers.ts";
import {
	followHostStamps,
	readRecord,
	recordSessionEnd,
	stopHeartbeat,
	trackSession,
} from "../../../extensions/quest-workflow/session-registry.ts";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import {
	type Host,
	type HostedState,
	hostRegistryPath,
	installHost,
	type LaunchHints,
	releaseSession,
	SESSION_STAMP_EVENT,
	withSession,
} from "../../../lib/core/session/index.ts";
import { tickedOwnerNow } from "../../../lib/internal/process-ticks.ts";
import {
	localProcessDeps,
	probeProcess,
} from "../../../lib/internal/quest/process-liveness.ts";
import {
	journalSession,
	setJournalSession,
} from "../../../lib/internal/quest/structural-journal.ts";
import { parseQuestFrontMatter } from "../../../lib/quest/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { succeeded } from "./_helpers.ts";

let root: string;
let uninstall: (() => void) | undefined;
const states = new Map<string, HostedState>();
const hints = new Map<string, LaunchHints>();
const contexts = (id: string) =>
	({
		cwd: root,
		hasUI: false,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => id,
			isPersisted: () => true,
			getEntries: () => [],
		},
	}) as unknown as Parameters<typeof handle>[2];

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "hosted-quests-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	const owner = await tickedOwnerNow();
	if (!owner) throw new Error("test process has no identity");
	states.set("a", "busy");
	states.set("b", "idle");
	const host: Host = {
		kind: "pi-durable",
		key: "quest-test-host",
		owner,
		holds: (id) => states.get(id),
		env: () => {
			throw new Error("no environment needed");
		},
		hints: (id) => {
			const found = hints.get(id) ?? {};
			hints.delete(id);
			return found;
		},
		close: (id) => {
			states.delete(id);
		},
		stamp: vi.fn(),
	};
	uninstall = installHost(host);
});
afterEach(() => {
	releaseSession("a");
	releaseSession("b");
	uninstall?.();
	states.clear();
	hints.clear();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

it("lists co-hosted peers, detaches only the closing lease and keeps its sibling live", async () => {
	const pi = fakePi();
	const a = createQuestState({ questsRoot: join(root, "quests") });
	const b = createQuestState({ questsRoot: join(root, "quests") });
	const created = await withSession("a", () =>
		handle(a, pi, contexts("a"), { action: "create", title: "Shared host" }),
	);
	succeeded(created);
	const loaded = await withSession("b", () =>
		handle(b, pi, contexts("b"), {
			action: "load",
			id: a.questId ?? undefined,
		}),
	);
	expect(succeeded(loaded).message).toContain("session a");
	const sessions = () => {
		const doc = parseQuestFrontMatter(
			readFileSync(join(a.questDir ?? "", "README.md"), "utf8"),
		);
		if (!doc) throw new Error("quest missing");
		return doc.frontMatter.sessions;
	};
	const identities = sessions();
	expect(identities).toHaveLength(2);
	expect(identities[0]?.instanceId).not.toBe(identities[1]?.instanceId);
	expect(
		identities.every(
			(session) => session.process?.hosted?.session === session.id,
		),
		"each quest record names its own hosted conversation",
	).toBe(true);
	expect(
		identities.every((session) => !session.terminal),
		"hosted conversations must not inherit their host's terminal identity",
	).toBe(true);
	expect(
		withSession("a", () => livePeers(sessions()).map((p) => p.id)),
	).toEqual(["b"]);
	expect(
		withSession("b", () => livePeers(sessions()).map((p) => p.id)),
	).toEqual(["a"]);
	expect(readRecord("b")?.process?.hosted?.session).toBe("b");
	await withSession("a", () => {
		recordSessionEnd("a", "quit");
		releaseSessionOnShutdown(a, "a");
	});
	states.delete("a");
	expect(sessions().find((s) => s.id === "a")?.status).toBe("detached");
	expect(withSession("b", () => livePeers(sessions()))).toEqual([]);
	const identity = identities.find((s) => s.id === "a")?.process;
	if (!identity) throw new Error("no process captured");
	expect(probeProcess(identity, localProcessDeps())).toBe("gone");
	expect(readRecord("b")?.closedAt).toBeUndefined();
	const sibling = withSession("b", () => captureSessionIdentity().process);
	if (!sibling) throw new Error("no sibling identity");
	expect(probeProcess(sibling, localProcessDeps())).toBe("matching");
});

it("takes only its own launch hints and literal first words", async () => {
	const pi = fakePi();
	const a = createQuestState({ questsRoot: join(root, "quests") });
	await withSession("a", () =>
		handle(a, pi, contexts("a"), { action: "create", title: "Hint target" }),
	);
	hints.set("a", {
		questId: a.questId ?? undefined,
		firstWords: "only a gets this",
	});
	const b = createQuestState({
		questsRoot: join(root, "quests"),
		autoloadFromCwd: false,
	});
	expect(
		withSession("b", () => resolveStartup(b, pi, contexts("b"))).source,
	).toBe("none");
	expect(hints.has("a"), "b must not consume a's launch hints").toBe(true);
	const fresh = createQuestState({ questsRoot: join(root, "quests") });
	expect(
		withSession("a", () => resolveStartup(fresh, pi, contexts("a"))).source,
	).toBe("explicit");
	const send = vi.spyOn(pi, "sendUserMessage");
	withSession("a", () =>
		sayFirstWords(pi, contexts("a"), "a", () => false),
	)?.();
	expect(send).toHaveBeenCalledWith("only a gets this", undefined);
	expect(
		withSession("b", () => sayFirstWords(pi, contexts("b"), "b", () => false)),
	).toBeUndefined();
});

it("accepts only its own host stamps and preserves signal endings through shutdown", () => {
	const pi = fakePi();
	const release = vi.fn();
	for (const id of ["a", "b"])
		withSession(id, () =>
			trackSession({
				sessionId: id,
				cwd: root,
				...captureSessionIdentity(),
			}),
		);
	const off = followHostStamps(pi.events, "a", release);
	pi.events.emit(SESSION_STAMP_EVENT, { session: "b", how: "signalled" });
	pi.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "reload" });
	expect(release).not.toHaveBeenCalled();
	pi.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "signalled" });
	recordSessionEnd("a", "quit");
	expect(readRecord("a")?.endReason).toBe("signalled");
	expect(readRecord("b")?.closedAt).toBeUndefined();
	expect(release).toHaveBeenCalledOnce();
	off();
	pi.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "closed" });
	expect(release).toHaveBeenCalledOnce();
});

it("records a host's stop of a conversation parking as a park, not as lost", () => {
	const pi = fakePi();
	const release = vi.fn();
	for (const id of ["a", "b"])
		withSession(id, () =>
			trackSession({
				sessionId: id,
				cwd: root,
				...captureSessionIdentity(),
			}),
		);
	const parking = followHostStamps(pi.events, "a", release, () => true);
	const stopping = followHostStamps(pi.events, "b", release, () => false);

	pi.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "signalled" });
	pi.events.emit(SESSION_STAMP_EVENT, { session: "b", how: "signalled" });

	expect(readRecord("a")?.endReason, "a parked as it was stopped").toBe(
		"parked",
	);
	expect(readRecord("b")?.endReason, "b's host stopped it").toBe("signalled");
	expect(release, "each released").toHaveBeenCalledTimes(2);
	parking();
	stopping();
});

it("checks the host list from another reader without treating a missing list as death", () => {
	const identity = withSession("a", () => captureSessionIdentity().process);
	if (!identity?.hosted) throw new Error("no hosted identity");
	const hosting = identity.hosted;
	uninstall?.();
	const file = hostRegistryPath(hosting.owner);
	expect(probeProcess(identity, localProcessDeps())).toBe("unknown");
	mkdirSync(dirname(file), { recursive: true });
	const publish = (ids: string[]) =>
		writeFileSync(
			file,
			JSON.stringify({
				key: hosting.host,
				owner: hosting.owner,
				sessions: ids.map((id) => ({
					id,
					state: "idle",
					since: new Date().toISOString(),
				})),
			}),
		);
	publish(["a", "b"]);
	expect(probeProcess(identity, localProcessDeps())).toBe("matching");
	publish(["b"]);
	expect(probeProcess(identity, localProcessDeps())).toBe("gone");
	expect(
		probeProcess(
			{ ...identity, startToken: "a reused pid", startTicks: undefined },
			{
				localHostId: identity.hostId,
				inspect: () => ({ kind: "alive", startToken: "different" }),
			},
		),
	).toBe("gone");
});

it("keeps journal authors and heartbeats separate and leaves process signals to the host", () => {
	const listeners = process.listenerCount("SIGTERM");
	const interval = vi.spyOn(globalThis, "setInterval");
	const cleared = vi.spyOn(globalThis, "clearInterval");
	for (const id of ["a", "b"])
		withSession(id, () => {
			setJournalSession(id);
			trackSession({
				sessionId: id,
				cwd: root,
				...captureSessionIdentity(),
			});
		});
	expect(withSession("a", journalSession)).toBe("a");
	expect(withSession("b", journalSession)).toBe("b");
	// Each conversation keeps its own record true, so each beats.
	expect(interval).toHaveBeenCalledTimes(2);
	const [a, b] = interval.mock.results.map((result) => result.value);
	withSession("a", stopHeartbeat);
	expect(cleared.mock.calls, "stopping a stops only a's").toEqual([[a]]);
	withSession("b", stopHeartbeat);
	expect(cleared.mock.calls.at(-1)).toEqual([b]);
	expect(process.listenerCount("SIGTERM")).toBe(listeners);
});
