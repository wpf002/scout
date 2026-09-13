-- Encrypted biometric templates. The media they came from is never stored.
CREATE TABLE "BiometricTemplate" (
    "id" TEXT NOT NULL,
    "galleryId" TEXT NOT NULL,
    "modality" "Modality" NOT NULL,
    "dims" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "keyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiometricTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BiometricTemplate_galleryId_modality_idx" ON "BiometricTemplate"("galleryId", "modality");
