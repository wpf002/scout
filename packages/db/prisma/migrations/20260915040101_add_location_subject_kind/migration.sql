-- AlterEnum
ALTER TYPE "SubjectKind" ADD VALUE 'LOCATION';

-- Prisma proposed dropping the two PostGIS spatial indexes here. It does not
-- model GiST indexes on geometry columns, so every migration generated against
-- this schema "discovers" them as drift and removes them. They are recreated
-- below so the drop and the recreate land in the same transaction and the
-- indexes survive. Without them the map's bbox queries fall back to sequential
-- scans over every observation.
DROP INDEX IF EXISTS "ImageryTile_geom_idx";
DROP INDEX IF EXISTS "Observation_geom_idx";
CREATE INDEX "Observation_geom_idx" ON "Observation" USING GIST ("geom");
CREATE INDEX "ImageryTile_geom_idx" ON "ImageryTile" USING GIST ("geom");
