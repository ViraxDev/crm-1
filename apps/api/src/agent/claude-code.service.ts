import { CLAUDE_CODE } from "@crm/db/claude-code";
import {
	type ClaudeCodeCatalog,
	claudeCodeCatalog,
} from "@crm/validation/claude-code-catalog";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { bridge } from "./bridge";

const modelsAnswer = z.object({
	reason: z.string().optional().catch(undefined),
	catalog: claudeCodeCatalog.optional().catch(undefined),
});

const probeAnswer = z.object({
	contextWindowTokens: z.number().int().positive().nullable().catch(null),
	reason: z.string().optional().catch(undefined),
});

type Discovery =
	| { ok: true; catalog: ClaudeCodeCatalog }
	| { ok: false; reason: string };

const NO_BRIDGE =
	"This install has no AGENT_BRIDGE_SECRET, so the agent cannot be asked.";

function reasonOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

@Injectable()
export class ClaudeCodeService {
	private readonly logger = new Logger(ClaudeCodeService.name);

	async discover(): Promise<Discovery> {
		try {
			const answer = await this.post(
				"/internal/claude-code/models",
				{},
				CLAUDE_CODE.discoveryTimeoutMs,
			);
			if (!answer) return { ok: false, reason: NO_BRIDGE };

			const body = modelsAnswer.parse(await answer.json());
			if (body.catalog) return { ok: true, catalog: body.catalog };
			return {
				ok: false,
				reason: body.reason ?? `The agent answered ${answer.status}.`,
			};
		} catch (error) {
			const reason = reasonOf(error);
			this.logger.warn({
				message: "Could not list Claude Code models",
				reason,
			});
			return { ok: false, reason };
		}
	}

	async probe(model: string): Promise<number | null> {
		try {
			const answer = await this.post(
				"/internal/claude-code/probe",
				{ model },
				CLAUDE_CODE.probeTimeoutMs,
			);
			if (!answer) return null;

			const body = probeAnswer.parse(await answer.json());
			if (body.contextWindowTokens === null) {
				this.logger.warn({
					message: "The agent could not measure the Claude Code context window",
					model,
					reason: body.reason ?? `The agent answered ${answer.status}.`,
				});
			}
			return body.contextWindowTokens;
		} catch (error) {
			this.logger.warn({
				message: "Could not measure the Claude Code context window",
				model,
				reason: reasonOf(error),
			});
			return null;
		}
	}

	private async post(
		path: string,
		body: { model?: string },
		timeoutMs: number,
	): Promise<Response | null> {
		const agent = bridge();
		if (!agent) return null;

		return fetch(agent.url(path), {
			method: "POST",
			headers: {
				authorization: `Bearer ${agent.secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	}
}
