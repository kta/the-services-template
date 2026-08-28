ALTER TABLE `organizations` ADD `version` integer;
--> statement-breakpoint
UPDATE `organizations` SET `version` = 1 WHERE `version` IS NULL;
