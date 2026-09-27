CREATE TABLE `platform_version` (
	`id` integer PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "platform_version_one_row" CHECK("platform_version"."id" = 1)
);
