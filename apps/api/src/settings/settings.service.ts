import { isWorkspaceAdmin, workspaceRoleOf } from "@crm/auth/organization";
import type { Db } from "@crm/db";
import {
	CLAUDE_CODE,
	type ClaudeCodeEffort,
	claudeCodeModelId,
	parseClaudeCodeId,
	splitAgentModelId,
} from "@crm/db/claude-code";
import {
	DEFAULT_AGENT_MODEL,
	maskKey,
	readAgentModel,
	readArchiveRetentionDays,
	readContextDevKey,
	writeAgentModel,
	writeArchiveRetentionDays,
	writeContextDevKey,
} from "@crm/db/settings";
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
} from "@nestjs/common";
import { ResearchKeyService } from "../agent/research-key.service";
import { BackfillService } from "../backfill/backfill.service";
import { InjectDatabase } from "../database/database.constants";
import { ModelCatalogService } from "./model-catalog.service";
import type {
	AgentModelSettings,
	ArchiveRetentionSettings,
	ModelCatalogResult,
	ResearchKeySettings,
} from "./settings.contracts";

@Injectable()
export class SettingsService {
	private readonly logger = new Logger(SettingsService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly catalog: ModelCatalogService,
		private readonly researchKeys: ResearchKeyService,
		private readonly backfill: BackfillService,
	) {}

	async agentModel(): Promise<AgentModelSettings> {
		const [model, row] = await Promise.all([
			readAgentModel(this.db),
			this.db.appSetting.findFirst({ select: { updatedAt: true } }),
		]);

		const { baseId, effort } = splitAgentModelId(model.id);

		return {
			selectedId: model.isDefault ? null : baseId,
			effectiveId: model.id,
			defaultId: DEFAULT_AGENT_MODEL.id,
			effective: await this.catalog.find(baseId),
			effort,
			updatedAt: row?.updatedAt.toISOString() ?? null,
		};
	}

	async setAgentModel(
		userId: string,
		modelId: string | null,
		effort: ClaudeCodeEffort | null,
	): Promise<AgentModelSettings> {
		await this.assertAdmin(userId, "change the agent model");

		if (modelId === null) {
			await writeAgentModel(this.db, null);
			this.logger.log({ message: "Agent model reset to the default" });
			return this.agentModel();
		}

		const chosen = await this.catalog.find(modelId);
		if (!chosen) {
			throw new BadRequestException(
				`No tool-using model called "${modelId}" is available right now. Refresh the list and try again.`,
			);
		}

		if (effort && !chosen.efforts.includes(effort)) {
			throw new BadRequestException(
				`${chosen.name} does not support the "${effort}" effort.`,
			);
		}

		const local = parseClaudeCodeId(chosen.id);
		const id = local ? claudeCodeModelId(local.model, effort) : chosen.id;
		const contextWindowTokens =
			(await this.catalog.contextWindowOf(chosen)) ??
			CLAUDE_CODE.fallbackContextWindowTokens;

		await writeAgentModel(this.db, { id, contextWindowTokens });

		this.logger.log({
			message: "Agent model changed",
			modelId: id,
			contextWindowTokens,
		});

		return this.agentModel();
	}

	async refreshClaudeCodeModels(userId: string): Promise<ModelCatalogResult> {
		await this.assertAdmin(userId, "refresh the Claude Code models");
		return this.catalog.catalog({ refresh: true });
	}

	private async assertAdmin(userId: string, action: string): Promise<void> {
		if (!isWorkspaceAdmin(await workspaceRoleOf(userId, this.db))) {
			throw new ForbiddenException(`Only an owner or an admin can ${action}.`);
		}
	}

	async modelCatalog(): Promise<ModelCatalogResult> {
		return this.catalog.catalog();
	}

	async researchKey(): Promise<ResearchKeySettings> {
		const key = await readContextDevKey(this.db);

		return { configured: key !== null, hint: key ? maskKey(key) : null };
	}

	async setResearchKey(apiKey: string): Promise<ResearchKeySettings> {
		const check = await this.researchKeys.verify(apiKey);

		if (check.outcome === "invalid") {
			throw new BadRequestException(check.reason);
		}

		await writeContextDevKey(this.db, apiKey);

		this.logger.log({
			message: "Context key saved",
			verified: check.outcome === "valid",
		});

		// Every company added while there was no key is still PENDING, because a
		// brand task with nowhere to look leaves the record alone. The sign-in
		// sweep would find them, but the person who just fixed it is standing
		// here — so pick the work up now rather than on their next sign-in.
		void this.backfill
			.run("companies")
			.then(({ queued, remaining }) => {
				if (queued > 0) {
					this.logger.log({
						message: "Queued the research that was waiting on a key",
						queued,
						remaining,
					});
				}
			})
			.catch((cause: unknown) => {
				this.logger.warn(
					{ message: "Could not queue the waiting research" },
					cause instanceof Error ? cause.stack : String(cause),
				);
			});

		return this.researchKey();
	}

	async archiveRetention(): Promise<ArchiveRetentionSettings> {
		return { days: await readArchiveRetentionDays(this.db) };
	}

	async setArchiveRetention(days: number): Promise<ArchiveRetentionSettings> {
		const saved = await writeArchiveRetentionDays(this.db, days);

		this.logger.log({
			message: "Archive retention changed",
			days: saved,
		});

		return { days: saved };
	}
}
