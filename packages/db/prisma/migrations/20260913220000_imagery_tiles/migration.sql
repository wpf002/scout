-- The imagery tile index: one row per stored scene-over-box, with a PostGIS
-- polygon for spatial lookup. The bytes are in object storage.
CREATE TABLE "ImageryTile" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "sceneId" TEXT NOT NULL,
    "sensedAt" TIMESTAMP(3) NOT NULL,
    "cloudCoverPct" INTEGER,
    "bbox" DOUBLE PRECISION[],
    "bboxHash" TEXT NOT NULL,
    "geom" geography(Polygon,4326),
    "objectKey" TEXT NOT NULL,
    "previewKey" TEXT,
    "bytes" INTEGER NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "resolutionM" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "cloudOptimized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageryTile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImageryTile_sourceId_sceneId_bboxHash_key" ON "ImageryTile"("sourceId", "sceneId", "bboxHash");
CREATE INDEX "ImageryTile_authorizationId_sensedAt_idx" ON "ImageryTile"("authorizationId", "sensedAt");
CREATE INDEX "ImageryTile_geom_idx" ON "ImageryTile" USING GIST ("geom");
