import http from "node:http";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const STORE_PATH = path.join(__dirname, "data", "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const AUTO_IMPORT_SHEET_URL =
  process.env.GOOGLE_SHEET_URL ||
  "https://docs.google.com/spreadsheets/d/1MfrnJEIrIrXgPDliNZWwTU_jF5GVwrdEYzZs8UJePIw/edit?usp=sharing";
const RECEIPT_TEMPLATE_PUBLIC_PATH = "/receipt_template.pdf";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

function nowIso() {
  return new Date().toISOString();
}

function defaultSeats() {
  return Array.from({ length: 45 }, (_, idx) => ({
    id: idx + 1,
    status: "vacant",
    studentId: null,
    occupantName: null
  }));
}

function normalizePhone(phoneRaw) {
  const digits = String(phoneRaw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return digits;
  return digits;
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function badRequest(res, message) {
  return json(res, 400, { error: message });
}

function notFound(res) {
  return json(res, 404, { error: "Not found" });
}

function makeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function parseDateValue(value, preferMonthFirst = false) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  // Supports dd/mm/yyyy and mm/dd/yyyy. For ambiguous dates, caller can prefer month-first.
  const m = raw.match(/^([0-3]?\d)\/([01]?\d)\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const first = Number(m[1]);
    const secondPart = Number(m[2]);
    const year = Number(m[3]);
    const hour = Number(m[4] || 0);
    const minute = Number(m[5] || 0);
    const second = Number(m[6] || 0);
    let month;
    let day;

    if (first > 12 && secondPart <= 12) {
      day = first;
      month = secondPart;
    } else if (secondPart > 12 && first <= 12) {
      month = first;
      day = secondPart;
    } else {
      month = preferMonthFirst ? first : secondPart;
      day = preferMonthFirst ? secondPart : first;
    }

    const dt = new Date(year, month - 1, day, hour, minute, second);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }

  const fallback = new Date(raw);
  if (Number.isNaN(fallback.getTime())) return null;
  return fallback.toISOString();
}

function parseDateInputYmd(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  // Use local noon to avoid timezone edge-cases that can display previous day.
  const dt = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function addMonthsPreserveDate(startIso, months) {
  const start = new Date(startIso || 0);
  if (Number.isNaN(start.getTime())) return null;

  const m = Math.max(1, Number(months || 1));
  const year = start.getFullYear();
  const monthIndex = start.getMonth();
  const day = start.getDate();

  const targetMonthIndex = monthIndex + m;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const finalMonthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(targetYear, finalMonthIndex + 1, 0).getDate();
  const finalDay = Math.min(day, lastDay);

  const out = new Date(targetYear, finalMonthIndex, finalDay, 12, 0, 0, 0);
  return out.toISOString();
}

function sanitizePlanMonths(months) {
  const n = Math.floor(Number(months || 1));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 12) return 1;
  return n;
}

function isOnOrAfterToday(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return false;
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() >= today.getTime();
}

function estimatePlanMonths(startIso, endIso) {
  if (!startIso || !endIso) return 1;
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 1;
  const months = Math.max(1, Math.round((e - s) / (1000 * 60 * 60 * 24 * 30)));
  return months;
}

function isActiveStudent(student) {
  if (student.status !== "active") return false;
  if (!student.membershipEndDate) return true;
  return isOnOrAfterToday(student.membershipEndDate);
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  fields.push(current.trim());
  return fields;
}

function csvToObjects(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function pickValue(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && String(row[key]).trim()) {
      return String(row[key]).trim();
    }
  }
  return "";
}

function buildStudentImportKey({ name, phone, membershipStartDate, membershipEndDate }) {
  return [
    String(name || "").trim().toLowerCase(),
    String(phone || "").trim(),
    String(membershipStartDate || "").trim(),
    String(membershipEndDate || "").trim()
  ].join("|");
}

function studentIdentityKey(student) {
  const name = String(student?.name || "").trim().toLowerCase();
  const phone = normalizePhone(student?.phone) || String(student?.phone || "").trim();
  return `${name}|${phone}`;
}

function deactivateStudentRecord(store, student, reason = "") {
  student.status = "inactive";
  student.manuallyDeactivated = true;
  student.deactivatedAt = student.deactivatedAt || nowIso();
  if (reason) {
    student.notes = [String(student.notes || "").trim(), reason].filter(Boolean).join(" | ");
  }

  if (student.seatId) {
    const seat = store.seats.find((s) => Number(s.id) === Number(student.seatId));
    if (seat && seat.studentId === student.id) {
      seat.status = "vacant";
      seat.studentId = null;
      seat.occupantName = null;
    }
    student.seatId = null;
  }
}

function cleanupDuplicateActiveIdentities(store) {
  const byKey = new Map();
  for (const s of store.students) {
    const key = studentIdentityKey(s);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }

  let changed = false;
  for (const list of byKey.values()) {
    const active = list.filter((s) => isActiveStudent(s));
    if (active.length <= 1) continue;

    const score = (s) => {
      const createdTs = new Date(s.createdAt || s.joinedAt || 0).getTime() || 0;
      const endTs = new Date(s.membershipEndDate || 0).getTime() || 0;
      const hasSeat = s.seatId ? 1 : 0;
      return [createdTs, endTs, hasSeat];
    };
    active.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sb[0] !== sa[0]) return sb[0] - sa[0];
      if (sb[1] !== sa[1]) return sb[1] - sa[1];
      return sb[2] - sa[2];
    });

    for (const dup of active.slice(1)) {
      deactivateStudentRecord(store, dup, "Auto-cleaned duplicate active record");
      changed = true;
    }
  }

  return changed;
}

function cleanupDuplicateGoogleFormImports(store) {
  const seen = new Set();
  const keepStudentIds = new Set();

  const sorted = [...store.students].sort(
    (a, b) => new Date(a.membershipStartDate || a.joinedAt || 0) - new Date(b.membershipStartDate || b.joinedAt || 0)
  );

  for (const student of sorted) {
    if (student.source !== "google_form") {
      keepStudentIds.add(student.id);
      continue;
    }

    const key =
      student.importSourceKey ||
      buildStudentImportKey({
        name: student.name,
        phone: student.phone,
        membershipStartDate: student.membershipStartDate || student.joinedAt,
        membershipEndDate: student.membershipEndDate || student.endDate
      });

    if (!seen.has(key)) {
      seen.add(key);
      student.importSourceKey = key;
      keepStudentIds.add(student.id);
    }
  }

  const beforeStudents = store.students.length;
  const beforePayments = store.payments.length;
  const beforeReceipts = store.receiptQueue.length;

  store.students = store.students.filter((s) => keepStudentIds.has(s.id));
  store.payments = store.payments.filter((p) => keepStudentIds.has(p.studentId));
  const keepPaymentIds = new Set(store.payments.map((p) => p.id));
  store.receiptQueue = store.receiptQueue.filter((r) => keepPaymentIds.has(r.paymentId));

  return {
    removedStudents: beforeStudents - store.students.length,
    removedPayments: beforePayments - store.payments.length,
    removedReceipts: beforeReceipts - store.receiptQueue.length
  };
}

function makeReceiptMessage(student, payment) {
  const paidOn = new Date(payment.paidAt).toLocaleDateString("en-IN");
  const expiry = student.membershipEndDate
    ? new Date(student.membershipEndDate).toLocaleDateString("en-IN")
    : "N/A";

  return [
    `Hello ${student.name},`,
    "Payment received for Learning Dock Library subscription.",
    `Seat: ${student.seatId || "Not assigned"}`,
    `Amount: Rs ${payment.amount}`,
    `Paid on: ${paidOn}`,
    `Valid till: ${expiry}`,
    "Thank you."
  ].join("\n");
}

function toCsvUrl(googleLink) {
  if (!googleLink.includes("docs.google.com")) return googleLink;
  try {
    const url = new URL(googleLink);
    if (url.pathname.includes("/spreadsheets/")) {
      const parts = url.pathname.split("/");
      const dIndex = parts.indexOf("d");
      const sheetId = dIndex >= 0 ? parts[dIndex + 1] : null;
      if (sheetId) {
        return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
      }
    }
  } catch {
    return googleLink;
  }
  return googleLink;
}

async function loadStore() {
  if (!existsSync(STORE_PATH)) {
    const initial = {
      seats: defaultSeats(),
      students: [],
      payments: [],
      receiptQueue: [],
      imports: [],
      meta: { version: 3, lastAutoImportAt: null, importSeenKeys: [] }
    };
    await writeStore(initial);
    return initial;
  }

  const raw = await readFile(STORE_PATH, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.seats) || parsed.seats.length !== 45) parsed.seats = defaultSeats();
  if (!Array.isArray(parsed.students)) parsed.students = [];
  if (!Array.isArray(parsed.payments)) parsed.payments = [];
  if (!Array.isArray(parsed.receiptQueue)) parsed.receiptQueue = [];
  if (!Array.isArray(parsed.imports)) parsed.imports = [];
  if (!parsed.meta || typeof parsed.meta !== "object") parsed.meta = {};
  if (!Array.isArray(parsed.meta.importSeenKeys)) parsed.meta.importSeenKeys = [];

  parsed.students.forEach((s) => {
    if (!s.membershipStartDate && s.joinedAt) s.membershipStartDate = s.joinedAt;
    if (!s.membershipEndDate && s.endDate) s.membershipEndDate = s.endDate;
    if (!s.createdAt) s.createdAt = s.joinedAt || s.membershipStartDate || nowIso();
  });

  // One-time migration requested by user: start seats fresh, clear old pending receipts.
  if (!parsed.meta.version || parsed.meta.version < 2) {
    parsed.seats = defaultSeats();
    parsed.students.forEach((s) => {
      s.seatId = null;
    });
    parsed.receiptQueue = [];
    parsed.meta.version = 2;
    parsed.meta.lastAutoImportAt = null;
  }

  if (parsed.meta.version < 3) {
    const cleanup = cleanupDuplicateGoogleFormImports(parsed);
    parsed.meta.version = 3;
    parsed.meta.lastCleanup = { at: nowIso(), ...cleanup };
  }

  if (parsed.meta.version < 4) {
    // Repair legacy imported membership dates using payment timestamp + plan duration.
    const paymentByStudent = new Map(parsed.payments.map((p) => [p.studentId, p]));
    for (const s of parsed.students) {
      const p = paymentByStudent.get(s.id);
      if (!p) continue;
      if (s.source === "google_form") {
        const start = parseDateValue(p.paidAt, true) || parseDateValue(p.paidAt) || s.membershipStartDate || s.joinedAt || nowIso();
        const end = addMonthsPreserveDate(start, Number(p.planMonths || 1)) || start;
        s.membershipStartDate = start;
        s.membershipEndDate = end;
      }
      if (s.membershipEndDate) {
        s.status = isOnOrAfterToday(s.membershipEndDate) ? "active" : "inactive";
      }
    }
    parsed.meta.version = 4;
  }

  if (parsed.meta.version < 5) {
    // Repair suspicious manual enrollments created recently with pending receipts but inactive due to bad parsed dates.
    const receiptByStudent = new Map();
    for (const r of parsed.receiptQueue) {
      if (r.status === "pending") receiptByStudent.set(r.studentId, r);
    }
    const latestPaymentByStudent = getLatestPaymentByStudent(parsed.payments);
    for (const s of parsed.students) {
      if (s.source !== "manual" || s.status !== "inactive") continue;
      const pendingReceipt = receiptByStudent.get(s.id);
      if (!pendingReceipt) continue;
      const createdAt = new Date(pendingReceipt.createdAt || 0);
      if (Number.isNaN(createdAt.getTime())) continue;
      if (Date.now() - createdAt.getTime() > 3 * 24 * 60 * 60 * 1000) continue;
      const endTs = new Date(s.membershipEndDate || 0).getTime();
      if (!Number.isFinite(endTs) || endTs >= createdAt.getTime()) continue;

      const p = latestPaymentByStudent[s.id];
      const months = Number(p?.planMonths || 1);
      const fixedStart = new Date(createdAt);
      fixedStart.setHours(0, 0, 0, 0);
      const fixedEndIso = addMonthsPreserveDate(fixedStart.toISOString(), months) || fixedStart.toISOString();

      s.membershipStartDate = fixedStart.toISOString();
      s.membershipEndDate = fixedEndIso;
      s.status = "active";
      if (p) p.paidAt = s.membershipStartDate;
    }
    parsed.meta.version = 5;
  }

  if (parsed.meta.version < 6) {
    // Ensure deactivation marker exists for stable sync behavior.
    for (const s of parsed.students) {
      if (typeof s.manuallyDeactivated !== "boolean") s.manuallyDeactivated = false;
    }
    parsed.meta.version = 6;
  }

  if (parsed.meta.version < 7) {
    if (!parsed.meta.revenueExclusionsByMonth || typeof parsed.meta.revenueExclusionsByMonth !== "object") {
      parsed.meta.revenueExclusionsByMonth = {};
    }
    parsed.meta.version = 7;
  }

  if (parsed.meta.version < 8) {
    // Normalize all existing memberships to end on same date number in target month.
    const latestPaymentByStudent = getLatestPaymentByStudent(parsed.payments);
    for (const s of parsed.students) {
      const start = s.membershipStartDate || s.joinedAt;
      if (!start) continue;
      const pay = latestPaymentByStudent[s.id];
      const months = sanitizePlanMonths(pay?.planMonths || estimatePlanMonths(start, s.membershipEndDate || start));
      const fixedEnd = addMonthsPreserveDate(start, months);
      if (fixedEnd) {
        s.membershipEndDate = fixedEnd;
      }
      // Never auto-reactivate an already inactive student.
      if (s.manuallyDeactivated || s.deactivatedAt || s.status === "inactive") {
        s.status = "inactive";
      } else {
        s.status = isOnOrAfterToday(s.membershipEndDate) ? "active" : "inactive";
      }
      if (pay) pay.planMonths = months;
    }
    parsed.meta.version = 8;
  }

  if (parsed.meta.version < 9) {
    // Safety repair: clamp invalid plan months and fix absurd end dates.
    const latestPaymentByStudent = getLatestPaymentByStudent(parsed.payments);
    for (const payment of parsed.payments) {
      payment.planMonths = sanitizePlanMonths(payment.planMonths);
    }

    for (const s of parsed.students) {
      if (s.manuallyDeactivated || s.deactivatedAt) {
        s.status = "inactive";
      }

      const end = new Date(s.membershipEndDate || 0);
      const endYear = Number.isNaN(end.getTime()) ? 0 : end.getFullYear();
      if (endYear > 2100 || endYear < 2000) {
        const start = s.membershipStartDate || s.joinedAt;
        if (start) {
          const pay = latestPaymentByStudent[s.id];
          const months = sanitizePlanMonths(pay?.planMonths || 1);
          const fixedEnd = addMonthsPreserveDate(start, months);
          if (fixedEnd) {
            s.membershipEndDate = fixedEnd;
          }
          if (pay) pay.planMonths = months;
        }
      }
    }

    parsed.meta.version = 9;
  }

  if (parsed.meta.version < 10) {
    // Safety repair: if same name+phone was duplicated as active during earlier bugs,
    // keep only one active record and deactivate the rest.
    const keyOf = (s) =>
      `${String(s.name || "").trim().toLowerCase()}|${String(s.phone || "").trim()}`;
    const byKey = new Map();
    for (const s of parsed.students) {
      const key = keyOf(s);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s);
    }

    for (const list of byKey.values()) {
      const active = list.filter((s) => s.status === "active");
      if (active.length <= 1) continue;

      const score = (s) => {
        const createdTs = new Date(s.createdAt || s.joinedAt || 0).getTime() || 0;
        const endTs = new Date(s.membershipEndDate || 0).getTime() || 0;
        const hasSeat = s.seatId ? 1 : 0;
        return [createdTs, endTs, hasSeat];
      };
      active.sort((a, b) => {
        const sa = score(a);
        const sb = score(b);
        if (sb[0] !== sa[0]) return sb[0] - sa[0];
        if (sb[1] !== sa[1]) return sb[1] - sa[1];
        return sb[2] - sa[2];
      });

      const keep = active[0];
      const deactivate = active.slice(1);
      for (const s of deactivate) {
        s.status = "inactive";
        s.manuallyDeactivated = true;
        s.deactivatedAt = s.deactivatedAt || nowIso();
        s.notes = [String(s.notes || "").trim(), "Auto-cleaned duplicate active record"]
          .filter(Boolean)
          .join(" | ");

        if (s.seatId) {
          const seat = parsed.seats.find((x) => Number(x.id) === Number(s.seatId));
          if (seat && seat.studentId === s.id) {
            seat.status = "vacant";
            seat.studentId = null;
            seat.occupantName = null;
          }
          s.seatId = null;
        }
      }

      // Ensure the kept one remains active if membership still valid.
      if (keep.status !== "inactive") {
        keep.status = isOnOrAfterToday(keep.membershipEndDate) ? "active" : "inactive";
      }
    }

    parsed.meta.version = 10;
  }

  if (!parsed.meta.revenueExclusionsByMonth || typeof parsed.meta.revenueExclusionsByMonth !== "object") {
    parsed.meta.revenueExclusionsByMonth = {};
  }

  parsed.students.forEach((s) => {
    if (s.source === "google_form" && !s.importSourceKey) {
      s.importSourceKey = buildStudentImportKey({
        name: s.name,
        phone: s.phone,
        membershipStartDate: s.membershipStartDate,
        membershipEndDate: s.membershipEndDate
      });
    }
  });
  parsed.meta.importSeenKeys = Array.from(
    new Set(
      parsed.students
        .filter((s) => s.source === "google_form" && s.importSourceKey)
        .map((s) => s.importSourceKey)
        .concat(parsed.meta.importSeenKeys || [])
      )
  );

  // Always enforce this safety rule to prevent duplicate active identity rows.
  const cleaned = cleanupDuplicateActiveIdentities(parsed);
  if (cleaned) {
    parsed.meta.lastDuplicateCleanupAt = nowIso();
  }

  await writeStore(parsed);

  return parsed;
}

async function writeStore(store) {
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function monthNameByOffset(offset) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return d.toLocaleString("en-US", { month: "long" });
}

function monthDateByOffset(offset) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  d.setDate(1);
  d.setHours(12, 0, 0, 0);
  return d;
}

function getMonthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function parseMonthKey(monthKeyRaw) {
  const raw = String(monthKeyRaw || "").trim();
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  const d = new Date(year, month - 1, 1, 12, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function monthOffsetFromDate(targetDate) {
  const now = new Date();
  return (targetDate.getFullYear() - now.getFullYear()) * 12 + (targetDate.getMonth() - now.getMonth());
}

function monthLabelFromDate(date) {
  return date.toLocaleString("en-US", { month: "long", year: "numeric" });
}

function getMonthlyLatestRevenueEntries(store, offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  const m = d.getMonth();
  const y = d.getFullYear();
  const monthKey = getMonthKey(d);
  const studentById = new Map(store.students.map((s) => [s.id, s]));
  const latestByRevenueKey = new Map();

  for (const p of store.payments) {
    const pd = new Date(p.paidAt);
    if (pd.getMonth() !== m || pd.getFullYear() !== y) continue;

    const student = studentById.get(p.studentId);
    if (offset < 0 && student?.manuallyDeactivated && student.keepRevenueCurrentMonth !== true) {
      continue;
    }
    const revenueKey = student?.id ? `stu:${student.id}` : `pay:${p.id}`;
    const ts = Math.max(
      new Date(p.paidAt || 0).getTime(),
      new Date(p.manualAmountUpdatedAt || 0).getTime()
    );

    const existing = latestByRevenueKey.get(revenueKey);
    if (!existing || ts >= existing.ts) {
      latestByRevenueKey.set(revenueKey, {
        ts,
        key: String(revenueKey),
        studentId: String(student?.id || p.studentId || ""),
        phone: String(student?.phone || ""),
        studentName: student?.name || "Unknown",
        membershipStartDate: student?.membershipStartDate || null,
        membershipEndDate: student?.membershipEndDate || null,
        amount: Number(p.amount || 0)
      });
    }
  }

  return { monthKey, entries: Array.from(latestByRevenueKey.values()) };
}

function monthRevenue(store, offset = 0) {
  const { monthKey, entries } = getMonthlyLatestRevenueEntries(store, offset);
  const excluded = new Set((store.meta.revenueExclusionsByMonth?.[monthKey] || []).map(String));
  let total = 0;
  for (const entry of entries) {
    if (
      excluded.has(String(entry.key || "")) ||
      excluded.has(String(entry.phone || "")) ||
      excluded.has(String(entry.studentId || ""))
    ) {
      continue;
    }
    total += Number(entry.amount || 0);
  }
  return total;
}

function getActiveStudentsRevenueEntries(store) {
  const latestPaymentByStudent = getLatestPaymentByStudent(store.payments);
  const uniqueByIdentity = new Map();
  for (const student of store.students.filter(isActiveStudent)) {
    const key = studentIdentityKey(student);
    const existing = uniqueByIdentity.get(key);
    if (!existing) {
      uniqueByIdentity.set(key, student);
      continue;
    }
    const currentTs = new Date(student.createdAt || student.joinedAt || 0).getTime() || 0;
    const existingTs = new Date(existing.createdAt || existing.joinedAt || 0).getTime() || 0;
    if (currentTs >= existingTs) uniqueByIdentity.set(key, student);
  }

  return Array.from(uniqueByIdentity.values())
    .filter(isActiveStudent)
    .map((student) => ({
      studentId: String(student.id),
      studentName: student.name || "Unknown",
      membershipStartDate: student.membershipStartDate || null,
      membershipEndDate: student.membershipEndDate || null,
      amount: Number(latestPaymentByStudent[student.id]?.amount || 0),
      createdAt: student.createdAt || student.joinedAt || student.membershipStartDate || ""
    }))
    .sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime();
      const tb = new Date(b.createdAt || 0).getTime();
      return ta - tb;
    });
}

function currentMonthRevenueFromActiveSelection(store) {
  return monthRevenue(store, 0);
}

function getLatestPaymentByStudent(payments) {
  const map = {};
  for (const payment of payments) {
    const existing = map[payment.studentId];
    if (!existing) {
      map[payment.studentId] = payment;
      continue;
    }
    const currentTs = new Date(payment.paidAt || 0).getTime();
    const existingTs = new Date(existing.paidAt || 0).getTime();
    if (currentTs >= existingTs) {
      map[payment.studentId] = payment;
    }
  }
  return map;
}

async function autoImportFromGoogleSheet(store) {
  const source = AUTO_IMPORT_SHEET_URL;
  if (!source) {
    return { createdCount: 0, skippedCount: 0, message: "No Google Sheet configured" };
  }

  const csvUrl = toCsvUrl(source);
  let csvText;
  try {
    const response = await fetch(csvUrl);
    if (!response.ok) {
      return { createdCount: 0, skippedCount: 0, message: `Fetch failed (${response.status})` };
    }
    csvText = await response.text();
  } catch (err) {
    return { createdCount: 0, skippedCount: 0, message: err.message };
  }

  if (/^\s*<!doctype html/i.test(csvText) || /^\s*<html/i.test(csvText)) {
    return { createdCount: 0, skippedCount: 0, message: "URL returned HTML instead of CSV" };
  }

  const rows = csvToObjects(csvText);
  if (!rows.length) return { createdCount: 0, skippedCount: 0, message: "No rows" };

  let createdCount = 0;
  let skippedCount = 0;
  let deletedCount = 0;
  const skipReasons = { missingNameOrPhone: 0, duplicateSourceRow: 0 };
  const sourceKeysInSheet = new Set();

  for (const row of rows) {
    const name = pickValue(row, ["Full Name", "Name", "Student Name", "Your Name"]);
    const phoneRaw = pickValue(row, ["Contact Number", "Phone", "Phone Number", "Mobile", "WhatsApp Number"]);
    const planRaw = pickValue(row, ["Choose your membership plan", "Plan", "Subscription"]);
    const paidAtRaw = pickValue(row, ["Timestamp", "Payment Date", "Paid At"]);

    const phone = normalizePhone(phoneRaw);
    if (!name || !phone) {
      skippedCount += 1;
      skipReasons.missingNameOrPhone += 1;
      continue;
    }

    const paidAt = parseDateValue(paidAtRaw, true) || parseDateValue(paidAtRaw) || nowIso();
    const membershipStartDate = paidAt;
    const inferredMonths = /3|quarter|quarterly|3000/i.test(planRaw) ? 3 : 1;
    const membershipEndDate = addMonthsPreserveDate(membershipStartDate, inferredMonths) || membershipStartDate;

    const amount = /3000/.test(planRaw) ? 3000 : 1200;
    const importSourceKey = buildStudentImportKey({ name, phone, membershipStartDate, membershipEndDate });
    sourceKeysInSheet.add(importSourceKey);

    const existingByKey = store.students.find((s) => s.source === "google_form" && s.importSourceKey === importSourceKey);
    const existingByIdentity = store.students.find(
      (s) =>
        s.source === "google_form" &&
        String(s.name || "").trim().toLowerCase() === name.toLowerCase() &&
        String(s.phone || "").trim() === phone
    );
    const existingStudent = existingByKey || existingByIdentity;

    if (existingStudent) {
      const existingPayment = getLatestPaymentByStudent(store.payments)[existingStudent.id];
      const keepManualDates = Boolean(existingStudent.manualDateOverride || existingPayment?.manualDateOverride);

      if (!keepManualDates) {
        existingStudent.membershipStartDate = membershipStartDate;
        existingStudent.membershipEndDate = membershipEndDate;
      }
      existingStudent.importSourceKey = importSourceKey;
      if (existingStudent.manuallyDeactivated || existingStudent.deactivatedAt || existingStudent.status === "inactive") {
        existingStudent.status = "inactive";
      } else {
        existingStudent.status = isOnOrAfterToday(existingStudent.membershipEndDate) ? "active" : "inactive";
      }

      if (existingPayment) {
        if (!keepManualDates) {
          existingPayment.paidAt = paidAt;
          existingPayment.planMonths = sanitizePlanMonths(
            estimatePlanMonths(membershipStartDate, membershipEndDate)
          );
        }
        if (!existingPayment.manualAmountOverride) {
          existingPayment.amount = amount;
        }
      }

      skippedCount += 1;
      skipReasons.duplicateSourceRow += 1;
      continue;
    }

    const studentId = makeId("stu");
    const paymentId = makeId("pay");

    const student = {
      id: studentId,
      name,
      phone,
      seatId: null,
      membershipStartDate,
      membershipEndDate,
      status: "active",
      source: "google_form",
      notes: "Auto-imported from Google Form",
      importSourceKey,
      createdAt: nowIso(),
      manuallyDeactivated: false
    };

    const payment = {
      id: paymentId,
      studentId,
      amount,
      paidAt,
      method: "Online",
      planMonths: sanitizePlanMonths(estimatePlanMonths(membershipStartDate, membershipEndDate)),
      receiptStatus: "pending",
      notes: "Auto-imported"
    };

    const queueItem = {
      id: makeId("rcpt"),
      paymentId,
      studentId,
      phone,
      message: makeReceiptMessage(student, payment),
      status: "pending",
      createdAt: nowIso()
    };

    store.students.unshift(student);
    store.payments.unshift(payment);
    store.receiptQueue.unshift(queueItem);
    createdCount += 1;
  }

  // Reconcile removals: if a Google-form-imported student key is no longer in sheet,
  // remove that student and related payment/receipt records.
  const toRemoveStudentIds = new Set();
  for (const student of store.students) {
    if (student.source !== "google_form") continue;
    const key =
      student.importSourceKey ||
      buildStudentImportKey({
        name: student.name,
        phone: student.phone,
        membershipStartDate: student.membershipStartDate || student.joinedAt,
        membershipEndDate: student.membershipEndDate || student.endDate
      });
    if (!sourceKeysInSheet.has(key)) {
      toRemoveStudentIds.add(student.id);
    }
  }

  if (toRemoveStudentIds.size) {
    deletedCount = toRemoveStudentIds.size;
    for (const seat of store.seats) {
      if (seat.studentId && toRemoveStudentIds.has(seat.studentId)) {
        seat.studentId = null;
        seat.occupantName = null;
        seat.status = "vacant";
      }
    }
    store.students = store.students.filter((s) => !toRemoveStudentIds.has(s.id));
    store.payments = store.payments.filter((p) => !toRemoveStudentIds.has(p.studentId));
    const keepPaymentIds = new Set(store.payments.map((p) => p.id));
    store.receiptQueue = store.receiptQueue.filter((r) => keepPaymentIds.has(r.paymentId));
  }

  store.imports.unshift({
    id: makeId("imp"),
    source: csvUrl,
    importedAt: nowIso(),
    createdCount,
    skippedCount
  });
  store.meta.lastAutoImportAt = nowIso();
  store.meta.importSeenKeys = Array.from(
    new Set(
      store.students
        .filter((s) => s.source === "google_form" && s.importSourceKey)
        .map((s) => s.importSourceKey)
    )
  );

  return { createdCount, skippedCount, deletedCount, source: csvUrl, skipReasons };
}

async function handleDashboard(req, res) {
  const store = await loadStore();
  const occupiedSeats = store.seats.filter((s) => s.status === "occupied").length;
  const latestPaymentByStudent = getLatestPaymentByStudent(store.payments);
  const studentsWithAmounts = store.students.map((s) => ({
    ...s,
    amountPaid: Number(latestPaymentByStudent[s.id]?.amount || 0)
  }));

  json(res, 200, {
    stats: {
      totalSeats: store.seats.length,
      occupiedSeats,
      vacantSeats: store.seats.length - occupiedSeats,
      activeStudents: getActiveStudentsRevenueEntries(store).length,
      currentMonthRevenue: currentMonthRevenueFromActiveSelection(store),
      previousMonthRevenue: monthRevenue(store, -1),
      currentMonthLabel: `${monthNameByOffset(0)} Revenue`,
      previousMonthLabel: `${monthNameByOffset(-1)} Revenue`,
      currentMonthKey: getMonthKey(monthDateByOffset(0)),
      previousMonthKey: getMonthKey(monthDateByOffset(-1)),
      pendingReceipts: store.receiptQueue.filter((q) => q.status === "pending").length
    },
    seats: store.seats,
    students: studentsWithAmounts,
    payments: store.payments,
    receiptQueue: store.receiptQueue,
    autoImport: {
      sheetUrl: AUTO_IMPORT_SHEET_URL,
      lastRunAt: store.meta.lastAutoImportAt || null
    },
    revenueConfig: {
      currentMonthKey: getMonthKey(new Date()),
      editable: true
    }
  });
}

async function handleEnroll(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const name = String(body.name || "").trim();
  const phone = normalizePhone(body.phone);
  const membershipStartDate = parseDateInputYmd(body.membershipStartDate);
  const membershipEndDate = parseDateInputYmd(body.membershipEndDate);
  const amount = Number(body.amount || 0);
  const method = String(body.method || "Online");

  if (!name) return badRequest(res, "Name is required");
  if (!phone) return badRequest(res, "Phone is required");
  if (!membershipStartDate) return badRequest(res, "Start date must be selected from date picker (YYYY-MM-DD)");
  if (!membershipEndDate) return badRequest(res, "End date must be selected from date picker (YYYY-MM-DD)");
  if (new Date(membershipEndDate).getTime() < new Date(membershipStartDate).getTime()) {
    return badRequest(res, "Membership end date cannot be before start date");
  }
  if (!isOnOrAfterToday(membershipEndDate)) {
    return badRequest(res, "Membership end date is already in the past");
  }
  if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, "Amount paid is required");
  if (!["Online", "Cash"].includes(method)) return badRequest(res, "Method must be Online or Cash");

  const store = await loadStore();

  const studentId = makeId("stu");
  const paymentId = makeId("pay");
  const student = {
    id: studentId,
    name,
    phone,
    seatId: null,
    membershipStartDate,
    membershipEndDate,
    status: isOnOrAfterToday(membershipEndDate) ? "active" : "inactive",
    source: "manual",
    notes: "",
    createdAt: nowIso(),
    manuallyDeactivated: false
  };

  const payment = {
    id: paymentId,
    studentId,
    amount,
    paidAt: membershipStartDate,
    method,
    planMonths: sanitizePlanMonths(estimatePlanMonths(membershipStartDate, membershipEndDate)),
    receiptStatus: "pending",
    notes: "Manual enrollment"
  };

  const queueItem = {
    id: makeId("rcpt"),
    paymentId,
    studentId,
    phone,
    message: makeReceiptMessage(student, payment),
    status: "pending",
    createdAt: nowIso()
  };

  store.students.unshift(student);
  store.payments.unshift(payment);
  store.receiptQueue.unshift(queueItem);

  await writeStore(store);
  return json(res, 201, { student, payment, queueItem });
}

async function handleAssignSeat(req, res, seatIdInput) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const firstName = String(body.firstName || "").trim();
  if (!firstName) return badRequest(res, "First name is required");

  const seatId = Number(seatIdInput);
  if (!Number.isInteger(seatId) || seatId < 1 || seatId > 45) return badRequest(res, "Invalid seat");

  const store = await loadStore();
  const seat = store.seats.find((s) => s.id === seatId);
  if (!seat) return badRequest(res, "Seat not found");
  if (seat.status === "occupied") return badRequest(res, "Seat is already occupied");

  const activeStudent = store.students.find((s) => {
    if (!isActiveStudent(s)) return false;
    const first = String(s.name || "").trim().split(/\s+/)[0]?.toLowerCase();
    return first === firstName.toLowerCase();
  });

  if (!activeStudent) {
    return badRequest(res, "Enter a valid name. No active student found, please check spelling.");
  }

  seat.status = "occupied";
  seat.occupantName = firstName;
  seat.studentId = activeStudent.id;
  activeStudent.seatId = seat.id;

  await writeStore(store);
  return json(res, 200, { seat, linkedStudent: activeStudent });
}

async function handleVacateSeat(req, res, seatIdInput) {
  const seatId = Number(seatIdInput);
  if (!Number.isInteger(seatId) || seatId < 1 || seatId > 45) return badRequest(res, "Invalid seat");

  const store = await loadStore();
  const seat = store.seats.find((s) => s.id === seatId);
  if (!seat) return badRequest(res, "Seat not found");

  if (seat.studentId) {
    const student = store.students.find((s) => s.id === seat.studentId);
    if (student) student.seatId = null;
  }

  seat.status = "vacant";
  seat.studentId = null;
  seat.occupantName = null;

  await writeStore(store);
  return json(res, 200, { seat });
}

async function handleDeactivateStudent(req, res, studentIdInput) {
  const studentId = String(studentIdInput || "").trim();
  if (!studentId) return badRequest(res, "Student id is required");

  const store = await loadStore();
  const student = store.students.find((s) => s.id === studentId);
  if (!student) return badRequest(res, "Student not found");
  const identityKey = studentIdentityKey(student);
  const affected = store.students.filter((s) => studentIdentityKey(s) === identityKey && isActiveStudent(s));
  for (const row of affected) {
    row.keepRevenueCurrentMonth = true;
    deactivateStudentRecord(store, row, "Deactivated from dashboard");
  }

  await writeStore(store);
  return json(res, 200, { student, deactivatedCount: affected.length });
}

async function handleUpdateStudentAmount(req, res, studentIdInput) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const studentId = String(studentIdInput || "").trim();
  const amount = Number(body.amount || 0);
  if (!studentId) return badRequest(res, "Student id is required");
  if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, "Valid amount is required");

  const store = await loadStore();
  const student = store.students.find((s) => s.id === studentId);
  if (!student) return badRequest(res, "Student not found");

  const latestPayment = getLatestPaymentByStudent(store.payments)[studentId];
  if (!latestPayment) return badRequest(res, "No payment record found for this student");

  latestPayment.amount = amount;
  latestPayment.manualAmountOverride = true;
  latestPayment.manualAmountUpdatedAt = nowIso();

  await writeStore(store);
  return json(res, 200, { studentId, amount, paymentId: latestPayment.id });
}

async function handleUpdateStudentMembershipDates(req, res, studentIdInput) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const studentId = String(studentIdInput || "").trim();
  const membershipStartDate = parseDateInputYmd(body.membershipStartDate);
  const membershipEndDate = parseDateInputYmd(body.membershipEndDate);

  if (!studentId) return badRequest(res, "Student id is required");
  if (!membershipStartDate) return badRequest(res, "Start date must be selected from date picker (YYYY-MM-DD)");
  if (!membershipEndDate) return badRequest(res, "End date must be selected from date picker (YYYY-MM-DD)");
  if (new Date(membershipEndDate).getTime() < new Date(membershipStartDate).getTime()) {
    return badRequest(res, "Membership end date cannot be before start date");
  }

  const store = await loadStore();
  const student = store.students.find((s) => s.id === studentId);
  if (!student) return badRequest(res, "Student not found");
  if (student.manuallyDeactivated || student.deactivatedAt || student.status === "inactive") {
    return badRequest(res, "Cannot edit dates for inactive/deactivated student");
  }

  student.membershipStartDate = membershipStartDate;
  student.membershipEndDate = membershipEndDate;
  student.manualDateOverride = true;
  student.status = isOnOrAfterToday(membershipEndDate) ? "active" : "inactive";

  if (student.status !== "active" && student.seatId) {
    const seat = store.seats.find((x) => Number(x.id) === Number(student.seatId));
    if (seat) {
      seat.status = "vacant";
      seat.studentId = null;
      seat.occupantName = null;
    }
    student.seatId = null;
  }

  const latestPayment = getLatestPaymentByStudent(store.payments)[studentId];
  if (latestPayment) {
    latestPayment.planMonths = sanitizePlanMonths(estimatePlanMonths(membershipStartDate, membershipEndDate));
    latestPayment.manualDateOverride = true;
    latestPayment.manualDateUpdatedAt = nowIso();
  }

  await writeStore(store);
  return json(res, 200, { student });
}

async function handleMarkMembershipReminderSent(req, res, studentIdInput) {
  const studentId = String(studentIdInput || "").trim();
  if (!studentId) return badRequest(res, "Student id is required");

  const store = await loadStore();
  const student = store.students.find((s) => s.id === studentId);
  if (!student) return badRequest(res, "Student not found");
  if (!student.membershipEndDate) return badRequest(res, "Student has no membership end date");

  student.membershipReminderSentForEndDate = student.membershipEndDate;
  student.membershipReminderSentAt = nowIso();

  await writeStore(store);
  return json(res, 200, {
    studentId: student.id,
    membershipReminderSentForEndDate: student.membershipReminderSentForEndDate,
    membershipReminderSentAt: student.membershipReminderSentAt
  });
}

async function handleGetRevenueConfig(req, res, url) {
  const store = await loadStore();
  const monthKeyRaw = url?.searchParams?.get("monthKey");
  const targetMonthDate = monthKeyRaw ? parseMonthKey(monthKeyRaw) : monthDateByOffset(0);
  if (!targetMonthDate) return badRequest(res, "Invalid monthKey. Expected YYYY-MM");
  const offset = monthOffsetFromDate(targetMonthDate);
  const { monthKey, entries } = getMonthlyLatestRevenueEntries(store, offset);
  const excluded = new Set((store.meta.revenueExclusionsByMonth?.[monthKey] || []).map(String));
  const options = entries
    .map((e) => ({
      key: String(e.key || e.phone),
      studentId: String(e.studentId || ""),
      studentName: e.studentName,
      membershipStartDate: e.membershipStartDate,
      membershipEndDate: e.membershipEndDate,
      amount: Number(e.amount || 0),
      included: !(excluded.has(String(e.key || e.phone)) || excluded.has(String(e.studentId || "")))
    }));

  return json(res, 200, {
    monthKey,
    monthLabel: monthLabelFromDate(targetMonthDate),
    options
  });
}

async function handleSaveRevenueConfig(req, res, url) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const includedRevenueKeys = Array.isArray(body.includedRevenueKeys)
    ? body.includedRevenueKeys.map((id) => String(id))
    : Array.isArray(body.includedStudentIds)
      ? body.includedStudentIds.map((id) => String(id))
      : null;
  if (!includedRevenueKeys) return badRequest(res, "includedRevenueKeys array is required");

  const store = await loadStore();
  const monthKeyRaw = String(body.monthKey || url?.searchParams?.get("monthKey") || "");
  const targetMonthDate = monthKeyRaw ? parseMonthKey(monthKeyRaw) : monthDateByOffset(0);
  if (!targetMonthDate) return badRequest(res, "Invalid monthKey. Expected YYYY-MM");
  const offset = monthOffsetFromDate(targetMonthDate);
  const { monthKey, entries } = getMonthlyLatestRevenueEntries(store, offset);
  const allRevenueKeys = entries.map((e) => String(e.key || e.phone));
  const includedSet = new Set(includedRevenueKeys);
  const excluded = allRevenueKeys.filter((id) => !includedSet.has(id));

  store.meta.revenueExclusionsByMonth[monthKey] = excluded;
  await writeStore(store);
  return json(res, 200, { monthKey, excludedCount: excluded.length });
}

function buildWhatsAppUrl(phone, message) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function normalizeBaseUrl(raw) {
  const cleaned = String(raw || "").trim();
  if (!cleaned) return "";
  return cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
}

function getReceiptPdfUrl(req) {
  const explicit = normalizeBaseUrl(process.env.RECEIPT_PDF_URL);
  if (explicit) return explicit;
  const base = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
  if (!base) return null;
  return `${base}${RECEIPT_TEMPLATE_PUBLIC_PATH}`;
}

function makeReceiptFileName(student, payment) {
  const safeName = String(student?.name || "Student")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "");
  const paidAt = new Date(payment?.paidAt || Date.now()).toISOString().slice(0, 10);
  return `${safeName}_Payment_Receipt_${paidAt}.pdf`;
}

async function trySendViaWhatsAppCloud(phone, message) {
  const token = process.env.WHATSAPP_CLOUD_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    return { sent: false, reason: "WhatsApp Cloud API env vars not configured" };
  }

  const response = await fetch(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    return { sent: false, reason: text.slice(0, 300) };
  }
  return { sent: true };
}

async function trySendDocumentViaWhatsAppCloud(phone, { documentUrl, filename, caption }) {
  const token = process.env.WHATSAPP_CLOUD_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    return { sent: false, reason: "WhatsApp Cloud API env vars not configured" };
  }
  if (!documentUrl) {
    return { sent: false, reason: "No public receipt PDF URL configured" };
  }

  const response = await fetch(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "document",
      document: {
        link: documentUrl,
        filename: filename || "LearningDock_Receipt.pdf",
        caption: caption || "Learning Dock Library Payment Receipt"
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    return { sent: false, reason: text.slice(0, 300) };
  }
  return { sent: true };
}

async function handleReceiptDecision(req, res, queueIdInput) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }

  const action = String(body.action || "").toLowerCase();
  if (!["send", "skip"].includes(action)) return badRequest(res, "Action must be send or skip");

  const store = await loadStore();
  const queueItem = store.receiptQueue.find((q) => q.id === queueIdInput);
  if (!queueItem) return badRequest(res, "Queue item not found");

  queueItem.status = action === "send" ? "sent" : "skipped";
  queueItem.decidedAt = nowIso();

  const payment = store.payments.find((p) => p.id === queueItem.paymentId);
  if (payment) payment.receiptStatus = queueItem.status;
  const student = store.students.find((s) => s.id === queueItem.studentId);
  const receiptUrl = getReceiptPdfUrl(req);

  let whatsapp = null;
  if (action === "send") {
    const baseMessage = queueItem.message || makeReceiptMessage(student || {}, payment || {});
    const messageWithReceiptLink = receiptUrl ? `${baseMessage}\n\nReceipt PDF: ${receiptUrl}` : baseMessage;

    const cloudDocResult = await trySendDocumentViaWhatsAppCloud(queueItem.phone, {
      documentUrl: receiptUrl,
      filename: makeReceiptFileName(student, payment),
      caption: baseMessage
    });

    if (cloudDocResult.sent) {
      whatsapp = { mode: "cloud_api_document", sent: true, receiptUrl };
    } else {
      const cloudTextResult = await trySendViaWhatsAppCloud(queueItem.phone, messageWithReceiptLink);
      if (cloudTextResult.sent) {
        whatsapp = { mode: "cloud_api_text", sent: true, receiptUrl };
      } else {
        whatsapp = {
          mode: "manual_link",
          sent: false,
          reason: `${cloudDocResult.reason}; ${cloudTextResult.reason}`,
          url: buildWhatsAppUrl(queueItem.phone, messageWithReceiptLink),
          receiptUrl
        };
      }
    }
  }

  await writeStore(store);
  return json(res, 200, { queueItem, payment, whatsapp });
}

async function handleAutoSync(req, res) {
  const store = await loadStore();
  const result = await autoImportFromGoogleSheet(store);
  await writeStore(store);
  return json(res, 200, result);
}

async function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, cleanPath);

  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return notFound(res);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    return notFound(res);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/api/dashboard") return await handleDashboard(req, res);
    if (req.method === "POST" && pathname === "/api/enroll") return await handleEnroll(req, res);
    if (req.method === "POST" && pathname === "/api/sync/google-form") return await handleAutoSync(req, res);

    if (req.method === "POST" && pathname.startsWith("/api/seats/") && pathname.endsWith("/assign")) {
      const seatId = pathname.replace("/api/seats/", "").replace("/assign", "");
      return await handleAssignSeat(req, res, seatId);
    }

    if (req.method === "POST" && pathname.startsWith("/api/seats/") && pathname.endsWith("/vacate")) {
      const seatId = pathname.replace("/api/seats/", "").replace("/vacate", "");
      return await handleVacateSeat(req, res, seatId);
    }

    if (req.method === "POST" && pathname.startsWith("/api/students/") && pathname.endsWith("/deactivate")) {
      const studentId = pathname.replace("/api/students/", "").replace("/deactivate", "");
      return await handleDeactivateStudent(req, res, studentId);
    }

    if (req.method === "POST" && pathname.startsWith("/api/students/") && pathname.endsWith("/amount")) {
      const studentId = pathname.replace("/api/students/", "").replace("/amount", "");
      return await handleUpdateStudentAmount(req, res, studentId);
    }

    if (req.method === "POST" && pathname.startsWith("/api/students/") && pathname.endsWith("/dates")) {
      const studentId = pathname.replace("/api/students/", "").replace("/dates", "");
      return await handleUpdateStudentMembershipDates(req, res, studentId);
    }

    if (req.method === "POST" && pathname.startsWith("/api/students/") && pathname.endsWith("/membership-reminder")) {
      const studentId = pathname.replace("/api/students/", "").replace("/membership-reminder", "");
      return await handleMarkMembershipReminderSent(req, res, studentId);
    }

    if (req.method === "GET" && pathname === "/api/revenue/current/config") {
      return await handleGetRevenueConfig(req, res, url);
    }

    if (req.method === "POST" && pathname === "/api/revenue/current/config") {
      return await handleSaveRevenueConfig(req, res, url);
    }

    if (req.method === "GET" && pathname === "/api/revenue/config") {
      return await handleGetRevenueConfig(req, res, url);
    }

    if (req.method === "POST" && pathname === "/api/revenue/config") {
      return await handleSaveRevenueConfig(req, res, url);
    }

    if (req.method === "POST" && pathname.startsWith("/api/receipts/") && pathname.endsWith("/decision")) {
      const queueId = pathname.replace("/api/receipts/", "").replace("/decision", "");
      return await handleReceiptDecision(req, res, queueId);
    }

    if (req.method === "GET" && pathname === "/health") return json(res, 200, { ok: true, at: nowIso() });
    if (req.method === "GET") return await serveStatic(req, res, pathname);

    return notFound(res);
  } catch (err) {
    return json(res, 500, { error: err.message || "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Learning Dock Library Manager running on http://localhost:${PORT}`);
});
