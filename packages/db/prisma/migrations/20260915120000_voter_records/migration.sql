-- Voter registration records, imported from a file the operator obtained.
-- Written by hand: migrate dev wants to reset this database to build a shadow
-- copy, and it holds real case and audit history.
CREATE TABLE "VoterRecord" (
    "id"         TEXT NOT NULL,
    "state"      TEXT NOT NULL,
    "voterId"    TEXT,
    "lastName"   TEXT NOT NULL,
    "firstName"  TEXT,
    "middleName" TEXT,
    "suffix"     TEXT,
    "birthDate"  TIMESTAMP(3),
    "birthYear"  INTEGER,
    "street"     TEXT,
    "city"       TEXT,
    "zip"        TEXT,
    "county"     TEXT,
    "party"      TEXT,
    "status"     TEXT,
    "phone"      TEXT,
    "sourceFile" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoterRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VoterRecord_lastName_firstName_idx" ON "VoterRecord"("lastName", "firstName");
CREATE INDEX "VoterRecord_state_lastName_idx" ON "VoterRecord"("state", "lastName");
CREATE INDEX "VoterRecord_birthDate_idx" ON "VoterRecord"("birthDate");
CREATE INDEX "VoterRecord_zip_idx" ON "VoterRecord"("zip");
