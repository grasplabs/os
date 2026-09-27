CREATE TABLE `app_members` (
	`app_id` text NOT NULL,
	`member_type` text NOT NULL,
	`member_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `member_type`, `member_id`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_members_member_idx` ON `app_members` (`member_type`,`member_id`);--> statement-breakpoint
ALTER TABLE `apps` ADD `screens_restart_due` integer;