-- AlterTable
ALTER TABLE "Monitor" ADD COLUMN     "area" JSONB,
ADD COLUMN     "layerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
