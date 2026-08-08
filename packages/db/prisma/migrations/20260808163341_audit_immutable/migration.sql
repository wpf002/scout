-- Audit rows are append-only, enforced by the database.
--
-- "Immutable" as an application convention is worth very little: the next
-- refactor, a stray prisma.queryLog.update(), or anyone with the connection
-- string can rewrite the record that is supposed to make this tool
-- defensible. Enforcing it here means the guarantee survives the application.
--
-- Consequence, accepted deliberately: a Case with audit rows cannot be
-- hard-deleted, because the cascade would have to delete them. There is no
-- delete-case route in the API for exactly this reason. Retention and
-- soft-delete are Phase 8, and will archive rather than erase.

CREATE OR REPLACE FUNCTION scout_reject_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit rows are immutable: % on "%" is not permitted',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "QueryLog_no_update"
  BEFORE UPDATE ON "QueryLog"
  FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();

CREATE TRIGGER "QueryLog_no_delete"
  BEFORE DELETE ON "QueryLog"
  FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();

CREATE TRIGGER "AuditEvent_no_update"
  BEFORE UPDATE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();

CREATE TRIGGER "AuditEvent_no_delete"
  BEFORE DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
