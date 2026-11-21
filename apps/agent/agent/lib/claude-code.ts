import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import {
	CLAUDE_CODE,
	type ClaudeCodeSelection,
	claudeCodeModelId,
} from "@crm/db/claude-code";
import { z } from "zod";
import {
	buildRequest,
	type ClaudeCodeRequest,
	parseReply,
} from "./claude-code-prompt";

const cliResult = z.object({
	type: z.literal("result"),
	subtype: z.string(),
	is_error: z.boolean(),
	result: z.string().catch(""),
	structured_output: z.unknown().optional(),
	session_id: z.string().optional(),
	usage: z
		.object({
			input_tokens: z.number().catch(0),
			cache_creation_input_tokens: z.number().catch(0),
			cache_read_input_tokens: z.number().catch(0),
			output_tokens: z.number().catch(0),
			output_tokens_details: z
				.object({ thinking_tokens: z.number().catch(0) })
				.optional()
				.catch(undefined),
		})
		.optional()
		.catch(undefined),
	modelUsage: z
		.record(
			z.string(),
			z.object({
				contextWindow: z.number().int().positive().optional().catch(undefined),
			}),
		)
		.optional()
		.catch(undefined),
});

type CliResult = z.infer<typeof cliResult>;

export class ClaudeCodeError extends Error {
	override readonly name = "ClaudeCodeError";
}

export const BARE_ARGS = [
	"--tools",
	"",
	"--setting-sources",
	"",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--no-session-persistence",
] as const;

function semaphore(width: number) {
	let active = 0;
	const waiting: Array<() => void> = [];

	return async function limited<T>(run: () => Promise<T>): Promise<T> {
		if (active >= width) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		active += 1;
		try {
			return await run();
		} finally {
			active -= 1;
			waiting.shift()?.();
		}
	};
}

export const limited = semaphore(CLAUDE_CODE.concurrency);

function tail(text: string): string {
	return text.length > CLAUDE_CODE.maxStderrBytes
		? text.slice(-CLAUDE_CODE.maxStderrBytes)
		: text;
}

type CliRun = {
	binary: string;
	args: readonly string[];
	input: string;
	cwd: string;
	timeoutMs: number;
	abortSignal?: AbortSignal;
};

export function runCli(run: CliRun): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		if (run.abortSignal?.aborted) {
			reject(run.abortSignal.reason);
			return;
		}

		const child = spawn(run.binary, run.args, {
			cwd: run.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new ClaudeCodeError(`claude timed out after ${run.timeoutMs} ms`));
		}, run.timeoutMs);

		const abort = () => {
			child.kill("SIGTERM");
			reject(
				run.abortSignal?.reason ?? new ClaudeCodeError("claude was aborted"),
			);
		};
		run.abortSignal?.addEventListener("abort", abort, { once: true });

		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			out += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			err = tail(err + chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(
				new ClaudeCodeError(`could not start ${run.binary}: ${error.message}`),
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			run.abortSignal?.removeEventListener("abort", abort);
			if (code === 0 || out.trim()) resolve(out);
			else
				reject(
					new ClaudeCodeError(`claude exited with code ${code}: ${err.trim()}`),
				);
		});

		child.stdin.end(run.input);
	});
}

export async function withWorkdir<T>(
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "crm-claude-code-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function runClaudeCode(
	binary: string,
	selection: ClaudeCodeSelection,
	request: ClaudeCodeRequest,
	options: { abortSignal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CliResult> {
	return withWorkdir(async (dir) => {
		const systemFile = join(dir, "system.md");
		await writeFile(
			systemFile,
			request.system || "You are a helpful assistant.",
		);

		const stdout = await runCli({
			binary,
			cwd: dir,
			input: request.transcript,
			timeoutMs: options.timeoutMs ?? CLAUDE_CODE.timeoutMs,
			abortSignal: options.abortSignal,
			args: [
				"--print",
				"--output-format",
				"json",
				"--model",
				selection.model,
				...(selection.effort ? ["--effort", selection.effort] : []),
				...BARE_ARGS,
				"--system-prompt-file",
				systemFile,
				...(request.schema
					? ["--json-schema", JSON.stringify(request.schema)]
					: []),
			],
		});

		let parsed: CliResult;
		try {
			parsed = cliResult.parse(JSON.parse(stdout));
		} catch {
			throw new ClaudeCodeError(
				`claude returned output that is not a result: ${tail(stdout)}`,
			);
		}

		if (parsed.is_error) {
			throw new ClaudeCodeError(
				`claude failed (${parsed.subtype}): ${parsed.result}`,
			);
		}

		return parsed;
	});
}

export function contextWindowOf(result: CliResult): number | null {
	const windows = Object.values(result.modelUsage ?? {}).flatMap((usage) =>
		usage.contextWindow ? [usage.contextWindow] : [],
	);
	return windows.length > 0 ? Math.max(...windows) : null;
}

function usageOf(result: CliResult): LanguageModelV4Usage {
	const usage = result.usage;
	if (!usage) {
		return {
			inputTokens: {
				total: undefined,
				noCache: undefined,
				cacheRead: undefined,
				cacheWrite: undefined,
			},
			outputTokens: { total: undefined, text: undefined, reasoning: undefined },
		};
	}

	const reasoning = usage.output_tokens_details?.thinking_tokens ?? 0;
	return {
		inputTokens: {
			total:
				usage.input_tokens +
				usage.cache_creation_input_tokens +
				usage.cache_read_input_tokens,
			noCache: usage.input_tokens,
			cacheRead: usage.cache_read_input_tokens,
			cacheWrite: usage.cache_creation_input_tokens,
		},
		outputTokens: {
			total: usage.output_tokens,
			text: usage.output_tokens - reasoning,
			reasoning,
		},
	};
}

export function claudeCode(
	selection: ClaudeCodeSelection,
	binary: string,
): LanguageModelV4 {
	const modelId = claudeCodeModelId(selection.model, selection.effort);

	async function doGenerate(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4GenerateResult> {
		const request = buildRequest(options);
		const result = await limited(() =>
			runClaudeCode(binary, selection, request, {
				abortSignal: options.abortSignal,
			}),
		);
		const reply = parseReply(
			request.mode,
			result.result,
			result.structured_output,
		);

		return {
			content: reply.content,
			finishReason: reply.finishReason,
			usage: usageOf(result),
			warnings: request.warnings,
			response: { id: result.session_id, modelId, timestamp: new Date() },
		};
	}

	return {
		specificationVersion: "v4",
		provider: "claude-code",
		modelId,
		supportedUrls: {},
		doGenerate,
		async doStream(options) {
			const generated = await doGenerate(options);
			const parts: LanguageModelV4StreamPart[] = [
				{ type: "stream-start", warnings: generated.warnings },
				{ type: "response-metadata", ...generated.response },
			];

			generated.content.forEach((part, index) => {
				if (part.type === "text") {
					const id = `text-${index}`;
					parts.push(
						{ type: "text-start", id },
						{ type: "text-delta", id, delta: part.text },
						{ type: "text-end", id },
					);
				} else if (part.type === "tool-call") {
					parts.push(
						{
							type: "tool-input-start",
							id: part.toolCallId,
							toolName: part.toolName,
						},
						{
							type: "tool-input-delta",
							id: part.toolCallId,
							delta: part.input,
						},
						{ type: "tool-input-end", id: part.toolCallId },
						part,
					);
				}
			});

			parts.push({
				type: "finish",
				usage: generated.usage,
				finishReason: generated.finishReason,
			});

			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
			};
		},
	};
}
