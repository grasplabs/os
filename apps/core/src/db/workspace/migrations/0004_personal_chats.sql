CREATE TABLE `audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `agent_id` text;--> statement-breakpoint
CREATE INDEX `chats_person` ON `chats` (`person_id`,`created_at`);