/**
 * Seeds one demonstration case.
 *
 * Everything here uses RFC 2606 reserved names (`example.com`, `example.org`)
 * so the seed can never point a scoped source at a real person or a real
 * domain. Do not replace these with live values.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const existing = await prisma.case.findFirst({
    where: { authorizationRef: "DEMO-ENGAGEMENT-0001" },
  });
  if (existing !== null) {
    console.log(`Seed case already present: ${existing.id}`);
    return;
  }

  const demo = await prisma.case.create({
    data: {
      name: "Demo engagement — example.com",
      authorizationRef: "DEMO-ENGAGEMENT-0001",
      notes:
        "Seeded demonstration case. Scope uses RFC 2606 reserved names only.",
      createdBy: "seed",
      scopeEntries: {
        create: [
          {
            kind: "DOMAIN",
            value: "example.com",
            note: "Primary authorized domain (and its subdomains).",
            addedBy: "seed",
          },
          {
            kind: "IDENTIFIER",
            value: "alice@example.org",
            note: "Single authorized identifier outside the domain scope.",
            addedBy: "seed",
          },
        ],
      },
      subjects: {
        create: [
          { kind: "DOMAIN", value: "example.com", label: "Primary domain" },
          { kind: "EMAIL", value: "alice@example.org", label: "Named contact" },
        ],
      },
    },
    include: { scopeEntries: true, subjects: true },
  });

  await prisma.auditEvent.create({
    data: {
      caseId: demo.id,
      action: "case.created",
      actor: "seed",
      detail: {
        source: "prisma/seed.ts",
        scopeEntryCount: demo.scopeEntries.length,
      },
    },
  });

  console.log(`Seeded case ${demo.id} (${demo.name})`);
  console.log(`  scope entries: ${demo.scopeEntries.length}`);
  console.log(`  subjects:      ${demo.subjects.length}`);
  console.log("");
  console.log("Try it:");
  console.log(
    `  curl -s localhost:3001/query -H 'content-type: application/json' \\`,
  );
  console.log(
    `    -d '{"caseId":"${demo.id}","subject":{"kind":"email","value":"bob@example.com"}}' | jq`,
  );
  console.log("  # then the same with an out-of-scope address:");
  console.log(
    `  curl -s localhost:3001/exposure/hibp -H 'content-type: application/json' \\`,
  );
  console.log(
    `    -d '{"caseId":"${demo.id}","confirm":true,"subject":{"kind":"email","value":"someone@unrelated.net"}}' | jq`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
