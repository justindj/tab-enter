CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`agent` text DEFAULT 'claude-code' NOT NULL,
	`issue_key` text,
	`mr_key` text,
	`preset` text NOT NULL,
	`prompt` text NOT NULL,
	`session_id` text,
	`parent_run_id` text,
	`status` text NOT NULL,
	`cwd` text,
	`model_requested` text NOT NULL,
	`model_used` text,
	`exit_code` integer,
	`error` text,
	`diff_summary` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_creation_tokens` integer,
	`cost_usd` real,
	`num_turns` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `runs_profile_created_idx` ON `agent_runs` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_issue_idx` ON `agent_runs` (`profile_id`,`issue_key`);--> statement-breakpoint
CREATE TABLE `app_state` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `code_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`mr_key` text NOT NULL,
	`reviewed_sha` text NOT NULL,
	`run_id` text,
	`result` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reviews_mr_idx` ON `code_reviews` (`profile_id`,`mr_key`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`key` text NOT NULL,
	`status_category` text NOT NULL,
	`in_open_sprint` integer NOT NULL,
	`rank` text,
	`data` text NOT NULL,
	`assigned_to_me` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_profile_key_uq` ON `issues` (`profile_id`,`key`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`locked_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `manual_links` (
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`mr_key` text NOT NULL,
	`issue_key` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`profile_id`, `mr_key`, `issue_key`)
);
--> statement-breakpoint
CREATE TABLE `merge_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`mr_key` text NOT NULL,
	`state` text NOT NULL,
	`is_mine` integer NOT NULL,
	`is_reviewer` integer NOT NULL,
	`needs_my_review` integer DEFAULT false NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	`merged_at` integer,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mrs_profile_key_uq` ON `merge_requests` (`profile_id`,`mr_key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`format` text NOT NULL,
	`body` text NOT NULL,
	`window_start` integer,
	`window_end` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_profile_created_idx` ON `messages` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mr_issue_links` (
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`mr_key` text NOT NULL,
	`issue_key` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`profile_id`, `mr_key`, `issue_key`)
);
--> statement-breakpoint
CREATE INDEX `links_issue_idx` ON `mr_issue_links` (`profile_id`,`issue_key`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`settings` text NOT NULL,
	`secret_names` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profiles_user_idx` ON `profiles` (`user_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`profile_id` text NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`source` text NOT NULL,
	`last_synced_at` integer,
	`last_attempt_at` integer,
	`last_error` text,
	`cursor` text,
	PRIMARY KEY(`profile_id`, `source`)
);
--> statement-breakpoint
CREATE TABLE `tool_status` (
	`user_id` text NOT NULL,
	`tool` text NOT NULL,
	`status` text NOT NULL,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `tool`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`issue_key` text NOT NULL,
	`mr_key` text,
	`status` text NOT NULL,
	`blob_key` text,
	`script_blob_key` text,
	`criteria` text,
	`summary` text,
	`run_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verif_issue_idx` ON `verification_artifacts` (`profile_id`,`issue_key`);--> statement-breakpoint
CREATE TABLE `write_action_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL
);
