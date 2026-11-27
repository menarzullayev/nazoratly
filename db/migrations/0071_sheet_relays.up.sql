-- 0071_sheet_relays (up)
-- Why: the Sheets edition. Apps Script cannot receive a Telegram webhook directly (it answers a POST with a redirect),
--   so Telegram posts to this server, which forwards the update to the customer's web app. Each customer's connection is
--   its own record with its own secret. A Sheets customer is not a center of the server product, so these rows have no
--   org_id; the operator adds them (python -m nazoratly.relays).
-- Privacy: only the address and the encrypted secret are kept (column secret_ciphertext: the key is not in the
--   database). Nothing of a forwarded update is stored.
-- The CHECK is the second line of defence: the server forwards to Apps Script web apps only.
-- Queries the indexes serve:
--   Q-sr-1  the relay behind a webhook address  -> sheet_relays_public_id_key

CREATE TABLE sheet_relays (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  label             TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  target_url        TEXT NOT NULL CHECK (target_url ~
    '^https://script\.google\.com/(macros|a/macros/[A-Za-z0-9.-]+)/s/[A-Za-z0-9_-]+/exec$'),
  secret_ciphertext BYTEA NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sheet_relays_public_id_key UNIQUE (public_id)
);
CREATE TRIGGER trg_sheet_relays_updated_at BEFORE UPDATE ON sheet_relays FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON sheet_relays TO nazoratly_app;
