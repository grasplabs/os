CREATE TABLE `model_spend` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`period` text NOT NULL,
	`spent_micros` integer NOT NULL,
	`exhausted_at_micros` integer,
	`alerted_at_micros` integer,
	PRIMARY KEY(`scope`, `key`, `period`)
);
