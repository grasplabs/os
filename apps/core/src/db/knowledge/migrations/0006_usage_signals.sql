CREATE TABLE `knowledge_signal_computations` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `knowledge_signal_computations_day_idx` ON `knowledge_signal_computations` (`day`);--> statement-breakpoint
CREATE INDEX `knowledge_signal_computations_started_idx` ON `knowledge_signal_computations` (`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `knowledge_signal_dismissals` (
	`kind` text NOT NULL,
	`collection_id` text NOT NULL,
	`subject` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `collection_id`, `subject`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_signals` (
	`computation` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`collection_id` text NOT NULL,
	`subject` text NOT NULL,
	`owner` text NOT NULL,
	`value` integer,
	`evidence` text NOT NULL,
	`evidence_at` integer,
	PRIMARY KEY(`computation`, `id`),
	FOREIGN KEY (`computation`) REFERENCES `knowledge_signal_computations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_signals_subject_idx` ON `knowledge_signals` (`computation`,`collection_id`,`kind`,`subject`);--> statement-breakpoint
CREATE INDEX `knowledge_signals_owner_idx` ON `knowledge_signals` (`computation`,`owner`,`kind`,`value`,`id`);--> statement-breakpoint
CREATE INDEX `documents_updated_at_idx` ON `documents` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `documents_review_date_idx` ON `documents` (`review_date`,`id`) WHERE "documents"."review_date" IS NOT NULL;