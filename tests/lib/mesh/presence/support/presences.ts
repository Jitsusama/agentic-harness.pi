/**
 * What the presence tests share: this session's id, a peer's presence
 * as another peer would publish it, and the surroundings this session's
 * own peer runs in, all under one temporary root.
 */
import { join } from "node:path";
import type { Surroundings } from "../../../../../lib/mesh/peer.ts";
import {
	createPresences,
	type Presence,
} from "../../../../../lib/mesh/presence.ts";

/** This session's id, as pi gives it. */
export const session = "01a15f3a-2255-7463-9909-afa624b025fe";

/** A peer's presence as another peer would publish it, with `over` laid on. */
export const presence = (over: Partial<Presence> = {}): Presence => ({
	session: "s-1",
	addresses: ["7M6JKG"],
	groups: ["#harness"],
	worksOn: "the mesh",
	owns: ["harness"],
	busy: false,
	at: "2026-10-21T22:00:00.000Z",
	...over,
});

/**
 * This session's surroundings under `root`: its session and quest
 * records there, and its presences in a folder of their own.
 */
export const surroundingsAt = (root: string): Surroundings => ({
	session,
	cwd: root,
	records: { sessions: join(root, "sessions"), quests: join(root, "quests") },
	presences: createPresences(join(root, "presence")),
});
