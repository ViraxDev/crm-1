import type { Db } from "@crm/db";
import {
	CLAUDE_CODE,
	CLAUDE_CODE_PROVIDER,
	claudeCodeModelId,
	parseClaudeCodeId,
} from "@crm/db/claude-code";
import {
	type ClaudeCodeCatalog,
	keepMeasuredWindows,
	readClaudeCodeCatalog,
	withContextWindow,
	writeClaudeCodeCatalog,
} from "@crm/validation/claude-code-catalog";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Cache } from "cache-manager";
import { z } from "zod";
import { ClaudeCodeService } from "../agent/claude-code.service";
import type { EnvironmentVariables } from "../config/env.validation";
import { InjectDatabase } from "../database/database.constants";
import type { CatalogModel, ModelCatalogResult } from "./settings.contracts";

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

const CATALOG_TTL_MS = 30 * 60_000;

const CATALOG_KEY = "settings:model-catalog";

const CATALOG_TIMEOUT_MS = 5_000;

const gatewayRate = z
	.union([z.number(), z.string()])
	.transform((value) => Number(value))
	.refine((value) => Number.isFinite(value))
	.nullable()
	.catch(null);

const gatewayModel = z.object({
	id: z.string(),
	name: z.string().catch(""),
	owned_by: z.string().catch(""),
	type: z.string().catch(""),
	tags: z.array(z.json()).catch([]),
	context_window: z.number(),
	pricing: z
		.object({ input: gatewayRate, output: gatewayRate })
		.nullable()
		.catch(null),
});

type GatewayModel = z.infer<typeof gatewayModel>;

const gatewayCatalog = z
	.object({ data: z.array(z.json()).catch([]) })
	.catch({ data: [] });

function usable(model: GatewayModel): boolean {
	return model.type === "language" && model.tags.includes("tool-use");
}

function toCatalogModel(model: GatewayModel): CatalogModel {
	const input = model.pricing?.input ?? null;
	const output = model.pricing?.output ?? null;

	return {
		id: model.id,
		name: model.name || model.id,
		provider: model.owned_by || (model.id.split("/")[0] ?? model.id),
		contextWindowTokens: model.context_window,
		pricing: input !== null && output !== null ? { input, output } : null,
		efforts: [],
	};
}

function claudeCodeModels(catalog: ClaudeCodeCatalog | null): CatalogModel[] {
	return (catalog?.models ?? []).map((model) => ({
		id: claudeCodeModelId(model.model),
		name: model.name,
		provider: CLAUDE_CODE_PROVIDER,
		contextWindowTokens: model.contextWindowTokens,
		pricing: null,
		efforts: model.efforts,
	}));
}

@Injectable()
export class ModelCatalogService {
	private readonly logger = new Logger(ModelCatalogService.name);

	readonly claudeCodeEnabled: boolean;

	private discoveryFailure: { at: number; reason: string } | null = null;

	constructor(
		@Inject(CACHE_MANAGER) private readonly cache: Cache,
		@InjectDatabase() private readonly db: Db,
		private readonly claudeCode: ClaudeCodeService,
		config: ConfigService<EnvironmentVariables, true>,
	) {
		this.claudeCodeEnabled = Boolean(
			config.get("CLAUDE_CODE_PATH", { infer: true })?.trim(),
		);
	}

	async catalog(
		options: { refresh?: boolean } = {},
	): Promise<ModelCatalogResult> {
		const [gateway, local] = await Promise.all([
			this.gatewayModels(),
			this.localCatalog(options.refresh ?? false),
		]);

		return {
			models: [...claudeCodeModels(local.catalog), ...(gateway ?? [])],
			available: gateway !== null || this.claudeCodeEnabled,
			gatewayAvailable: gateway !== null,
			claudeCode: {
				enabled: this.claudeCodeEnabled,
				refreshedAt: local.catalog?.refreshedAt ?? null,
				version: local.catalog?.version ?? null,
				problem: local.problem,
			},
		};
	}

	async find(id: string): Promise<CatalogModel | null> {
		const models = parseClaudeCodeId(id)
			? claudeCodeModels(await this.storedCatalog())
			: await this.gatewayModels();
		return models?.find((model) => model.id === id) ?? null;
	}

	async contextWindowOf(model: CatalogModel): Promise<number | null> {
		if (model.contextWindowTokens) return model.contextWindowTokens;

		const local = parseClaudeCodeId(model.id);
		if (!local) return null;

		const measured = await this.claudeCode.probe(local.model);
		const stored = measured ? await this.storedCatalog() : null;
		if (measured && stored) {
			await writeClaudeCodeCatalog(
				this.db,
				withContextWindow(stored, local.model, measured),
			);
		}
		return measured;
	}

	private async storedCatalog(): Promise<ClaudeCodeCatalog | null> {
		if (!this.claudeCodeEnabled) return null;
		try {
			return await readClaudeCodeCatalog(this.db);
		} catch (error) {
			this.logger.warn({
				message: "Stored Claude Code catalog is unreadable",
				reason: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	private async localCatalog(
		refresh: boolean,
	): Promise<{ catalog: ClaudeCodeCatalog | null; problem: string | null }> {
		if (!this.claudeCodeEnabled) return { catalog: null, problem: null };

		const stored = await this.storedCatalog();
		const failure = this.discoveryFailure;
		const coolingDown =
			failure !== null &&
			Date.now() - failure.at < CLAUDE_CODE.discoveryRetryMs;

		if (!refresh && (stored || coolingDown)) {
			return { catalog: stored, problem: failure?.reason ?? null };
		}

		const discovery = await this.claudeCode.discover();
		if (!discovery.ok) {
			this.discoveryFailure = { at: Date.now(), reason: discovery.reason };
			return { catalog: stored, problem: discovery.reason };
		}

		this.discoveryFailure = null;
		const catalog = keepMeasuredWindows(discovery.catalog, stored);
		await writeClaudeCodeCatalog(this.db, catalog);
		return { catalog, problem: null };
	}

	private async gatewayModels(): Promise<CatalogModel[] | null> {
		const cached = await this.cache.get<CatalogModel[]>(CATALOG_KEY);
		if (cached) return cached;

		const models = await this.fetchCatalog();
		if (!models) return null;

		await this.cache.set(CATALOG_KEY, models, CATALOG_TTL_MS);
		return models;
	}

	private async fetchCatalog(): Promise<CatalogModel[] | null> {
		try {
			const response = await fetch(CATALOG_URL, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
			});

			if (!response.ok) {
				this.logger.warn({
					message: "Model catalog request failed",
					status: response.status,
				});
				return null;
			}

			const body = gatewayCatalog.parse(await response.json());

			const models = body.data.flatMap((entry) => {
				const parsed = gatewayModel.safeParse(entry);
				return parsed.success && usable(parsed.data)
					? [toCatalogModel(parsed.data)]
					: [];
			});

			models.sort(
				(a, b) =>
					a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
			);

			this.logger.log({
				message: "Model catalog loaded",
				models: models.length,
			});

			return models;
		} catch (error) {
			this.logger.warn({
				message: "Model catalog unavailable",
				reason: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
}
