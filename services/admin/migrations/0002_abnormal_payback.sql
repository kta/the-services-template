CREATE TABLE `login_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`expires_at` text NOT NULL
);
