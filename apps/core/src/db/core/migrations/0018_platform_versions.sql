-- Every version of core the cron has recorded (src/platform-updates.ts).
-- It replaces `platform_version`, which held only the last one, so
-- isolates of two versions alternating during a gradual rollout recorded
-- both again and again. `platform_version` stays until a later release
-- drops it.
CREATE TABLE `platform_versions` (
	`version_id` text PRIMARY KEY NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
-- The version the old job recorded last, so the version running when this
-- migration runs isn't recorded a second time.
INSERT INTO `platform_versions` (`version_id`, `recorded_at`)
SELECT `version_id`, `recorded_at` FROM `platform_version`;
