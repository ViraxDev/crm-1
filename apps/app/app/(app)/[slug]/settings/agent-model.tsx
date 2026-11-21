"use client";

import type { ClaudeCodeEffort } from "@crm/db/claude-code";
import { Button } from "@crm/ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@crm/ui/components/command";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@crm/ui/components/field";
import { Icon } from "@crm/ui/components/icon";
import { MetaRow } from "@crm/ui/components/meta-row";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@crm/ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@crm/ui/components/select";
import { SettingsCard } from "@crm/ui/components/settings-card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { LocalRelativeTime } from "@/components/local-date-time";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";
import type { RouterOutputs } from "@/lib/trpc/types";

type CatalogModel = RouterOutputs["settings"]["modelCatalog"]["models"][number];

const FOLLOW_DEFAULT = "__default__";

const EFFORT_LABELS: Record<ClaudeCodeEffort, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

function perMillion(rate: number): string {
	const dollars = rate * 1_000_000;
	return `$${dollars.toFixed(2).replace(/\.?0+$/, "")}`;
}

function priceHint(model: CatalogModel): string | null {
	if (!model.pricing) return null;
	return `${perMillion(model.pricing.input)} in, ${perMillion(model.pricing.output)} out per 1M`;
}

function contextHint(tokens: number | null): string {
	if (tokens === null) return "Context measured when chosen";
	return tokens >= 1_000_000
		? `${Math.round(tokens / 1_000_000)}M context`
		: `${Math.round(tokens / 1_000)}K context`;
}

function byProvider(models: CatalogModel[]): [string, CatalogModel[]][] {
	const groups = new Map<string, CatalogModel[]>();

	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}

	return [...groups];
}

export function AgentModel() {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const queryClient = useQueryClient();
	const effortId = useId();
	const [open, setOpen] = useState(false);

	const settings = useQuery(trpc.settings.agentModel.queryOptions());
	const catalog = useQuery(trpc.settings.modelCatalog.queryOptions());

	const save = useMutation(
		trpc.settings.setAgentModel.mutationOptions({
			onSuccess: async () => {
				await Promise.all([
					cache.settings(),
					queryClient.invalidateQueries({
						queryKey: trpc.settings.modelCatalog.queryKey(),
					}),
				]);
				toast.success("The agent will use this model from its next session.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const refresh = useMutation(
		trpc.settings.refreshClaudeCodeModels.mutationOptions({
			onSuccess: (result) => {
				queryClient.setQueryData(trpc.settings.modelCatalog.queryKey(), result);
				if (result.claudeCode.problem) {
					toast.error(result.claudeCode.problem);
				} else {
					toast.success("Claude Code models refreshed.");
				}
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	if (!settings.data) return null;

	const { selectedId, effectiveId, defaultId, effective, effort } =
		settings.data;
	const models = catalog.data?.models ?? [];
	const claudeCode = catalog.data?.claudeCode;
	const unavailable = catalog.data !== undefined && !catalog.data.available;
	const gatewayDown =
		catalog.data !== undefined && !catalog.data.gatewayAvailable;

	const defaultModel = models.find((model) => model.id === defaultId);
	const current = selectedId ?? FOLLOW_DEFAULT;

	const effectiveName = effective?.name ?? effectiveId;

	const currentLabel = selectedId
		? effectiveName
		: `Default (${effectiveName})`;

	const efforts = selectedId ? (effective?.efforts ?? []) : [];
	const busy = save.isPending || refresh.isPending;

	const choose = (model: CatalogModel | null) => {
		setOpen(false);
		const id = model?.id ?? FOLLOW_DEFAULT;
		if (id === current) return;

		const keptEffort =
			effort && model?.efforts.includes(effort) ? effort : null;

		save.mutate({ modelId: model?.id ?? null, effort: keptEffort });
	};

	const chooseEffort = (value: string) => {
		if (!effective) return;
		save.mutate({
			modelId: effective.id,
			effort: effective.efforts.find((level) => level === value) ?? null,
		});
	};

	return (
		<SettingsCard
			title="Research agent"
			description={
				claudeCode?.enabled
					? "The model the agent thinks with, through the Vercel AI Gateway or Claude Code on this machine."
					: "The model the agent thinks with, routed through the Vercel AI Gateway."
			}
			hint="Changes save as you make them. The agent uses the new model from its next session."
		>
			<FieldGroup>
				<Field>
					<Popover open={open} onOpenChange={setOpen}>
						<PopoverTrigger asChild>
							<Button
								variant="outline"
								role="combobox"
								aria-expanded={open}
								aria-label="Model"
								disabled={busy || catalog.isPending || unavailable}
							>
								{currentLabel}
								<Icon icon={ChevronDownIcon} data-icon="inline-end" />
							</Button>
						</PopoverTrigger>

						<PopoverContent align="start" size="fit" className="w-96">
							<Command>
								<CommandInput placeholder="Search models…" />
								<CommandList>
									<CommandEmpty>No model matches that.</CommandEmpty>

									<CommandGroup>
										<CommandItem
											value={`default ${defaultId}`}
											data-checked={current === FOLLOW_DEFAULT}
											onSelect={() => choose(null)}
										>
											Default ({defaultModel?.name ?? defaultId})
										</CommandItem>
									</CommandGroup>

									{byProvider(models).map(([provider, group]) => (
										<CommandGroup key={provider} heading={provider}>
											{group.map((model) => {
												const price = priceHint(model);

												return (
													<CommandItem
														key={model.id}
														value={`${model.name} ${model.provider} ${model.id}`}
														data-checked={current === model.id}
														onSelect={() => choose(model)}
													>
														<span>{model.name}</span>
														<span className="ml-auto text-muted-foreground text-xs">
															{price ?? contextHint(model.contextWindowTokens)}
														</span>
													</CommandItem>
												);
											})}
										</CommandGroup>
									))}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>

					<MetaRow className="text-13">
						<span>{effectiveId}</span>
						{effective ? (
							<span>{contextHint(effective.contextWindowTokens)}</span>
						) : null}
						{effective && priceHint(effective) ? (
							<span>{priceHint(effective)}</span>
						) : null}
					</MetaRow>
					{gatewayDown ? (
						<FieldDescription>
							Could not reach the AI Gateway to list its models. The agent is
							still running {effectiveId}.
						</FieldDescription>
					) : null}
				</Field>

				{efforts.length > 0 ? (
					<Field>
						<FieldLabel htmlFor={effortId}>Effort</FieldLabel>
						<Select
							value={effort ?? FOLLOW_DEFAULT}
							onValueChange={chooseEffort}
							disabled={busy}
						>
							<SelectTrigger id={effortId} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={FOLLOW_DEFAULT}>Model default</SelectItem>
								{efforts.map((level) => (
									<SelectItem key={level} value={level}>
										{EFFORT_LABELS[level]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<FieldDescription>
							How hard the model thinks at each step. Higher is slower and uses
							more of your Claude plan.
						</FieldDescription>
					</Field>
				) : null}

				{claudeCode?.enabled ? (
					<Field>
						<FieldLabel>Claude Code models</FieldLabel>
						<div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => refresh.mutate()}
								disabled={busy}
							>
								<Icon icon={RefreshCwIcon} data-icon="inline-start" />
								Refresh the list
							</Button>
						</div>
						<MetaRow className="text-13">
							{claudeCode.version ? (
								<span>Claude Code {claudeCode.version}</span>
							) : null}
							{claudeCode.refreshedAt ? (
								<span>
									Listed <LocalRelativeTime date={claudeCode.refreshedAt} />
								</span>
							) : (
								<span>Not listed yet</span>
							)}
						</MetaRow>
						{claudeCode.problem ? (
							<FieldDescription>{claudeCode.problem}</FieldDescription>
						) : null}
					</Field>
				) : null}
			</FieldGroup>
		</SettingsCard>
	);
}
