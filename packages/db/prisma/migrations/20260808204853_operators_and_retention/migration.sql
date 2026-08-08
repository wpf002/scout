-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_name_key" ON "Operator"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_tokenHash_key" ON "Operator"("tokenHash");

-- CreateIndex
CREATE INDEX "Operator_active_idx" ON "Operator"("active");

-- CreateIndex
CREATE INDEX "Case_archivedAt_idx" ON "Case"("archivedAt");
