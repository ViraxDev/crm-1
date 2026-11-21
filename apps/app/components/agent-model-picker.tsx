"use client";

import {
	type ClaudeCodeEffort,
	claudeCodeModelId,
	parseClaudeCodeId,
	splitAgentModelId,
} from "@crm/db/claude-code";
import { Button } from "@crm/ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@crm/ui/components/command";
import { Field, FieldLabel } from "@crm/ui/components/field";
import { Icon } from "@crm/ui/components/icon";
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
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";
import {
	byProvider,
	type CatalogModel,
	contextHint,
	EFFORT_LABELS,
	priceHint,
} from "@/lib/agent-models";
import { useTRPC } from "@/lib/trpc/client";

const FOLLOW_CONVERSATION = "__conversation__";

function withEffort(baseId: string, effort: ClaudeCodeEffort | null): string {
	const local = parseClaudeCodeId(baseId);
	return local ? claudeCodeModelId(local.model, effort) : baseId;
}

export function AgentModelPicker({
	value,
	onChange,
	disabled = false,
}: {
	value: string | null;
	onChange: (modelId: string | null) => void;
	disabled?: boolean;
}) {
	const trpc = useTRPC();
	const effortId = useId();
	const [open, setOpen] = useState(false);
	const catalog = useQuery(trpc.settings.modelCatalog.queryOptions());
	const workspace = useQuery(trpc.settings.agentModel.queryOptions());

	const models = catalog.data?.models ?? [];
	const chosen = value ? splitAgentModelId(value) : null;
	const model = chosen
		? models.find((candidate) => candidate.id === chosen.baseId)
		: undefined;
	const workspaceName =
		workspace.data?.effective?.name ?? workspace.data?.effectiveId ?? "";

	const label = model
		? [model.name, chosen?.effort ? EFFORT_LABELS[chosen.effort] : null]
				.filter(Boolean)
				.join(", ")
		: "Conversation model";

	const choose = (next: CatalogModel | null) => {
		setOpen(false);
		if (!next) {
			onChange(null);
			return;
		}
		const keptEffort =
			chosen?.effort && next.efforts.includes(chosen.effort)
				? chosen.effort
				: null;
		onChange(withEffort(next.id, keptEffort));
	};

	const chooseEffort = (level: string) => {
		if (!model) return;
		onChange(
			withEffort(
				model.id,
				model.efforts.find((item) => item === level) ?? null,
			),
		);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="xs"
					role="combobox"
					aria-expanded={open}
					aria-label="Model for this conversation"
					disabled={disabled || catalog.isPending}
				>
					{label}
					<Icon icon={ChevronDownIcon} data-icon="inline-end" />
				</Button>
			</PopoverTrigger>

			<PopoverContent align="start" size="fit" className="w-80">
				<Command>
					<CommandInput placeholder="Search models…" />
					<CommandList>
						<CommandEmpty>No model matches that.</CommandEmpty>
						<CommandGroup>
							<CommandItem
								value="conversation default"
								data-checked={value === null}
								onSelect={() => choose(null)}
							>
								<span>Conversation model</span>
								<span className="ml-auto text-muted-foreground text-xs">
									{workspaceName}
								</span>
							</CommandItem>
						</CommandGroup>
						{byProvider(models).map(([provider, group]) => (
							<CommandGroup key={provider} heading={provider}>
								{group.map((candidate) => (
									<CommandItem
										key={candidate.id}
										value={`${candidate.name} ${candidate.provider} ${candidate.id}`}
										data-checked={chosen?.baseId === candidate.id}
										onSelect={() => choose(candidate)}
									>
										<span>{candidate.name}</span>
										<span className="ml-auto text-muted-foreground text-xs">
											{priceHint(candidate) ??
												contextHint(candidate.contextWindowTokens)}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						))}
					</CommandList>
				</Command>

				{model && model.efforts.length > 0 ? (
					<Field className="border-t p-2">
						<FieldLabel htmlFor={effortId}>Effort</FieldLabel>
						<Select
							value={chosen?.effort ?? FOLLOW_CONVERSATION}
							onValueChange={chooseEffort}
						>
							<SelectTrigger id={effortId} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={FOLLOW_CONVERSATION}>
									Model default
								</SelectItem>
								{model.efforts.map((level) => (
									<SelectItem key={level} value={level}>
										{EFFORT_LABELS[level]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				) : null}
			</PopoverContent>
		</Popover>
	);
}
