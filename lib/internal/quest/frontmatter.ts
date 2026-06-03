/**
 * Front-matter parser and serializer for quest READMEs
 * and quest documents.
 *
 * The block is YAML between two `---` fences. We use the
 * `yaml` library for parsing and serialization, and then
 * project the result onto the typed `QuestFrontMatter` /
 * `DocumentFrontMatter` shapes the rest of the library
 * works with.
 *
 * Validation rules:
 *
 * - Required scalars must be present; missing or invalid
 *   ones yield `undefined` from the parser so callers can
 *   surface a clean error.
 * - Enums (kind, status, priority, stage) are strict; an
 *   unknown value is rejected.
 * - Aliases serialize as objects (`{type, value}`) rather
 *   than `type:value` strings, so consumers don't have to
 *   reparse them.
 * - Sessions serialize as objects with `id` plus optional
 *   `name`, `cwd`, `started` and `status` fields.
 * - Optional fields (`due`, `eta`, etc.) only appear in the
 *   output when set.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
	DocumentFrontMatter,
	DocumentKind,
	DocumentStage,
	PendingPrune,
	QuestAlias,
	QuestFrontMatter,
	QuestKind,
	QuestPriority,
	QuestSession,
	QuestStatus,
	QuestTree,
	SessionStatus,
} from "../../quest/types.js";

const QUEST_KINDS: QuestKind[] = ["quest", "subquest", "sidequest"];
const QUEST_STATUSES: QuestStatus[] = [
	"active",
	"paused",
	"blocked",
	"concluded",
	"retired",
];
const QUEST_PRIORITIES: QuestPriority[] = [
	"driving",
	"active",
	"queued",
	"bench",
	"someday",
];
const DOCUMENT_KINDS: DocumentKind[] = ["plan", "research", "brief", "report"];
const DOCUMENT_STAGES: DocumentStage[] = [
	"think",
	"draft",
	"build",
	"concluded",
	"retired",
];
const SESSION_STATUSES: SessionStatus[] = ["active", "detached"];

/** Split a text into the front-matter block (raw YAML) and the body. */
export function splitFrontMatter(
	text: string,
): { fmText: string; body: string } | undefined {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) return undefined;
	const fmText = lines.slice(1, end).join("\n");
	let body = lines.slice(end + 1).join("\n");
	if (body.startsWith("\n")) body = body.slice(1);
	return { fmText, body };
}

function parseFrontMatterBlock(
	text: string,
): Record<string, unknown> | undefined {
	const split = splitFrontMatter(text);
	if (!split) return undefined;
	let raw: unknown;
	try {
		raw = parseYaml(split.fmText) ?? {};
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	return raw as Record<string, unknown>;
}

function asEnum<T extends string>(value: unknown, options: T[]): T | undefined {
	if (typeof value !== "string") return undefined;
	return options.includes(value as T) ? (value as T) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function parseAliasValue(raw: unknown): QuestAlias | undefined {
	if (typeof raw === "string") {
		const colon = raw.indexOf(":");
		if (colon <= 0) return undefined;
		const type = raw.slice(0, colon).trim();
		const value = raw.slice(colon + 1).trim();
		if (!type || !value) return undefined;
		return { type, value };
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		const type = asString(obj.type);
		const value = asString(obj.value);
		if (type && value) return { type, value };
	}
	return undefined;
}

function parseAliases(raw: unknown): QuestAlias[] {
	if (!Array.isArray(raw)) return [];
	const out: QuestAlias[] = [];
	for (const entry of raw) {
		const alias = parseAliasValue(entry);
		if (alias) out.push(alias);
	}
	return out;
}

function parseSession(raw: unknown): QuestSession | undefined {
	if (typeof raw === "string") {
		return raw.length > 0 ? { id: raw } : undefined;
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		const id = asString(obj.id);
		if (!id) return undefined;
		const session: QuestSession = { id };
		const name = asString(obj.name);
		if (name) session.name = name;
		const cwd = asString(obj.cwd);
		if (cwd) session.cwd = cwd;
		const started = asString(obj.started);
		if (started) session.started = started;
		const status = asEnum(obj.status, SESSION_STATUSES);
		if (status) session.status = status;
		return session;
	}
	return undefined;
}

function parseSessions(raw: unknown): QuestSession[] {
	if (!Array.isArray(raw)) return [];
	const out: QuestSession[] = [];
	for (const entry of raw) {
		const session = parseSession(entry);
		if (session) out.push(session);
	}
	return out;
}

function parseTree(raw: unknown): QuestTree | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const path = asString(obj.path);
	const providerId = asString(obj.providerId);
	if (!path || !providerId) return undefined;
	const tree: QuestTree = { path, providerId };
	const branch = asString(obj.branch);
	if (branch) tree.branch = branch;
	const repoRoot = asString(obj.repoRoot);
	if (repoRoot) tree.repoRoot = repoRoot;
	if (Array.isArray(obj.zones)) {
		const zones: string[] = [];
		for (const z of obj.zones) {
			const zone = asString(z);
			if (zone) zones.push(zone);
		}
		if (zones.length > 0) tree.zones = zones;
	}
	return tree;
}

function parseTrees(raw: unknown): QuestTree[] {
	if (!Array.isArray(raw)) return [];
	const out: QuestTree[] = [];
	for (const entry of raw) {
		const tree = parseTree(entry);
		if (tree) out.push(tree);
	}
	return out;
}

function parsePendingPruneEntry(raw: unknown): PendingPrune | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const path = asString(obj.path);
	const reason = asString(obj.reason);
	const detectedAt = asString(obj.detectedAt);
	if (!path || !reason || !detectedAt) return undefined;
	return { path, reason, detectedAt };
}

function parsePendingPrune(raw: unknown): PendingPrune[] {
	// Accept both the legacy scalar form (one entry as an
	// object) and the canonical array form, so an older
	// README round-trips without losing data.
	if (Array.isArray(raw)) {
		const out: PendingPrune[] = [];
		for (const entry of raw) {
			const parsed = parsePendingPruneEntry(entry);
			if (parsed) out.push(parsed);
		}
		return out;
	}
	const single = parsePendingPruneEntry(raw);
	return single ? [single] : [];
}

/**
 * Keys the quest-frontmatter parser recognises. Anything
 * outside this set is captured into `_extra` so a
 * round-trip preserves user-added fields.
 */
const KNOWN_QUEST_KEYS = new Set<string>([
	"id",
	"kind",
	"parent",
	"status",
	"priority",
	"rank",
	"started",
	"updated",
	"due",
	"eta",
	"aliases",
	"sessions",
	"trees",
	"pendingPrune",
	"primaryPlanId",
]);

const KNOWN_DOCUMENT_KEYS = new Set<string>([
	"id",
	"kind",
	"quest",
	"stage",
	"updated",
	"rounds",
	"subject",
]);

function captureExtras(
	raw: Record<string, unknown>,
	known: Set<string>,
): Record<string, unknown> | undefined {
	let extras: Record<string, unknown> | undefined;
	for (const key of Object.keys(raw)) {
		if (known.has(key)) continue;
		extras ??= {};
		extras[key] = raw[key];
	}
	return extras;
}

/** Parse the quest README front-matter from raw text. */
export function parseQuestFrontMatter(
	text: string,
): { frontMatter: QuestFrontMatter; body: string } | undefined {
	const split = splitFrontMatter(text);
	if (!split) return undefined;
	const raw = parseFrontMatterBlock(text);
	if (!raw) return undefined;

	const id = asString(raw.id);
	const kind = asEnum(raw.kind, QUEST_KINDS);
	const status = asEnum(raw.status, QUEST_STATUSES);
	const priority = asEnum(raw.priority, QUEST_PRIORITIES);
	const rank = asNumber(raw.rank);
	const started = asString(raw.started);
	const updated = asString(raw.updated);

	if (
		!id ||
		!kind ||
		!status ||
		!priority ||
		rank === undefined ||
		!started ||
		!updated
	) {
		return undefined;
	}

	const parentRaw = raw.parent;
	const parent =
		parentRaw === null ||
		parentRaw === undefined ||
		parentRaw === "null" ||
		parentRaw === "~"
			? null
			: typeof parentRaw === "string"
				? parentRaw
				: null;

	const frontMatter: QuestFrontMatter = {
		id,
		kind,
		parent,
		status,
		priority,
		rank,
		started,
		updated,
		aliases: parseAliases(raw.aliases),
		sessions: parseSessions(raw.sessions),
	};
	const due = asString(raw.due);
	const eta = asString(raw.eta);
	if (due) frontMatter.due = due;
	if (eta) frontMatter.eta = eta;
	const trees = parseTrees(raw.trees);
	if (trees.length > 0) frontMatter.trees = trees;
	const pendingPrune = parsePendingPrune(raw.pendingPrune);
	if (pendingPrune.length > 0) frontMatter.pendingPrune = pendingPrune;
	const primaryPlanId = asString(raw.primaryPlanId);
	if (primaryPlanId) frontMatter.primaryPlanId = primaryPlanId;
	const extras = captureExtras(raw, KNOWN_QUEST_KEYS);
	if (extras) frontMatter._extra = extras;

	return { frontMatter, body: split.body };
}

/** Parse a quest document (plan/research/brief/report) front-matter. */
export function parseDocumentFrontMatter(
	text: string,
): { frontMatter: DocumentFrontMatter; body: string } | undefined {
	const split = splitFrontMatter(text);
	if (!split) return undefined;
	const raw = parseFrontMatterBlock(text);
	if (!raw) return undefined;

	const id = asString(raw.id);
	const kind = asEnum(raw.kind, DOCUMENT_KINDS);
	const quest = asString(raw.quest);
	const stage = asEnum(raw.stage, DOCUMENT_STAGES);
	const updated = asString(raw.updated);

	if (!id || !kind || !quest || !stage || !updated) return undefined;

	const fm: DocumentFrontMatter = { id, kind, quest, stage, updated };
	const rounds = asNumber(raw.rounds);
	if (rounds !== undefined && Number.isInteger(rounds) && rounds >= 0) {
		fm.rounds = rounds;
	}
	const subject = asString(raw.subject);
	if (subject) fm.subject = subject;
	const extras = captureExtras(raw, KNOWN_DOCUMENT_KEYS);
	if (extras) fm._extra = extras;

	return { frontMatter: fm, body: split.body };
}

function sessionToPlain(session: QuestSession): Record<string, unknown> {
	const out: Record<string, unknown> = { id: session.id };
	if (session.name !== undefined) out.name = session.name;
	if (session.cwd !== undefined) out.cwd = session.cwd;
	if (session.started !== undefined) out.started = session.started;
	if (session.status !== undefined) out.status = session.status;
	return out;
}

function renderYamlBlock(payload: Record<string, unknown>): string {
	// stringifyYaml emits with a trailing newline. Trim so the
	// fenced block is exactly the fields we care about and the
	// downstream join keeps the fence shape stable.
	const text = stringifyYaml(payload, {
		lineWidth: 0,
		nullStr: "null",
	}).replace(/\n$/, "");
	return ["---", text, "---"].join("\n");
}

/** Serialize a quest front-matter back to a `---` block. */
export function serializeQuestFrontMatter(fm: QuestFrontMatter): string {
	const payload: Record<string, unknown> = {
		id: fm.id,
		kind: fm.kind,
		parent: fm.parent,
		status: fm.status,
		priority: fm.priority,
		rank: fm.rank,
		started: fm.started,
		updated: fm.updated,
	};
	if (fm.due) payload.due = fm.due;
	if (fm.eta) payload.eta = fm.eta;
	payload.aliases = fm.aliases.map((a) => ({ type: a.type, value: a.value }));
	payload.sessions = fm.sessions.map(sessionToPlain);
	if (fm.trees && fm.trees.length > 0) {
		payload.trees = fm.trees.map(treeToPlain);
	}
	if (fm.pendingPrune && fm.pendingPrune.length > 0) {
		payload.pendingPrune = fm.pendingPrune.map((entry) => ({
			path: entry.path,
			reason: entry.reason,
			detectedAt: entry.detectedAt,
		}));
	}
	if (fm.primaryPlanId) payload.primaryPlanId = fm.primaryPlanId;
	if (fm._extra) {
		for (const [key, value] of Object.entries(fm._extra)) {
			if (!(key in payload)) payload[key] = value;
		}
	}
	return renderYamlBlock(payload);
}

function treeToPlain(tree: QuestTree): Record<string, unknown> {
	const out: Record<string, unknown> = {
		path: tree.path,
		providerId: tree.providerId,
	};
	if (tree.branch !== undefined) out.branch = tree.branch;
	if (tree.repoRoot !== undefined) out.repoRoot = tree.repoRoot;
	if (tree.zones && tree.zones.length > 0) out.zones = tree.zones;
	return out;
}

/** Serialize a document front-matter back to a `---` block. */
export function serializeDocumentFrontMatter(fm: DocumentFrontMatter): string {
	const payload: Record<string, unknown> = {
		id: fm.id,
		kind: fm.kind,
		quest: fm.quest,
		stage: fm.stage,
		updated: fm.updated,
	};
	if (fm.rounds !== undefined) payload.rounds = fm.rounds;
	if (fm.subject) payload.subject = fm.subject;
	if (fm._extra) {
		for (const [key, value] of Object.entries(fm._extra)) {
			if (!(key in payload)) payload[key] = value;
		}
	}
	return renderYamlBlock(payload);
}
