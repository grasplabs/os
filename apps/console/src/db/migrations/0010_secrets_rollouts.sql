ALTER TABLE `client_deploys` ADD `kind` text DEFAULT 'release' NOT NULL;--> statement-breakpoint
ALTER TABLE `rollouts` ADD `shared_secrets` text;