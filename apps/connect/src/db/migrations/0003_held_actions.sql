CREATE TABLE `pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`on_behalf_of` text NOT NULL,
	`mode` text NOT NULL,
	`app_version` integer,
	`connection_id` text NOT NULL,
	`account_id` text,
	`resource` text,
	`action` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`input` text NOT NULL,
	`input_hash` text NOT NULL,
	`permission_id` text NOT NULL,
	`context` text NOT NULL,
	`restricted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_actions_call_idx` ON `pending_actions` (`subject_type`,`subject_id`,`on_behalf_of`,`connection_id`,`action`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `pending_actions_person_idx` ON `pending_actions` (`on_behalf_of`);--> statement-breakpoint
CREATE INDEX `pending_actions_connection_idx` ON `pending_actions` (`connection_id`);