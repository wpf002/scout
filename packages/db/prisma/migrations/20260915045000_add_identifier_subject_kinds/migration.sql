-- Four more subject kinds, so an address, a phone number, a ship and a plate
-- can each be the subject of a case rather than only appearing inside one.
--
-- Written by hand rather than generated. `migrate dev` wanted to reset the
-- database to build its shadow copy, and this instance holds real case and
-- audit history. ALTER TYPE ... ADD VALUE is additive and safe to apply
-- directly; nothing reads these values until an adapter emits one.
ALTER TYPE "SubjectKind" ADD VALUE IF NOT EXISTS 'ADDRESS';
ALTER TYPE "SubjectKind" ADD VALUE IF NOT EXISTS 'PHONE';
ALTER TYPE "SubjectKind" ADD VALUE IF NOT EXISTS 'VESSEL';
ALTER TYPE "SubjectKind" ADD VALUE IF NOT EXISTS 'PLATE';
