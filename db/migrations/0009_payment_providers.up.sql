-- 0009_payment_providers (up)
-- Why: online payments (Payme, Click). Each CENTER is the merchant: it has its own provider account (merchant id +
--   secret key, stored ENCRYPTED by the application with a key that is not in the database) and its own callback URL.
--   online_transactions is the provider-side ledger (states follow Payme: 1 created, 2 performed, -1 cancelled,
--   -2 cancelled after perform; Click uses 1/2/-1). A performed transaction owns exactly one payments row
--   (method payme/click, external_ref = provider transaction id), so debt/allocation logic is unchanged.
-- Queries supported:
--   Q-onl-1  find a transaction by provider id                 -> online_transactions_provider_key
--   Q-onl-2  Payme GetStatement: transactions by creation time -> online_transactions_org_created
--   Q-onl-3  credentials of a center for a callback            -> payment_provider_accounts_provider_key
-- audit_row() is replaced to also strip secret_ciphertext from audit snapshots.

CREATE TABLE payment_provider_accounts (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  provider          TEXT NOT NULL CHECK (provider IN ('payme', 'click')),
  merchant_ref      TEXT NOT NULL CHECK (length(btrim(merchant_ref)) > 0),   -- Payme merchant id / Click service_id
  secret_ciphertext BYTEA NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Q-onl-3 (also the FK index on org_id)
CREATE UNIQUE INDEX payment_provider_accounts_provider_key ON payment_provider_accounts (org_id, provider);
CREATE TRIGGER trg_payment_provider_accounts_updated_at BEFORE UPDATE ON payment_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE online_transactions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL,
  public_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  provider          TEXT NOT NULL CHECK (provider IN ('payme', 'click')),
  provider_trans_id TEXT NOT NULL CHECK (length(btrim(provider_trans_id)) > 0),
  student_id        BIGINT NOT NULL,
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  state             SMALLINT NOT NULL CHECK (state IN (1, 2, -1, -2)),
  reason            SMALLINT,
  payment_id        BIGINT,
  provider_time     TIMESTAMPTZ,
  performed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  provider_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT online_transactions_org_fk     FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT online_transactions_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT online_transactions_payment_fk FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT online_transactions_public_id_key UNIQUE (public_id),
  CONSTRAINT online_transactions_org_id_key UNIQUE (org_id, id),
  CONSTRAINT online_transactions_state_shape CHECK (
    (state = 1  AND performed_at IS NULL AND cancelled_at IS NULL) OR
    (state = 2  AND performed_at IS NOT NULL AND payment_id IS NOT NULL AND cancelled_at IS NULL) OR
    (state = -1 AND cancelled_at IS NOT NULL AND performed_at IS NULL) OR
    (state = -2 AND cancelled_at IS NOT NULL AND performed_at IS NOT NULL))
);
-- Q-onl-1
CREATE UNIQUE INDEX online_transactions_provider_key ON online_transactions (org_id, provider, provider_trans_id);
-- Q-onl-2
CREATE INDEX online_transactions_org_created ON online_transactions (org_id, provider, created_at);
-- FK lookups
CREATE INDEX online_transactions_student ON online_transactions (org_id, student_id);
CREATE INDEX online_transactions_payment ON online_transactions (org_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE TRIGGER trg_online_transactions_updated_at BEFORE UPDATE ON online_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE payment_provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_provider_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_provider_accounts FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
CREATE POLICY auth_read ON payment_provider_accounts FOR SELECT TO nazoratly_auth USING (true);
ALTER TABLE online_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON online_transactions FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON payment_provider_accounts, online_transactions TO nazoratly_app;
GRANT SELECT ON payment_provider_accounts TO nazoratly_auth;

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  new_rec JSONB;
  old_rec JSONB;
  v_org   BIGINT;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN old_rec := to_jsonb(OLD) - 'token_hash' - 'password_hash' - 'secret_ciphertext'; END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN new_rec := to_jsonb(NEW) - 'token_hash' - 'password_hash' - 'secret_ciphertext'; END IF;
  IF TG_OP = 'UPDATE' AND new_rec = old_rec THEN RETURN NULL; END IF;
  v_org := COALESCE((new_rec->>'org_id')::bigint, (old_rec->>'org_id')::bigint);
  INSERT INTO audit_log (org_id, actor_type, actor_user_id, agent_client_id, action, entity_type, entity_id,
                         before_data, after_data, request_id)
  VALUES (v_org, app_actor_type(), app_user_id(), app_agent_client_id(), lower(TG_OP), TG_TABLE_NAME,
          COALESCE((new_rec->>'id')::bigint, (old_rec->>'id')::bigint), old_rec, new_rec,
          NULLIF(current_setting('app.request_id', true), ''));
  RETURN NULL;
END $$;

CREATE TRIGGER trg_payment_provider_accounts_audit AFTER INSERT OR UPDATE OR DELETE ON payment_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_online_transactions_audit AFTER INSERT OR UPDATE OR DELETE ON online_transactions
  FOR EACH ROW EXECUTE FUNCTION audit_row();
