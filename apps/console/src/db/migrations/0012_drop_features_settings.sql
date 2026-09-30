-- Feature flags are gone: a stored FEATURES setting would fail every deploy (unknown_setting), and nothing clears it.
DELETE FROM `settings` WHERE `key` = 'FEATURES';
