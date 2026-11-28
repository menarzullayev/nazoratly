-- 0072_password_reset (up)
-- Why: password reset (readiness ledger B07). An operator issues a one-time, short-lived link from the server command
--   line (python -m nazoratly.password_reset); no HTTP route creates one. Only the SHA-256 of the code is stored. Rows
--   are never deleted: together they are the record of who was given a link and when it was used.
--   Users are global (no org_id), so only the auth identity may touch this table.
-- Queries the indexes serve:
--   Q-pr-1  the code behind a reset request        -> password_reset_codes_hash_key
--   Q-pr-2  the live code of a user (superseding)  -> password_reset_codes_one_live

CREATE TABLE password_reset_codes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash   BYTEA NOT NULL CHECK (octet_length(code_hash) = 32),
  issued_by   TEXT NOT NULL CHECK (length(btrim(issued_by)) BETWEEN 1 AND 100),   -- the operator, as typed
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,                                                         -- superseded by a newer link
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_codes_hash_key UNIQUE (code_hash)
);
CREATE UNIQUE INDEX password_reset_codes_one_live ON password_reset_codes (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON password_reset_codes TO nazoratly_auth;
