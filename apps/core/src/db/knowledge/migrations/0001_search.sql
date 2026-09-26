-- The full-text index over sections (src/knowledge/search.ts). Two FTS5
-- tables with the same rows: whole words, with diacritics removed and
-- prefixes indexed, and trigrams, which find a word inside a compound
-- ("verlof" in "zwangerschapsverlof") and survive a typo. Each row is one
-- section, with its document's title and description, so a query can match
-- a title in one field and a section's text in another.
--
-- The index follows the sections table through triggers, inside whatever
-- statement changes it: a save's batch, a restore, a cascade. A save
-- replaces all of a document's sections, so a new title or description
-- reaches every row of the document with them.
--
-- FTS5 rows are found by rowid. Sections have no stable one (a table
-- without an INTEGER PRIMARY KEY may get new rowids on VACUUM), so
-- `search_rows` gives each section its own.
CREATE TABLE `search_rows` (
	`id` integer PRIMARY KEY,
	`document_id` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_rows_section_idx` ON `search_rows` (`document_id`, `position`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_words` USING fts5(
	title, description, headings, text,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_trigrams` USING fts5(
	title, description, headings, text,
	tokenize = 'trigram remove_diacritics 1'
);
--> statement-breakpoint
INSERT INTO `search_rows` (`document_id`, `position`)
SELECT `document_id`, `position` FROM `sections`;
--> statement-breakpoint
INSERT INTO `search_words` (rowid, title, description, headings, text)
SELECT r.`id`, d.`title`, d.`description`,
	(SELECT group_concat(value, ' ') FROM json_each(s.`headings`)), s.`text`
FROM `search_rows` r
JOIN `sections` s ON s.`document_id` = r.`document_id` AND s.`position` = r.`position`
JOIN `documents` d ON d.`id` = r.`document_id`;
--> statement-breakpoint
INSERT INTO `search_trigrams` (rowid, title, description, headings, text)
SELECT rowid, title, description, headings, text FROM `search_words`;
--> statement-breakpoint
CREATE TRIGGER `sections_search_insert` AFTER INSERT ON `sections` BEGIN
	INSERT INTO `search_rows` (`document_id`, `position`)
	VALUES (new.`document_id`, new.`position`);
	INSERT INTO `search_words` (rowid, title, description, headings, text)
	SELECT r.`id`, d.`title`, d.`description`,
		(SELECT group_concat(value, ' ') FROM json_each(new.`headings`)), new.`text`
	FROM `search_rows` r
	JOIN `documents` d ON d.`id` = r.`document_id`
	WHERE r.`document_id` = new.`document_id` AND r.`position` = new.`position`;
	INSERT INTO `search_trigrams` (rowid, title, description, headings, text)
	SELECT w.rowid, w.title, w.description, w.headings, w.text
	FROM `search_words` w
	WHERE w.rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = new.`document_id` AND `position` = new.`position`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `sections_search_delete` AFTER DELETE ON `sections` BEGIN
	DELETE FROM `search_words` WHERE rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = old.`document_id` AND `position` = old.`position`
	);
	DELETE FROM `search_trigrams` WHERE rowid = (
		SELECT `id` FROM `search_rows`
		WHERE `document_id` = old.`document_id` AND `position` = old.`position`
	);
	DELETE FROM `search_rows`
	WHERE `document_id` = old.`document_id` AND `position` = old.`position`;
END;
--> statement-breakpoint
-- Sections are replaced, never changed in place: a change that bypassed the
-- triggers above would leave the index behind.
CREATE TRIGGER `sections_search_update` BEFORE UPDATE ON `sections` BEGIN
	SELECT RAISE(ABORT, 'sections are replaced, never updated');
END;
