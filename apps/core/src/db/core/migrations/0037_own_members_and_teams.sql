-- Members and teams become core's own tables, without the organization they
-- pointed at. Ordered by hand: D1 always enforces foreign keys, and dropping
-- a table deletes its rows first, which cascades. So every table that
-- references `organizations` is rebuilt before it is dropped, and
-- `team_members` is copied (onto the new `teams`) before the old `teams`
-- goes. Renaming `__new_teams` also renames it in the new `team_members`.
CREATE TABLE `__new_member_removals` (
	`user_id` text PRIMARY KEY NOT NULL,
	`removed_at` integer NOT NULL,
	`disconnected_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_member_removals`("user_id", "removed_at", "disconnected_at") SELECT "user_id", "removed_at", "disconnected_at" FROM `member_removals`;--> statement-breakpoint
DROP TABLE `member_removals`;--> statement-breakpoint
ALTER TABLE `__new_member_removals` RENAME TO `member_removals`;--> statement-breakpoint
CREATE TABLE `__new_members` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_members`("id", "user_id", "role", "created_at") SELECT "id", "user_id", "role", "created_at" FROM `members`;--> statement-breakpoint
DROP TABLE `members`;--> statement-breakpoint
ALTER TABLE `__new_members` RENAME TO `members`;--> statement-breakpoint
CREATE UNIQUE INDEX `members_user_id_unique` ON `members` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "name", "created_at") SELECT "id", "name", "created_at" FROM `teams`;--> statement-breakpoint
CREATE TABLE `__new_team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `__new_teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `__new_team_members`("team_id", "user_id", "created_at") SELECT "team_id", "user_id", coalesce("created_at", 0) FROM `team_members`;--> statement-breakpoint
DROP TABLE `team_members`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
ALTER TABLE `__new_team_members` RENAME TO `team_members`;--> statement-breakpoint
CREATE INDEX `team_members_user_id_idx` ON `team_members` (`user_id`);--> statement-breakpoint
DROP TABLE `invitations`;--> statement-breakpoint
DROP TABLE `organizations`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `active_organization_id`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `active_team_id`;
