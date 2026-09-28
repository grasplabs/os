ALTER TABLE `client_deploys` ADD `versions` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `rotated_at` integer;--> statement-breakpoint
ALTER TABLE `clients` ADD `rotation_live_at` integer;