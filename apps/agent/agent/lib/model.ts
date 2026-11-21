import { db } from "@crm/db";
import {
	CLAUDE_CODE,
	CLAUDE_CODE_PATH_ENV,
	CLAUDE_CODE_PREFIX,
	claudeCodeBinary,
	parseClaudeCodeId,
} from "@crm/db/claude-code";
import {
	DEFAULT_AGENT_MODEL,
	isAgentModelId,
	readAgentModel,
} from "@crm/db/settings";
import {
	type ClaudeCodeCatalog,
	readClaudeCodeCatalog,
} from "@crm/validation/claude-code-catalog";
import type { LanguageModel } from "ai";
import type { defineDynamic } from "eve";
import { claudeCode } from "./claude-code";
import { currentAttribute } from "./session-purpose";

export interface ModelSelection {
	model: string;
	modelContextWindowTokens: number;
}

export interface TurnModelSelection {
	model: string;
	modelContextWindowTokens?: number;
}

export interface StepModelSelection {
	model: string | LanguageModel;
	modelContextWindowTokens?: number;
}

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
	model: DEFAULT_AGENT_MODEL.id,
	modelContextWindowTokens: DEFAULT_AGENT_MODEL.contextWindowTokens,
};

let catalogCache: { at: number; catalog: ClaudeCodeCatalog | null } | null =
	null;

async function cachedCatalog(): Promise<ClaudeCodeCatalog | null> {
	if (
		catalogCache &&
		Date.now() - catalogCache.at < CLAUDE_CODE.catalogCacheMs
	) {
		return catalogCache.catalog;
	}

	try {
		const catalog = await readClaudeCodeCatalog(db);
		catalogCache = { at: Date.now(), catalog };
		return catalog;
	} catch (error) {
		console.error(
			`[agent] could not read the Claude Code catalog: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

function claudeCodeProblem(id: string): string | null {
	if (!id.startsWith(CLAUDE_CODE_PREFIX)) return null;
	if (!parseClaudeCodeId(id)) return "is not a valid Claude Code model";
	if (!claudeCodeBinary())
		return `needs ${CLAUDE_CODE_PATH_ENV}, which is not set`;
	return null;
}

export function modelSelection(
	id: string,
	contextWindowTokens: number,
): ModelSelection {
	const problem = claudeCodeProblem(id);
	if (problem) {
		console.error(`[agent] ${id} ${problem}. Using ${DEFAULT_AGENT_MODEL.id}.`);
		return DEFAULT_MODEL_SELECTION;
	}
	return { model: id, modelContextWindowTokens: contextWindowTokens };
}

async function claudeCodeWindow(model: string): Promise<number> {
	const catalog = await cachedCatalog();
	return (
		catalog?.models.find((entry) => entry.model === model)
			?.contextWindowTokens ?? CLAUDE_CODE.fallbackContextWindowTokens
	);
}

export async function stepModelSelection(
	current: { readonly id: string } | null,
): Promise<StepModelSelection> {
	if (!current) return DEFAULT_MODEL_SELECTION;

	const selection = parseClaudeCodeId(current.id);
	const binary = claudeCodeBinary();
	if (!selection || !binary) return { model: current.id };

	return {
		model: claudeCode(selection, binary),
		modelContextWindowTokens: await claudeCodeWindow(selection.model),
	};
}

async function usableRequest(requested: string | null): Promise<string | null> {
	if (!requested || !isAgentModelId(requested)) return null;
	if (claudeCodeProblem(requested)) return null;

	const local = parseClaudeCodeId(requested);
	if (!local) return requested;

	const listed = (await cachedCatalog())?.models.find(
		(entry) => entry.model === local.model,
	);
	if (!listed) return null;
	return !local.effort || listed.efforts.includes(local.effort)
		? requested
		: null;
}

export async function turnModelSelection(
	requested: string | null,
	current: { readonly id: string } | null,
): Promise<TurnModelSelection> {
	const id = (await usableRequest(requested)) ?? current?.id;
	if (!id) return selectedModel();

	const local = parseClaudeCodeId(id);
	if (local) {
		return {
			model: id,
			modelContextWindowTokens: await claudeCodeWindow(local.model),
		};
	}

	const setting = await selectedModel();
	return setting.model === id ? setting : { model: id };
}

type ResolverArgs = Parameters<
	NonNullable<Parameters<typeof defineDynamic>[0]["events"]["session.started"]>
>;

type SessionModelResolver = (
	...args: ResolverArgs
) => ModelSelection | Promise<ModelSelection>;

export function modelEvents(session: SessionModelResolver) {
	const sessionStarted = async (...args: ResolverArgs) => {
		const chosen = await session(...args);
		return modelSelection(chosen.model, chosen.modelContextWindowTokens);
	};
	const stepStarted = (...[, ctx]: ResolverArgs) =>
		stepModelSelection(ctx.model);

	return claudeCodeBinary()
		? { "session.started": sessionStarted, "step.started": stepStarted }
		: { "session.started": sessionStarted };
}

export function chatModelEvents(session: SessionModelResolver) {
	const turnStarted = (...[, ctx]: ResolverArgs) =>
		turnModelSelection(currentAttribute(ctx, "agentModel"), ctx.model);

	return { ...modelEvents(session), "turn.started": turnStarted };
}

export async function selectedModel(): Promise<ModelSelection> {
	try {
		const setting = await readAgentModel(db);
		return {
			model: setting.id,
			modelContextWindowTokens: setting.contextWindowTokens,
		};
	} catch (error) {
		console.error(
			`[agent] could not read the configured model, falling back: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return DEFAULT_MODEL_SELECTION;
	}
}

export function logModelBackends(): void {
	const binary = claudeCodeBinary();
	console.log(
		`[agent] ${binary ? "on " : "off"}  Claude Code CLI (${CLAUDE_CODE_PATH_ENV})`,
	);
}
