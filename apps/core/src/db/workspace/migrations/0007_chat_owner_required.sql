-- Every chat has its person and its agent: `createChat` sets both. Chats
-- made before that have neither and nobody could reach them, so they go,
-- with what refers to them.
--
-- SQLite makes a column NOT NULL only by making its table again. Durable
-- Objects ignore `PRAGMA foreign_keys = OFF`, so the checks are deferred
-- to the commit instead, and `chats` is made again under its own name:
-- dropping it counts the rows that refer to it as violations, and each
-- chat inserted again settles those of its rows. Renaming a new table to
-- `chats`, as drizzle-kit generates, would settle none, and the commit
-- would fail.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
DELETE FROM `chat_draft_files` WHERE `chat_id` IN (SELECT `id` FROM `chats` WHERE `person_id` IS NULL OR `agent_id` IS NULL);--> statement-breakpoint
DELETE FROM `chat_drafts` WHERE `chat_id` IN (SELECT `id` FROM `chats` WHERE `person_id` IS NULL OR `agent_id` IS NULL);--> statement-breakpoint
DELETE FROM `chat_attachments` WHERE `chat_id` IN (SELECT `id` FROM `chats` WHERE `person_id` IS NULL OR `agent_id` IS NULL);--> statement-breakpoint
DELETE FROM `chat_sources` WHERE `chat_id` IN (SELECT `id` FROM `chats` WHERE `person_id` IS NULL OR `agent_id` IS NULL);--> statement-breakpoint
DELETE FROM `chat_messages` WHERE `chat_id` IN (SELECT `id` FROM `chats` WHERE `person_id` IS NULL OR `agent_id` IS NULL);--> statement-breakpoint
DELETE FROM `chats` WHERE `person_id` IS NULL OR `agent_id` IS NULL;--> statement-breakpoint
CREATE TABLE `__old_chats` AS SELECT * FROM `chats`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`restricted` integer DEFAULT false NOT NULL,
	`person_id` text NOT NULL,
	`agent_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `chats`("id", "title", "created_at", "restricted", "person_id", "agent_id") SELECT "id", "title", "created_at", "restricted", "person_id", "agent_id" FROM `__old_chats`;--> statement-breakpoint
DROP TABLE `__old_chats`;--> statement-breakpoint
CREATE INDEX `chats_person` ON `chats` (`person_id`,`created_at`);
