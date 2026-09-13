-- The tile index row is the access record, so it is per authorization. The
-- stored bytes stay shared: a second authorization over the same scene and
-- box gets its own row without a second download.
DROP INDEX "ImageryTile_sourceId_sceneId_bboxHash_key";
CREATE UNIQUE INDEX "ImageryTile_sourceId_sceneId_bboxHash_authorizationId_key" ON "ImageryTile"("sourceId", "sceneId", "bboxHash", "authorizationId");
