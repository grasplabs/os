CREATE TABLE `model_budget_alerts` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`period` text NOT NULL,
	`kind` text NOT NULL,
	`threshold_micros` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`, `period`, `kind`, `threshold_micros`)
);
--> statement-breakpoint
CREATE TABLE `model_spend` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`period` text NOT NULL,
	`spent_micros` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`, `period`)
);
