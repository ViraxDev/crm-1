import { randomUUID } from "node:crypto";
import {
	CLAUDE_CODE,
	CLAUDE_CODE_MODEL_PATTERN,
	isClaudeCodeEffort,
} from "@crm/db/claude-code";
import type {
	ClaudeCodeCatalog,
	ClaudeCodeCatalogModel,
} from "@crm/validation/claude-code-catalog";
import { z } from "zod";
import {
	BARE_ARGS,
	ClaudeCodeError,
	contextWindowOf,
	limited,
	runClaudeCode,
	runCli,
	withWorkdir,
} from "./claude-code";

const DEFAULT_ALIAS = "default";

const advertisedModel = z.object({
	value: z.string(),
	resolvedModel: z.string().optional().catch(undefined),
	displayName: z.string().catch(""),
	description: z.string().catch(""),
	supportedEffortLevels: z.array(z.string()).optional().catch(undefined),
});

const initializeResponse = z.object({
	type: z.literal("control_response"),
	response: z.object({
		request_id: z.string(),
		subtype: z.string(),
		error: z.string().optional(),
		response: z
			.object({
				models: z.array(advertisedModel.nullable().catch(null)).catch([]),
				claude_code_version: z.string().optional().catch(undefined),
			})
			.optional(),
	}),
});

function catalogModel(
	model: z.infer<typeof advertisedModel> | null,
): ClaudeCodeCatalogModel | null {
	if (!model || model.value === DEFAULT_ALIAS) return null;
	if (!CLAUDE_CODE_MODEL_PATTERN.test(model.value)) return null;

	return {
		model: model.value,
		resolvedModel: model.resolvedModel ?? null,
		name: (model.displayName || model.value).slice(0, 120),
		description: model.description.slice(0, 500),
		efforts: (model.supportedEffortLevels ?? []).filter(isClaudeCodeEffort),
		contextWindowTokens: null,
	};
}

function initializeAnswer(stdout: string, requestId: string) {
	for (const line of stdout.split("\n")) {
		if (!line.includes("control_response")) continue;
		try {
			const parsed = initializeResponse.safeParse(JSON.parse(line));
			if (parsed.success && parsed.data.response.request_id === requestId) {
				return parsed.data.response;
			}
		} catch {}
	}
	return null;
}

export async function discoverClaudeCodeModels(
	binary: string,
): Promise<ClaudeCodeCatalog> {
	const requestId = randomUUID();
	const stdout = await withWorkdir((dir) =>
		runCli({
			binary,
			cwd: dir,
			timeoutMs: CLAUDE_CODE.discoveryTimeoutMs,
			input: `${JSON.stringify({
				type: "control_request",
				request_id: requestId,
				request: { subtype: "initialize" },
			})}\n`,
			args: [
				"--print",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				...BARE_ARGS,
			],
		}),
	);

	const answer = initializeAnswer(stdout, requestId);
	if (!answer?.response || answer.subtype !== "success") {
		throw new ClaudeCodeError(
			`claude did not list its models${answer?.error ? `: ${answer.error}` : "."}`,
		);
	}

	const seen = new Set<string>();
	const models = answer.response.models.flatMap((entry) => {
		const model = catalogModel(entry);
		if (!model || seen.has(model.model)) return [];
		seen.add(model.model);
		return [model];
	});

	return {
		refreshedAt: new Date().toISOString(),
		version: answer.response.claude_code_version ?? null,
		models,
	};
}

export async function probeContextWindow(
	binary: string,
	model: string,
	abortSignal?: AbortSignal,
): Promise<number | null> {
	if (!CLAUDE_CODE_MODEL_PATTERN.test(model)) return null;

	const result = await limited(() =>
		runClaudeCode(
			binary,
			{ model, effort: null },
			{
				system: "Reply with the single word OK.",
				transcript: "OK?",
				schema: null,
				mode: "text",
				warnings: [],
			},
			{ timeoutMs: CLAUDE_CODE.probeTimeoutMs, abortSignal },
		),
	);

	return contextWindowOf(result);
}
