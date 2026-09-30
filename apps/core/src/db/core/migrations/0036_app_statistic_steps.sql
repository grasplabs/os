CREATE TABLE `app_statistic_steps` (
	`step_key` text NOT NULL,
	`attempt` text NOT NULL,
	`app_id` text NOT NULL,
	`measure` text NOT NULL,
	`day` text NOT NULL,
	`dimensions` text NOT NULL,
	`count` integer NOT NULL,
	`sum` real NOT NULL,
	`min` real NOT NULL,
	`max` real NOT NULL,
	`committed` integer NOT NULL,
	PRIMARY KEY(`step_key`, `attempt`, `app_id`, `measure`, `day`, `dimensions`)
);
