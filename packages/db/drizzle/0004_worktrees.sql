CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`path` text NOT NULL,
	`clone_path` text NOT NULL,
	`branch` text,
	`mr_key` text,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`uncommitted` integer DEFAULT 0 NOT NULL,
	`unpushed` text NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_profile_path_idx` ON `worktrees` (`profile_id`,`path`);--> statement-breakpoint
ALTER TABLE `sync_state` ADD `token_expires_at` text;