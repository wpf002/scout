-- The FAA civil aircraft registry, held locally.
--
-- Written by hand rather than generated: `migrate dev` wants to reset this
-- database to build a shadow copy, and it holds real case and audit history.
CREATE TABLE "AircraftRegistration" (
    "nNumber"      TEXT NOT NULL,
    "serialNumber" TEXT,
    "modeSHex"     TEXT,
    "yearMfr"      INTEGER,
    "ownerName"    TEXT NOT NULL,
    "ownerType"    TEXT,
    "street"       TEXT,
    "city"         TEXT,
    "state"        TEXT,
    "zip"          TEXT,
    "county"       TEXT,
    "country"      TEXT,
    "aircraft"     TEXT,
    "statusCode"   TEXT,
    "certIssued"   TIMESTAMP(3),
    "lastAction"   TIMESTAMP(3),
    "syncedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AircraftRegistration_pkey" PRIMARY KEY ("nNumber")
);

-- The ADS-B join. Every live aircraft carries this address.
CREATE INDEX "AircraftRegistration_modeSHex_idx" ON "AircraftRegistration"("modeSHex");
CREATE INDEX "AircraftRegistration_ownerName_idx" ON "AircraftRegistration"("ownerName");
CREATE INDEX "AircraftRegistration_state_city_idx" ON "AircraftRegistration"("state", "city");
