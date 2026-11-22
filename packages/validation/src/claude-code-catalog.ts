import {
	CLAUDE_CODE_EFFORTS,
	CLAUDE_CODE_MODEL_PATTERN,
} from "@crm/db/claude-code";
import type { Db } from "@crm/db/client";
import { SETTINGS_ID } from "@crm/db/settings";
import { z } from "zod";

const claudeCodeEffort = z.enum(CLAUDE_CODE_EFFORTS);

const claudeCodeCatalogModel = z.object({
	model: z.string().regex(CLAUDE_CODE_MODEL_PATTERN),
	resolvedModel: z.string().nullable(),
	name: z.string().min(1).max(120),
	description: z.string().max(500),
	efforts: z.array(claudeCodeEffort),
	contextWindowTokens: z.number().int().positive().nullable(),
});

export type ClaudeCodeCatalogModel = z.infer<typeof claudeCodeCatalogModel>;

export const claudeCodeCatalog = z.object({
	refreshedAt: z.iso.datetime(),
	version: z.string().nullable(),
	models: z.array(claudeCodeCatalogModel),
});

export type ClaudeCodeCatalog = z.infer<typeof claudeCodeCatalog>;

export async function readClaudeCodeCatalog(
	db: Db,
): Promise<ClaudeCodeCatalog | null> {
	const row = await db.appSetting.findUnique({
		where: { id: SETTINGS_ID },
		select: { claudeCodeCatalog: true },
	});

	return row?.claudeCodeCatalog
		? claudeCodeCatalog.parse(row.claudeCodeCatalog)
		: null;
}

export async function writeClaudeCodeCatalog(
	db: Db,
	catalog: ClaudeCodeCatalog,
): Promise<void> {
	const value = claudeCodeCatalog.parse(catalog);

	await db.appSetting.upsert({
		where: { id: SETTINGS_ID },
		create: { id: SETTINGS_ID, claudeCodeCatalog: value },
		update: { claudeCodeCatalog: value },
	});
}

export function withContextWindow(
	catalog: ClaudeCodeCatalog,
	model: string,
	contextWindowTokens: number,
): ClaudeCodeCatalog {
	return {
		...catalog,
		models: catalog.models.map((entry) =>
			entry.model === model ? { ...entry, contextWindowTokens } : entry,
		),
	};
}

export function keepMeasuredWindows(
	next: ClaudeCodeCatalog,
	previous: ClaudeCodeCatalog | null,
): ClaudeCodeCatalog {
	const measured = new Map(
		(previous?.models ?? []).map((model) => [
			model.model,
			model.contextWindowTokens,
		]),
	);

	return {
		...next,
		models: next.models.map((model) => ({
			...model,
			contextWindowTokens:
				model.contextWindowTokens ?? measured.get(model.model) ?? null,
		})),
	};
}
