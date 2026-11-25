/**
 * `review_offer` over a stack: putting several branches up at once,
 * each onto the one before it with a note naming its neighbours, and
 * pointing a restacked stack's changes back at what they now sit on.
 *
 * Apart from the single change's actions because these change with how
 * a stack is ordered, noted and moved, and a partial outcome is the
 * case each has to say plainly.
 */

import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BoundTarget, Change } from "../../../lib/core/review/index.ts";
import {
	proposalComplaint,
	retargetPlan,
	retargetRoute,
} from "../../../lib/core/review/index.ts";
import { composePrBody } from "../../../lib/core/sections/compose.ts";
import { PR_SHAPE } from "../../../lib/core/sections/sanctioned.ts";
import { usesDepth } from "../../../lib/core/sections/shape.ts";
import { sessionCwd, sessionKeyOf } from "../../../lib/core/session/index.ts";
import { sayProposed } from "../../../lib/internal/session/landings.ts";
import { count } from "../../../lib/ui/count.ts";
import { REVIEW_COMMANDS, reviewExec } from "../commands.ts";
import { GLYPH, proposalLine } from "../render.ts";
import { councilFirst } from "../reviewed-first.ts";
import { checkoutSize } from "./change-size.ts";
import { checkoutFacts, tipSubject } from "./offer-checkout.ts";
import { confirmWrite, missingMethod } from "./offer-gates.ts";
import type { OfferParams } from "./offer-request.ts";
import { sayRefusal } from "./resubmit.ts";
import { withNote } from "./sections.ts";
import {
	type Answer,
	declined,
	type hostedChange,
	messageOf,
	refuse,
	say,
} from "./shared.ts";

/**
 * Put a whole stack up, each change based on the one before it.
 *
 * The order is the caller's, roots first, because nothing here can work it
 * out. A stack lives in a tool that tracks parentage, and the working layer
 * has no stacks facet yet, so asking the caller is honest where inferring
 * from merge-base would be a guess dressed as a fact.
 *
 * This exists because `proposeStack` had been declared, implemented and
 * advertised by `review capabilities` as "propose a stack" while no verb
 * could reach it. A capability a caller is told about and cannot use is the
 * same lie as one that does not work, told from the other end.
 */
export async function proposeStack(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
	bus?: Pick<EventBus, "emit">,
): Promise<Answer> {
	if (params.draft === undefined) {
		return refuse(
			"Say whether these open as drafts. It is not defaulted, because the backends disagree about what silence means.",
		);
	}

	const heads = params.heads ?? [];
	if (heads.length < 2) {
		return refuse(
			"A stack needs at least two branches, named roots first. For one branch, propose it.",
		);
	}
	if (authoring.proposeStack === undefined) {
		return refuse(missingMethod(bound.provider.id, "propose a stack"));
	}

	// Positional, aligned to `heads`, because `heads` already carries the
	// dependency order. A shorter list is refused rather than paired off
	// against the branches it reaches: quietly leaving the last change empty
	// puts a body somebody wrote on a change they did not mean.
	if (params.bodies !== undefined && params.sections !== undefined) {
		return refuse(
			"Give the descriptions as sections or as bodies, not both. Sections are the better way: the tool writes the headings and puts each stack note after the TL;DR.",
		);
	}
	const bodies =
		params.sections?.map((one) => composePrBody(one)) ?? params.bodies;
	if (bodies !== undefined && bodies.length !== heads.length) {
		return refuse(
			`This names ${count(heads.length, "branch", "branches")} and ${count(bodies.length, "body", "bodies")}. Give one body per branch, in the same order, or none at all.`,
		);
	}

	const repeated = heads.filter((one, at) => heads.indexOf(one) !== at);
	if (repeated.length > 0) {
		// A branch twice in a stack would be proposed onto itself, and the
		// backend's refusal for that is not worth passing on.
		return refuse(
			`${repeated[0]} is named twice. A stack is an order, so each branch appears once.`,
		);
	}

	const cwd = params.repo ?? sessionCwd(ctx);
	const facts = await checkoutFacts(REVIEW_COMMANDS, cwd);
	const base = params.base ?? facts.trunk;
	if (base === undefined) {
		return refuse(
			"There is no trunk here to stack onto, so name the base the first change merges into.",
		);
	}

	const subjects = await Promise.all(
		heads.map((head) => tipSubject(REVIEW_COMMANDS, cwd, head)),
	);
	const missing = heads.filter((_, at) => subjects[at] === undefined);
	if (missing.length > 0) {
		return refuse(
			`This checkout has no branch called ${missing.join(" or ")}, so there is nothing to propose for it.`,
		);
	}

	// Every body, not just the first, and before anything is sent. The stack
	// path is not a way around the conventions the single path enforces. A
	// body that goes deeper is held to its own change's size: the diff from
	// the branch below it, or for the root from the trunk.
	for (const [at, body] of (bodies ?? []).entries()) {
		const head = heads[at] ?? "";
		const below = at === 0 ? [`origin/${base}`, base] : [heads[at - 1] ?? base];
		const size = usesDepth(body, PR_SHAPE)
			? await checkoutSize(REVIEW_COMMANDS, cwd, below, head)
			: undefined;
		const complaint = proposalComplaint(undefined, body, size);
		if (complaint) {
			const said = sayRefusal(sessionKeyOf(ctx), complaint, head, body);
			return refuse(`The body for ${head} is not usable.\n\n${said}`);
		}
	}

	// Each change waits for a council of ours, as one proposed alone does.
	// Each is judged by its own commits, as ready judges it later: a
	// council of the tip may have read only the top change, and a stack
	// round records a witness for every change it read.
	if (!params.draft) {
		for (const [at, head] of heads.entries()) {
			const waits = await councilFirst(
				reviewExec,
				{
					repo: bound.repo.key,
					checkout: cwd,
					base: at === 0 ? base : (heads[at - 1] ?? base),
					head,
				},
				"proposed for review",
			);
			if (waits) return refuse(waits);
		}
	}

	// Each onto the one before it, which is what makes this a stack rather
	// than a handful of changes proposed together.
	const drafts = heads.map((head, at) => ({
		repo: bound.repo,
		base: at === 0 ? base : (heads[at - 1] ?? base),
		head,
		title: subjects[at] ?? head,
		body: bodies?.[at] ?? "",
		draft: params.draft === true,
	}));

	const decision = await confirmWrite(
		ctx,
		`Propose ${heads.length} Changes as a Stack`,
		[
			`${GLYPH.target} on ${bound.repo.key}`,
			...drafts.map(
				(one, at) =>
					`   ${at + 1}. ${one.title}\n      ${one.head} \u2192 ${one.base}`,
			),
			"",
			// Said plainly, because a stack is the case where a partial
			// outcome is most likely and hardest to read afterwards.
			"Each is based on the one above it, so an earlier one failing leaves the rest without a base.",
		].join("\n"),
	);
	if (!decision.approved) return declined(decision, "Not proposed.");

	const made = await authoring.proposeStack(drafts);

	// The notes go on afterwards because a note names the changes either
	// side, and no number exists until every change does. This is the only
	// place they are all known at once: left to the caller it is one edit
	// per change, each its own gated call, each easy to forget half way.
	const noted = await annotateStack(authoring, made, drafts);
	sayProposed(
		bus,
		made.map((one) => one.url),
	);

	return say(
		[
			`${GLYPH.lands} ${made.length} of ${drafts.length} proposed`,
			...made.map((one) => `   ${proposalLine(one)}`),
			...(noted ? [`   ${GLYPH.refused} ${noted}`] : []),
		].join("\n"),
		{
			ok: true,
			proposed: made.length,
			asked: drafts.length,
			// Read by show_person, which keeps a session's own changes off
			// the person's look list (lib/mesh/looks/own-changes.ts).
			urls: made.map((one) => one.url),
		},
	);
}

/**
 * Write each change's stack note, and say if that failed.
 *
 * Undefined when every note landed. A failure here must not lose the
 * changes: the stack is up by then, and reporting a bare failure
 * describes a world where it is not, which invites proposing it again.
 * So this answers with what went wrong rather than throwing.
 *
 * Skipped for a body nobody wrote. Editing an empty body to hold nothing
 * but a note would put the navigation where the description should be.
 */
async function annotateStack(
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	made: Change[],
	drafts: { body: string }[],
): Promise<string | undefined> {
	if (made.length < 2) return undefined;

	const failures: string[] = [];
	for (const [at, one] of made.entries()) {
		const body = drafts[at]?.body;
		if (!body) continue;
		try {
			await authoring.edit(one.ref, {
				body: {
					action: "set",
					value: withStackNote(body, made, at),
				},
			});
		} catch (error) {
			failures.push(`${one.ref.label}: ${messageOf(error)}`);
		}
	}
	if (failures.length === 0) return undefined;
	return `the stack is up, and its notes are not: ${failures.join("; ")}`;
}

/**
 * A body with its stack note in it, straight after the TL;DR.
 *
 * The shape is the github-pr-format skill's: the change below, this one
 * in bold, the change above. The bottom of a stack has nothing below it
 * and the top nothing above, so each keeps only the segments pointing
 * somewhere rather than printing a dangling arrow.
 */
function withStackNote(body: string, made: Change[], at: number): string {
	const below = at > 0 ? made[at - 1]?.ref.label : undefined;
	const above = at < made.length - 1 ? made[at + 1]?.ref.label : undefined;
	const segments = [
		...(below ? [`\u{1F448} ${below}`] : []),
		`\u{1F447} **${made[at]?.ref.label}**`,
		...(above ? [`\u{1F449} ${above}`] : []),
	];
	return withNote(
		body,
		["> [!NOTE]", `> ${segments.join(" \u00b7 ")}`].join("\n"),
	);
}

/**
 * Point a stack's changes back at what they now sit on.
 *
 * A local restack moves branches and leaves the changes claiming to
 * merge into wherever they targeted when they went up. On a stack
 * whose bottom has landed, that is a change aimed at a branch nobody
 * is merging any more.
 */
export async function retargetStack(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	bound: BoundTarget,
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
): Promise<Answer> {
	if (bound.provider.stacking === undefined) {
		return refuse(
			`${bound.provider.id} does not read stacks, so there is nothing here to retarget. Move each change with review_offer edit base:...`,
		);
	}

	const route = retargetRoute(bound.provider.stacking, authoring);
	if ("refusal" in route) return refuse(route.refusal);

	const stack = await bound.provider.stacking.stack(change);
	const plan = retargetPlan(stack);
	if (plan.moves.length === 0) {
		// A no-op reported as a no-op. Saying "retargeted" about nothing
		// is how somebody concludes the stack was wrong and goes looking.
		return say(
			[
				`${GLYPH.lands} Every change in ${change.label}'s stack already targets what it sits on.`,
				...plan.skipped.map((one) => `   ${one.ref}: ${one.why}`),
			].join("\n"),
			{ ok: true, moved: 0 },
		);
	}

	const decision = await confirmWrite(
		ctx,
		`Retarget ${count(plan.moves.length, "Change", "Changes")} in ${change.label}'s Stack`,
		[
			...plan.moves.map(
				(move) => `${GLYPH.target} ${move.ref}: ${move.from} → ${move.to}`,
			),
			"",
			// Which route runs is shown, because the two fail differently
			// and this is the moment to know which one is about to.
			route.kind === "native"
				? `Moved as one: ${route.why}.`
				: `Moved one at a time: ${route.why}, so a failure part way leaves some moved and some not.`,
		].join("\n"),
	);
	if (!decision.approved)
		return declined(decision, "Left pointing where they were.");

	if (route.kind === "native") {
		// Non-null because retargetRoute only says native when it is there.
		await bound.provider.stacking.restack?.(change);
		return say(
			`${GLYPH.lands} Retargeted ${count(plan.moves.length, "change", "changes")} in ${change.label}'s stack, as one operation.`,
			{ ok: true, moved: plan.moves.length },
		);
	}

	// One at a time, reporting how far it got. A walk that stops half
	// way has genuinely moved some of them, and a bare failure would
	// leave somebody unable to tell that from having moved none.
	const moved: string[] = [];
	for (const move of plan.moves) {
		try {
			await authoring.edit(
				{ ...change, id: move.ref, label: move.ref },
				{ base: { action: "set", value: move.to } },
			);
			moved.push(`${move.ref} → ${move.to}`);
		} catch (error) {
			return refuse(
				[
					`Stopped at ${move.ref}: ${error instanceof Error ? error.message : String(error)}`,
					...(moved.length === 0
						? ["Nothing was moved."]
						: [
								`Already moved, and left that way: ${moved.join(", ")}.`,
								"Run this again once the cause is dealt with; what is already right is skipped.",
							]),
				].join("\n"),
			);
		}
	}

	return say(
		`${GLYPH.lands} Retargeted ${count(moved.length, "change", "changes")}: ${moved.join(", ")}.`,
		{ ok: true, moved: moved.length },
	);
}
