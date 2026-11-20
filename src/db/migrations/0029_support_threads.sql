-- 0029: Support — conversation threads, kind, assignee, «waiting for the user» status.
--     A ticket keeps its first message in support_tickets.message; replies (admin and user) go to support_messages.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'problem';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assignee varchar(100);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_reply_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_status_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_status_check
  CHECK(status IN ('open','in_progress','waiting','resolved','closed'));
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_kind_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_kind_check
  CHECK(kind IN ('problem','idea','question'));

CREATE TABLE IF NOT EXISTS support_messages (
  id bigserial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author varchar(100) NOT NULL DEFAULT '',
  from_admin boolean NOT NULL DEFAULT false,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages(ticket_id, created_at);
