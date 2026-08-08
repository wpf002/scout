/**
 * Operator management CLI.
 *
 * Tokens are shown once, at creation. Only the SHA-256 digest is stored, so a
 * lost token is reissued rather than recovered — which is the property you
 * want from a credential that attributes entries in an audit log.
 *
 *   pnpm db:operator add "alice"        # mint a token
 *   pnpm db:operator list
 *   pnpm db:operator disable "alice"
 *   pnpm db:operator enable "alice"
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const mintToken = (): string => `scout_${randomBytes(32).toString("hex")}`;

async function main(): Promise<void> {
  const [command, name] = process.argv.slice(2);

  switch (command) {
    case "add": {
      if (name === undefined || name.trim().length === 0) {
        throw new Error('Usage: pnpm db:operator add "<name>"');
      }
      const token = mintToken();
      const operator = await prisma.operator.create({
        data: { name: name.trim(), tokenHash: hashToken(token) },
      });
      console.log(`\nOperator created: ${operator.name}\n`);
      console.log(`  ${token}\n`);
      console.log("This token is shown once and is not recoverable.");
      console.log("Send it with:  Authorization: Bearer <token>\n");
      break;
    }

    case "list": {
      const operators = await prisma.operator.findMany({
        orderBy: { createdAt: "asc" },
      });
      if (operators.length === 0) {
        console.log("No operators. Auth will reject every request when");
        console.log("SCOUT_AUTH_REQUIRED=true — add one first.");
        break;
      }
      for (const operator of operators) {
        const seen =
          operator.lastSeenAt === null
            ? "never used"
            : `last seen ${operator.lastSeenAt.toISOString()}`;
        console.log(
          `${operator.active ? "active  " : "disabled"}  ${operator.name}  (${seen})`,
        );
      }
      break;
    }

    case "disable":
    case "enable": {
      if (name === undefined) {
        throw new Error(`Usage: pnpm db:operator ${command} "<name>"`);
      }
      const updated = await prisma.operator.update({
        where: { name: name.trim() },
        data: { active: command === "enable" },
      });
      console.log(`${updated.name} is now ${updated.active ? "active" : "disabled"}.`);
      break;
    }

    default:
      console.log("Usage: pnpm db:operator <add|list|enable|disable> [name]");
      process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
