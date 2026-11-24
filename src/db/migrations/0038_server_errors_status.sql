-- 0038: HTTP status the client got for an API error (null for console/process entries).
ALTER TABLE server_errors ADD COLUMN IF NOT EXISTS status smallint;
