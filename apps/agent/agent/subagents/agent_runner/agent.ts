import { db } from "@crm/db";
import { defineAgent, defineDynamic } from "eve";
import { DEFAULT_MODEL_SELECTION, modelEvents } from "../../lib/model";
import { attribute, purposeOf } from "../../lib/session-purpose";

export default defineAgent({
	description:
		"Execute one immutable deployed CRM agent version and persist its result and every side effect.",
	model: defineDynamic({
		events: modelEvents(async (_event, ctx) => {
			if (purposeOf(ctx) !== "team-agent") {
				return DEFAULT_MODEL_SELECTION;
			}
			const runId = attribute(ctx, "runId");
			if (!runId) {
				return DEFAULT_MODEL_SELECTION;
			}

			const run = await db.agentRun.findUnique({
				where: { id: runId },
				select: {
					version: {
						select: { modelId: true, modelContextWindowTokens: true },
					},
				},
			});
			return run
				? {
						model: run.version.modelId,
						modelContextWindowTokens: run.version.modelContextWindowTokens,
					}
				: DEFAULT_MODEL_SELECTION;
		}),
	}),
	limits: {
		maxInputTokensPerSession: 500_000,
		maxOutputTokensPerSession: 40_000,
		sessionTimeoutMs: 24 * 60 * 60 * 1000,
	},
});
