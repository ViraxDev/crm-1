export const CLAUDE_CODE_PATH_ENV = "CLAUDE_CODE_PATH";

export const CLAUDE_CODE_PREFIX = "claude-code/";

export const CLAUDE_CODE_PROVIDER = "Claude Code (local)";

const SECOND_MS = 1_000;

export const CLAUDE_CODE = {
	concurrency: 2,
	timeoutMs: 600 * SECOND_MS,
	discoveryTimeoutMs: 60 * SECOND_MS,
	probeTimeoutMs: 120 * SECOND_MS,
	catalogCacheMs: 30 * SECOND_MS,
	discoveryRetryMs: 300 * SECOND_MS,
	maxStderrBytes: 4_000,
	fallbackContextWindowTokens: 200_000,
} as const;

export const CLAUDE_CODE_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

export const CLAUDE_CODE_MODEL_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,119}$/;

export type ClaudeCodeSelection = {
	model: string;
	effort: ClaudeCodeEffort | null;
};

export function isClaudeCodeEffort(value: string): value is ClaudeCodeEffort {
	return (CLAUDE_CODE_EFFORTS as readonly string[]).includes(value);
}

export function claudeCodeModelId(
	model: string,
	effort?: string | null,
): string {
	return effort
		? `${CLAUDE_CODE_PREFIX}${model}:${effort}`
		: `${CLAUDE_CODE_PREFIX}${model}`;
}

export function parseClaudeCodeId(id: string): ClaudeCodeSelection | null {
	if (!id.startsWith(CLAUDE_CODE_PREFIX)) return null;

	const [model = "", effort, ...rest] = id
		.slice(CLAUDE_CODE_PREFIX.length)
		.split(":");
	if (rest.length > 0 || !CLAUDE_CODE_MODEL_PATTERN.test(model)) return null;
	if (effort === undefined) return { model, effort: null };
	return isClaudeCodeEffort(effort) ? { model, effort } : null;
}

export function splitAgentModelId(id: string): {
	baseId: string;
	effort: ClaudeCodeEffort | null;
} {
	const local = parseClaudeCodeId(id);
	return local
		? { baseId: claudeCodeModelId(local.model), effort: local.effort }
		: { baseId: id, effort: null };
}

export function claudeCodeBinary(): string | null {
	return process.env[CLAUDE_CODE_PATH_ENV]?.trim() || null;
}
