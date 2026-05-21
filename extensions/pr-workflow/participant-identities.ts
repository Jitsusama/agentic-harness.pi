/** Stable reviewer identity tracking for user-facing finding origins. */

import type { CouncilReviewer } from "./reviewer.js";
import type { PrWorkflowState } from "./state.js";

/** Role a participant id was used for. */
export type ParticipantRole = "reviewer" | "judge";

/** Immutable participant identity once an id has produced findings. */
export interface ParticipantIdentity {
	readonly id: string;
	readonly role: ParticipantRole;
	readonly model?: string;
	readonly thinkingLevel?: CouncilReviewer["thinkingLevel"];
	readonly tools?: readonly string[];
}

/** Result of checking whether a participant id can be used. */
export type ParticipantIdentityResult =
	| { ok: true }
	| { ok: false; error: string };

/**
 * Ensure a participant id has not already been used for a
 * different reviewer or judge identity in this workflow session.
 */
export function assertParticipantIdentityAvailable(
	state: PrWorkflowState,
	role: ParticipantRole,
	reviewer: CouncilReviewer,
): ParticipantIdentityResult {
	const existing = state.participantIdentities.get(reviewer.id);
	if (!existing) return { ok: true };
	const next = participantIdentity(role, reviewer);
	if (sameParticipantIdentity(existing, next)) return { ok: true };
	return {
		ok: false,
		error:
			`Participant id "${reviewer.id}" was already used for ${describeParticipant(existing)}. ` +
			`Use a new id for ${describeParticipant(next)} so finding origins stay stable within the session.`,
	};
}

/** Remember that the participant id has now produced workflow output. */
export function rememberParticipantIdentity(
	state: PrWorkflowState,
	role: ParticipantRole,
	reviewer: CouncilReviewer,
): void {
	state.participantIdentities.set(
		reviewer.id,
		participantIdentity(role, reviewer),
	);
}

/** Remember every participant in order. */
export function rememberParticipantIdentities(
	state: PrWorkflowState,
	role: ParticipantRole,
	reviewers: readonly CouncilReviewer[],
): void {
	for (const reviewer of reviewers) {
		rememberParticipantIdentity(state, role, reviewer);
	}
}

/** Convert a reviewer config into its stable identity shape. */
export function participantIdentity(
	role: ParticipantRole,
	reviewer: CouncilReviewer,
): ParticipantIdentity {
	return {
		id: reviewer.id,
		role,
		...(reviewer.model ? { model: reviewer.model } : {}),
		...(reviewer.thinkingLevel
			? { thinkingLevel: reviewer.thinkingLevel }
			: {}),
		...(reviewer.tools ? { tools: [...reviewer.tools] } : {}),
	};
}

function sameParticipantIdentity(
	left: ParticipantIdentity,
	right: ParticipantIdentity,
): boolean {
	return (
		left.id === right.id &&
		left.role === right.role &&
		left.model === right.model &&
		left.thinkingLevel === right.thinkingLevel &&
		sameTools(left.tools, right.tools)
	);
}

function sameTools(
	left: readonly string[] | undefined,
	right: readonly string[] | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.length !== right.length) return false;
	return left.every((tool, index) => tool === right[index]);
}

function describeParticipant(identity: ParticipantIdentity): string {
	const parts: string[] = [identity.role];
	if (identity.model) parts.push(`model ${identity.model}`);
	if (identity.thinkingLevel) parts.push(`thinking ${identity.thinkingLevel}`);
	if (identity.tools) parts.push(`tools ${identity.tools.join(",")}`);
	return parts.join(" · ");
}
