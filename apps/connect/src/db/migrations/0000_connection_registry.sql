CREATE TABLE `audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`scope` text NOT NULL,
	`owner_user_id` text,
	`status` text NOT NULL,
	`server_kind` text NOT NULL,
	`server` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "connections_owner_check" CHECK(("connections"."scope" = 'personal') = ("connections"."owner_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `idempotent_calls` (
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`on_behalf_of` text NOT NULL,
	`connection_id` text NOT NULL,
	`action` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`state` text NOT NULL,
	`output` text,
	`provenance` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`subject_type`, `subject_id`, `on_behalf_of`, `connection_id`, `action`, `idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `idempotent_calls_created_idx` ON `idempotent_calls` (`created_at`);