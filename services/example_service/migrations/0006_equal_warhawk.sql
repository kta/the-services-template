PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`plan` text,
	`is_disabled` text,
	`version` integer NOT NULL,
	`synced_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_organizations`("id", "name", "plan", "is_disabled", "version", "synced_at", "created_at") SELECT "id", "name", "plan", "is_disabled", "version", "synced_at", "created_at" FROM `organizations`;--> statement-breakpoint
DROP TABLE `organizations`;--> statement-breakpoint
ALTER TABLE `__new_organizations` RENAME TO `organizations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
