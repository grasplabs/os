DROP TABLE `app_blueprints`;
--> statement-breakpoint
DELETE FROM `permissions` WHERE `subject_type` = 'app' AND `subject_id` IN (SELECT `id` FROM `apps` WHERE `owner_id` = 'grasp');
--> statement-breakpoint
DELETE FROM `app_versions` WHERE `app_id` IN (SELECT `id` FROM `apps` WHERE `owner_id` = 'grasp');
--> statement-breakpoint
DELETE FROM `apps` WHERE `owner_id` = 'grasp';
