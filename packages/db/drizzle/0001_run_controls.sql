ALTER TABLE `agent_runs` ADD `cancel_requested` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `branch` text;