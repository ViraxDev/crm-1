import { db } from "@crm/db";
import {
	CLAUDE_CODE,
	CLAUDE_CODE_PATH_ENV,
	CLAUDE_CODE_PREFIX,
	claudeCodeBinary,
	parseClaudeCodeId,
} from "@crm/db/claude-code";
import { DEFAULT_AGENT_MODEL, readAgentModel } from "@crm/db/settings";
import {
	type ClaudeCodeCatalog,
	readClaudeCodeCatalog,
} from "@crm/validation/claude-code-catalog";
import type { LanguageModel } from "ai";
import type { DynamicResolveContext } from "eve";
import { claudeCode } from "./claude-code";

export interface ModelSelection {
	model: string;
	modelContextWindowTokens: number;
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

export async function stepModelSelection(
	current: { readonly id: string } | null,
): Promise<StepModelSelection> {
	if (!current) return DEFAULT_MODEL_SELECTION;

	const selection = parseClaudeCodeId(current.id);
	const binary = claudeCodeBinary();
	if (!selection || !binary) return { model: current.id };

	const catalog = await cachedCatalog();
	const measured = catalog?.models.find(
		(entry) => entry.model === selection.model,
	)?.contextWindowTokens;

	return {
		model: claudeCode(selection, binary),
		modelContextWindowTokens:
			measured ?? CLAUDE_CODE.fallbackContextWindowTokens,
	};
}

type SessionModelResolver = (
	event: unknown,
	ctx: DynamicResolveContext,
) => ModelSelection | Promise<ModelSelection>;

export function modelEvents(session: SessionModelResolver) {
	return {
		"session.started": async (event: unknown, ctx: DynamicResolveContext) => {
			const chosen = await session(event, ctx);
			return modelSelection(chosen.model, chosen.modelContextWindowTokens);
		},
		...(claudeCodeBinary()
			? {
					"step.started": (_event: unknown, ctx: DynamicResolveContext) =>
						stepModelSelection(ctx.model),
				}
			: {}),
	};
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
