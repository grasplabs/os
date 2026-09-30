DROP INDEX `permissions_live_binding_idx`;--> statement-breakpoint
ALTER TABLE `permissions` ADD `chat_id` text;--> statement-breakpoint
ALTER TABLE `permissions` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `permissions` ADD `personal` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_live_chat_binding_idx` ON `permissions` (`chat_id`,`subject_type`,`subject_id`,`binding`) WHERE status <> 'revoked' AND chat_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_live_binding_idx` ON `permissions` (`subject_type`,`subject_id`,`binding`) WHERE status <> 'revoked' AND chat_id IS NULL;