/**
 * Document scaffolding: build the initial markdown body for
 * a new quest README or a new quest document.
 *
 * The scaffolded body is a starting shape with the canonical
 * section headers (and emoji glyphs) and one-line guidance
 * underneath each. Authors are expected to overwrite the
 * guidance immediately; the structure makes the round-trip
 * parsing reliable.
 *
 * Optional sections (Milestones, Spirit, Outcomes, Context)
 * are emitted as commented placeholders the author uncomments
 * when they need them. We do not enforce their presence.
 */

import type {
	DocumentFrontMatter,
	DocumentKind,
	QuestFrontMatter,
	QuestKind,
} from "../../quest/types.js";
import {
	serializeDocumentFrontMatter,
	serializeQuestFrontMatter,
} from "./frontmatter.js";

/** Inputs for scaffolding a fresh quest README. */
export interface QuestScaffoldInput {
	frontMatter: QuestFrontMatter;
	title: string;
	/** Optional initial Summary prose. */
	summary?: string;
	/** Optional initial Purpose prose. */
	purpose?: string;
	/** Optional initial Cast bullets. */
	cast?: Array<{ role: string; subject: string; prose?: string }>;
	/** Optional initial Journey entry. */
	journey?: Array<{ date: string; prose: string }>;
	/** Optional Milestones bullets. */
	milestones?: Array<{ checked: boolean; text: string }>;
	/** Include the optional sections as placeholders. */
	includeOptionalSections?: boolean;
}

function castBullet(entry: {
	role: string;
	subject: string;
	prose?: string;
}): string {
	const role = entry.role.toLowerCase();
	const tail = entry.prose ? `. ${entry.prose}` : "";
	return `- **${role}**: ${entry.subject}${tail}`;
}

function journeyBullet(entry: { date: string; prose: string }): string {
	return `- **${entry.date}**: ${entry.prose}`;
}

function milestoneBullet(entry: { checked: boolean; text: string }): string {
	return `- [${entry.checked ? "x" : " "}] ${entry.text}`;
}

/**
 * Build a fresh quest README. The four core sections are
 * always present; optional sections appear behind a
 * commented marker unless `includeOptionalSections` is true.
 */
export function scaffoldQuestReadme(input: QuestScaffoldInput): string {
	const fm = serializeQuestFrontMatter(input.frontMatter);
	const parts: string[] = [fm, "", `# ${input.title}`, ""];

	parts.push("## 📜 Summary", "");
	parts.push(
		input.summary ?? "_One paragraph: what this quest is and why it exists._",
		"",
	);

	parts.push("## 🧭 Purpose", "");
	parts.push(
		input.purpose ?? "_Why now, what good looks like, what is in scope._",
		"",
	);

	parts.push("## 🎭 Cast", "");
	if (input.cast && input.cast.length > 0) {
		for (const entry of input.cast) parts.push(castBullet(entry));
	} else {
		parts.push("- **owner**: _name or @handle_");
	}
	parts.push("");

	parts.push("## 🌄 Journey", "");
	if (input.journey && input.journey.length > 0) {
		for (const entry of input.journey) parts.push(journeyBullet(entry));
	} else {
		parts.push(`- **${input.frontMatter.started}**: Created.`);
	}
	parts.push("");

	const milestones = input.milestones ?? [];
	if (input.includeOptionalSections || milestones.length > 0) {
		parts.push("## 🎯 Milestones", "");
		if (milestones.length > 0) {
			for (const m of milestones) parts.push(milestoneBullet(m));
		} else {
			parts.push("- [ ] _first milestone_");
		}
		parts.push("");
	}

	if (input.includeOptionalSections) {
		parts.push(
			"## 🔥 Spirit",
			"",
			"_The stable north star that survives deviation._",
			"",
		);
		parts.push(
			"## 🏆 Outcomes",
			"",
			"_What landed when this quest concluded._",
			"",
		);
		parts.push(
			"## 🏰 Context",
			"",
			"_Background that doesn't fit in Summary or Purpose._",
			"",
		);
	}

	return parts.join("\n");
}

const DOCUMENT_KIND_HEADINGS: Record<DocumentKind, string[]> = {
	plan: [
		"## Spirit",
		"",
		"_The stable north star: why this work exists and what good looks like._",
		"",
		"## Context",
		"",
		"_What framing the problem surfaced. Constraints. Scope._",
		"",
		"## Approach",
		"",
		"_The shape we settled on and the decisions behind it._",
		"",
		"## Work",
		"",
		"- [ ] _first checklist item_",
		"",
		"## Open Questions",
		"",
		"_Decisions still pending. Each with a recommended lean._",
		"",
		"## Discovery & Deviations",
		"",
		"_Things learned during build that changed the plan._",
		"",
	],
	research: [
		"## Question",
		"",
		"_The thing we're trying to answer._",
		"",
		"## Method",
		"",
		"_How the investigation proceeded._",
		"",
		"## Findings",
		"",
		"_What we learned._",
		"",
		"## Verdict",
		"",
		"_The recommendation that came out of the investigation._",
		"",
	],
	brief: [
		"## Audience",
		"",
		"_Who this brief is for._",
		"",
		"## Ask",
		"",
		"_What we want them to do or decide._",
		"",
		"## Background",
		"",
		"_The minimal context needed to act._",
		"",
		"## Recommendation",
		"",
		"_What we propose._",
		"",
	],
	report: [
		"## What Happened",
		"",
		"_The narrative of the work._",
		"",
		"## Outcomes",
		"",
		"_What landed, what didn't._",
		"",
		"## Lessons",
		"",
		"_What we learned for next time._",
		"",
	],
};

/** Inputs for scaffolding a quest document (plan/research/etc.). */
export interface DocumentScaffoldInput {
	frontMatter: DocumentFrontMatter;
	title: string;
}

/** Build a fresh quest document with the kind's section template. */
export function scaffoldDocument(input: DocumentScaffoldInput): string {
	const fm = serializeDocumentFrontMatter(input.frontMatter);
	const sections = DOCUMENT_KIND_HEADINGS[input.frontMatter.kind];
	const parts = [fm, "", `# ${input.title}`, "", ...sections];
	return parts.join("\n");
}

/** Convenience: map quest kind to the default scaffold options. */
export function defaultsForKind(_kind: QuestKind): {
	includeOptionalSections: boolean;
} {
	return { includeOptionalSections: false };
}
