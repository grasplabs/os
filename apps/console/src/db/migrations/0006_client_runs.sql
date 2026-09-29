CREATE TABLE `client_runs` (
	`client_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`claimed_at` integer NOT NULL
);
