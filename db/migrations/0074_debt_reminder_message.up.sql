-- 0074_debt_reminder_message (up)
-- Why: owner decision 43. The Sheets edition completes an approved debt reminder WHEN IT IS SENT: a table of the open
--   charges, the total, a button that copies the payment requisites and an "I have paid" button; a tap on that button
--   is noted on the student and the owner is told. The server queued the approved text only.
--   (1) `pay_info`: the card or account the button copies (Sheets setting "To'lov rekvizitlari"; empty = no button).
--       Center-wide, as in Sheets. 256 characters is all a Telegram copy button holds.
--   (2) staff notification kind `paid_claim`: what the owner is told after a tap.
--   (3) the worker has no table access (0008), so it reads the live facts of a debt reminder it has claimed through a
--       SECURITY DEFINER function. It answers only for a message in status 'sending' that the reminder route queued.
-- Queries the indexes serve: none new (the open charges of one student use charges_org_student).

ALTER TABLE org_settings ADD COLUMN pay_info TEXT CHECK (pay_info IS NULL OR length(pay_info) BETWEEN 1 AND 256);

ALTER TABLE staff_notifications DROP CONSTRAINT staff_notifications_kind_check;
ALTER TABLE staff_notifications ADD CONSTRAINT staff_notifications_kind_check
  CHECK (kind IN ('lesson_unmarked','unmarked_digest','paid_claim'));

-- no row = not a debt reminder; one row with NULL charge columns = a reminder of a student who owes nothing any more
CREATE FUNCTION outbox_reminder_facts(p_message_id bigint)
RETURNS TABLE (student_public_id uuid, pay_info text, period_month date, due_date date, outstanding numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.public_id, os.pay_info, b.period_month, b.due_date, b.outstanding
  FROM outbox_messages o
  JOIN students s ON s.org_id = o.org_id AND s.id = o.student_id
  LEFT JOIN org_settings os ON os.org_id = o.org_id
  LEFT JOIN v_charge_balance b ON b.org_id = o.org_id AND b.student_id = o.student_id AND b.outstanding > 0
  WHERE o.id = p_message_id AND o.status = 'sending' AND o.channel = 'telegram'
    AND starts_with(o.idempotency_key, 'debt-reminder-')
  ORDER BY b.due_date, b.charge_id
$$;
REVOKE ALL ON FUNCTION outbox_reminder_facts(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_reminder_facts(bigint) TO nazoratly_worker;
