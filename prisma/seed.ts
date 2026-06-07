import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

const db = new PrismaClient();

type Raw = {
  id: string; name: string; age: number; urgency: string; condition: string;
  assigned_doctor: string; time_preference: string; preferred_time: string;
  days_on_waitlist: number; assigned_date: string; contact_attempts: number;
  last_contact_result: string; times_skipped: number; procedure_cost: number;
  procedure_time_min: number; phone: string;
  consent: boolean; opted_out?: boolean;
};

const hasOutboundConsent = (p: Raw) => p.consent === true;

const hrs = (h: number) => new Date(Date.now() + h * 3_600_000);
const todayAt = (hh: number, mm = 0) => {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d;
};

const dayAt = (days: number, hh: number, mm = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hh, mm, 0, 0);
  return d;
};

const demoPhone = (n: number) => process.env[`DEMO_PHONE_${n}`] || null;

async function main() {
  await db.eventLog.deleteMany();
  await db.recoveryAttempt.deleteMany();
  await db.slot.deleteMany();
  await db.patient.deleteMany();

  const raw: Raw[] = JSON.parse(readFileSync(join(process.cwd(), "waitlist_patients.json"), "utf8"));

  let idx = 0;
  for (const p of raw) {
    idx++;
    const overridePhone =
      p.id === "P002" ? demoPhone(1) : p.id === "P003" ? demoPhone(2) : p.id === "P004" ? demoPhone(3) : null;
    await db.patient.create({
      data: {
        name: p.name,
        phone: overridePhone || p.phone,
        age: p.age,
        consentOutbound: hasOutboundConsent(p),
        onWaitlist: true,
        urgency: p.urgency,
        condition: p.condition,
        assignedDoctor: p.assigned_doctor,
        timePreference: p.time_preference,
        preferredTime: p.preferred_time,
        daysOnWaitlist: p.days_on_waitlist,
        assignedDate: new Date(p.assigned_date),
        contactAttempts: p.contact_attempts,
        lastContactResult: p.last_contact_result,
        timesSkipped: p.times_skipped,
        procedureCost: p.procedure_cost,
        procedureTimeMin: p.procedure_time_min,
      },
    });
  }

  const schedule: [number, number, string, string, string, number, number][] = [
    [9, 0, "Anna Keller", "Hygiene", "Dr. Anna Wagner", 30, 90],
    [9, 30, "Felix Wagner", "Crown fitting", "Dr. Stefan Bauer", 60, 350],
    [10, 30, "Nina Fischer", "Root canal", "Dr. Elisabeth Huber", 75, 300],
    [11, 30, "Lukas Bauer", "Hygiene", "Dr. Anna Wagner", 30, 90],
    [14, 0, "Jonas Hofer", "Ortho adjustment", "Dr. Stefan Bauer", 60, 120],
    [15, 30, "David Fuchs", "Crown fitting", "Dr. Elisabeth Huber", 60, 350],
    [17, 30, "Maria Schmid", "Implant consultation", "Dr. Stefan Bauer", 90, 450],
  ];
  for (const [hh, mm, who, treatment, doctor, durationMin, valueEur] of schedule) {
    await db.slot.create({
      data: {
        startsAt: todayAt(hh, mm),
        durationMin,
        treatment,
        practitioner: doctor,
        room: "OP 1",
        status: "booked",
        valueEur,
        bookedPatientName: who,
      },
    });
  }

  const openSlots: [number, number, number, string, string, number, number][] = [
    [1, 9, 0, "Implant consultation", "Dr. Stefan Bauer", 90, 450],
    [1, 11, 0, "Hygiene", "Dr. Anna Wagner", 30, 90],
    [1, 14, 30, "Root canal", "Dr. Elisabeth Huber", 90, 300],
    [2, 10, 0, "Crown fitting", "Dr. Stefan Bauer", 120, 350],
    [2, 13, 0, "Hygiene", "Dr. Anna Wagner", 60, 90],
    [3, 9, 30, "Implant consultation", "Dr. Elisabeth Huber", 90, 450],
  ];
  for (const [days, hh, mm, treatment, doctor, durationMin, valueEur] of openSlots) {
    await db.slot.create({
      data: {
        startsAt: dayAt(days, hh, mm),
        durationMin,
        treatment,
        practitioner: doctor,
        room: "OP 2",
        status: "open",
        valueEur,
      },
    });
  }

  const counts = {
    patients: raw.length,
    noConsent: raw.filter((p) => !hasOutboundConsent(p)).length,
    bookedSlots: schedule.length,
    openSlots: openSlots.length,
  };
  console.log("Seed complete:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
