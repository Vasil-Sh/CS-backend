CREATE TABLE IF NOT EXISTS admin_user_notes (
 user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 content text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 updated_by varchar(200) NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
