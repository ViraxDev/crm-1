import type { ClaudeCodeEffort } from "@crm/db/claude-code";
import type { RouterOutputs } from "@/lib/trpc/types";

export type CatalogModel =
	RouterOutputs["settings"]["modelCatalog"]["models"][number];

export const EFFORT_LABELS = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
} satisfies Record<ClaudeCodeEffort, string>;

function perMillion(rate: number): string {
	const dollars = rate * 1_000_000;
	return `$${dollars.toFixed(2).replace(/\.?0+$/, "")}`;
}

export function priceHint(model: CatalogModel): string | null {
	if (!model.pricing) return null;
	return `${perMillion(model.pricing.input)} in, ${perMillion(model.pricing.output)} out per 1M`;
}

export function contextHint(tokens: number | null): string {
	if (tokens === null) return "Context measured when chosen";
	return tokens >= 1_000_000
		? `${Math.round(tokens / 1_000_000)}M context`
		: `${Math.round(tokens / 1_000)}K context`;
}

export function byProvider(models: CatalogModel[]): [string, CatalogModel[]][] {
	const groups = new Map<string, CatalogModel[]>();

	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}

	return [...groups];
}
