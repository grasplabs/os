CREATE TABLE `app_statistics` (
	`app_id` text NOT NULL,
	`measure` text NOT NULL,
	`day` text NOT NULL,
	`dimensions` text NOT NULL,
	`count` integer NOT NULL,
	`sum` real NOT NULL,
	`min` real NOT NULL,
	`max` real NOT NULL,
	PRIMARY KEY(`app_id`, `measure`, `day`, `dimensions`)
);
--> statement-breakpoint
CREATE INDEX `app_statistics_app_day_idx` ON `app_statistics` (`app_id`,`day`);--> statement-breakpoint
CREATE INDEX `app_statistics_day_idx` ON `app_statistics` (`day`);