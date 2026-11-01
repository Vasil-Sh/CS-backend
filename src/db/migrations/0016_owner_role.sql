-- 0016: Owner flag. Owners are admins who may also delete/demote admins,
-- reset admins' passwords and appoint other owners.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false;

-- Initial owner, chosen by the project owner.
UPDATE users SET is_owner = true, role = 'admin' WHERE username = 'super_gus23_7482';

-- Safety net: if that account does not exist, make the earliest admin an owner
-- so owner-only actions stay possible.
UPDATE users SET is_owner = true
WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner);
