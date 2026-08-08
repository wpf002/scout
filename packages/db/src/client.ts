import { PrismaClient } from "@prisma/client";

declare global {
  // Reused across dev-server reloads so we don't leak connection pools.
  // eslint-disable-next-line no-var
  var __scoutPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__scoutPrisma ??
  new PrismaClient({
    log:
      process.env["NODE_ENV"] === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env["NODE_ENV"] !== "production") {
  globalThis.__scoutPrisma = prisma;
}

export type { PrismaClient };
export * from "@prisma/client";
