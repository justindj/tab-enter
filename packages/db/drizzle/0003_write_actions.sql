ALTER TABLE `jobs` ADD `result` text;--> statement-breakpoint
ALTER TABLE `write_action_log` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `write_action_log` ADD `status` text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE `write_action_log` ADD `result` text;--> statement-breakpoint
ALTER TABLE `write_action_log` ADD `error` text;--> statement-breakpoint
ALTER TABLE `write_action_log` ADD `finished_at` integer;--> statement-breakpoint
CREATE INDEX `writes_profile_created_idx` ON `write_action_log` (`profile_id`,`created_at`);