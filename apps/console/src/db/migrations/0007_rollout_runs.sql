ALTER TABLE `client_runs` ADD `kind` text DEFAULT 'provision' NOT NULL;--> statement-breakpoint
ALTER TABLE `rollout_targets` ADD `deploy_id` text;--> statement-breakpoint
ALTER TABLE `rollout_targets` ADD `previous` text;--> statement-breakpoint
CREATE INDEX `clients_status_ring_idx` ON `clients` (`status`,`ring`);