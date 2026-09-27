CREATE TABLE `hidden_connectors` (
	`source` text NOT NULL,
	`connector_id` text NOT NULL,
	`hidden_by` text NOT NULL,
	`hidden_at` integer NOT NULL,
	PRIMARY KEY(`source`, `connector_id`)
);
