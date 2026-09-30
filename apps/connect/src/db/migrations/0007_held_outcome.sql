ALTER TABLE `idempotent_calls` ADD `resource` text;--> statement-breakpoint
CREATE INDEX `idempotent_calls_key_idx` ON `idempotent_calls` (`idempotency_key`);