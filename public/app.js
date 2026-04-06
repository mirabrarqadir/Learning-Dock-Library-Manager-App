const statsEl = document.getElementById("stats");
const seatLayoutEl = document.getElementById("seatLayout");
const studentsTableEl = document.getElementById("studentsTable");
const recentEndedTableEl = document.getElementById("recentEndedTable");
const receiptQueueEl = document.getElementById("receiptQueue");
const membershipReminderQueueEl = document.getElementById("membershipReminderQueue");
const syncStatusEl = document.getElementById("syncStatus");
const refreshBtn = document.getElementById("refreshBtn");
const sheetLinkEl = document.getElementById("sheetLink");
const revenueModalEl = document.getElementById("revenueModal");
const revenueOptionsEl = document.getElementById("revenueOptions");
const revenueModalTitleEl = document.getElementById("revenueModalTitle");
const closeRevenueModalBtn = document.getElementById("closeRevenueModal");
const saveRevenueConfigBtn = document.getElementById("saveRevenueConfigBtn");
let isEnrollSubmitting = false;
let dashboardStudents = [];
let revenueAutoSaveTimer = null;
let revenueAutoSaveBusy = false;
let revenueConfigMonthKey = null;

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

function fmtDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-IN");
}

function toDateInputValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtRange(startIso, endIso) {
  return `${fmtDate(startIso)} - ${fmtDate(endIso)}`;
}

function dateStartLocal(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntilEnd(endIso) {
  const end = dateStartLocal(endIso);
  if (!end) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - today.getTime()) / 86400000);
}

function isStudentCurrentlyActive(student) {
  if (student.status !== "active") return false;
  if (!student.membershipEndDate) return true;
  const left = daysUntilEnd(student.membershipEndDate);
  if (left === null) return false;
  return left >= 0;
}

function membershipAlertText(student) {
  const left = daysUntilEnd(student.membershipEndDate);
  if (left === 2) return "Ending in 2 days";
  if (left === 1) return "Ending in 1 day";
  if (left === 0) return "Ends today";
  return "-";
}

function isRecentlyEnded(student) {
  if (student.manuallyDeactivated) return false;
  if (!student.membershipEndDate) return false;
  const left = daysUntilEnd(student.membershipEndDate);
  return left !== null && left <= -1 && left >= -10;
}

function makeMembershipReminderMessage(student) {
  const left = daysUntilEnd(student.membershipEndDate);
  const dayText = left === 0 ? "today" : left === 1 ? "1 day" : "2 days";
  const firstName = String(student.name || "").trim().split(/\s+/)[0] || "Student";
  const endDate = fmtDate(student.membershipEndDate);
  return [
    `Hello ${firstName},`,
    "",
    `This is a gentle reminder that your Learning Dock Library membership will expire ${left === 0 ? dayText : `in ${dayText}`}.`,
    `Membership End Date: ${endDate}`,
    "Kindly renew your membership at your convenience.",
    "We hope you are having a productive and comfortable study experience.",
    "",
    "Thank you.",
    "",
    "This is an auto sent reminder text by the App."
  ].join("\n");
}

function openWhatsAppMessage(phoneRaw, message) {
  const digits = String(phoneRaw || "").replace(/\D/g, "");
  if (!digits) throw new Error("Invalid phone number");
  const phone = digits.length === 10 ? `91${digits}` : digits;
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function escAttr(value) {
  return String(value || "").replace(/"/g, "&quot;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function renderStats(stats) {
  const fixedCards = [
    ["Total Seats", stats.totalSeats],
    ["Occupied", stats.occupiedSeats],
    ["Vacant", stats.vacantSeats],
    ["Active Students", stats.activeStudents]
  ];

  const fixedHtml = fixedCards
    .map(
      ([label, value]) => `
      <article class="stat">
        <h3>${label}</h3>
        <p>${value}</p>
      </article>
    `
    )
    .join("");

  const currentRevenueCard = `
    <article class="stat">
      <h3>${stats.currentMonthLabel}</h3>
      <p>Rs ${INR.format(stats.currentMonthRevenue)}</p>
      <button class="mini-btn" data-action="edit-revenue" data-month-key="${stats.currentMonthKey || ""}">Edit Revenue</button>
    </article>
  `;

  const previousRevenueCard = `
    <article class="stat">
      <h3>${stats.previousMonthLabel}</h3>
      <p>Rs ${INR.format(stats.previousMonthRevenue)}</p>
      <button class="mini-btn" data-action="edit-revenue" data-month-key="${stats.previousMonthKey || ""}">Edit Revenue</button>
    </article>
  `;

  statsEl.innerHTML = fixedHtml + currentRevenueCard + previousRevenueCard;
}

function renderSeatLayout(seats) {
  const seatMap = new Map(seats.map((s) => [Number(s.id), s]));
  const seatPos = new Map();

  // Left wall side seats (as sketched): 42..45
  [
    [42, 1, 1],
    [43, 2, 1],
    [44, 3, 1],
    [45, 4, 1]
  ].forEach(([id, row, col]) => seatPos.set(id, { row, col }));

  // Middle-left block right column: 35..26 (top to bottom)
  for (let i = 0; i < 10; i += 1) seatPos.set(35 - i, { row: 1 + i, col: 6 });
  // Middle-left block left column: 41..36 (top to bottom, 6 seats)
  for (let i = 0; i < 6; i += 1) seatPos.set(41 - i, { row: 1 + i, col: 5 });

  // Right block columns:
  // left column 25..16, right column 15..6 (top to bottom)
  for (let i = 0; i < 10; i += 1) {
    seatPos.set(25 - i, { row: 1 + i, col: 10 });
    seatPos.set(15 - i, { row: 1 + i, col: 11 });
  }

  const seatButtons = Array.from(seatPos.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([id, pos]) => {
      const seat = seatMap.get(id);
      if (!seat) return "";
      const firstName = String(seat.occupantName || "").trim().split(/\s+/)[0] || "Occupied";
      const tooltipAttr = seat.status === "occupied" ? `data-tooltip="${escAttr(firstName)}"` : "";
      return `<button
        class="seat ${seat.status} fp-seat"
        data-seat-id="${id}"
        data-status="${seat.status}"
        data-name="${seat.occupantName || ""}"
        ${tooltipAttr}
        style="grid-row:${pos.row};grid-column:${pos.col};"
      >${id}</button>`;
    })
    .join("");

  const frontRowButtons = [5, 4, 3, 2, 1]
    .map((id) => {
      const seat = seatMap.get(id);
      if (!seat) return "";
      const firstName = String(seat.occupantName || "").trim().split(/\s+/)[0] || "Occupied";
      const tooltipAttr = seat.status === "occupied" ? `data-tooltip="${escAttr(firstName)}"` : "";
      return `<button
        class="seat ${seat.status} fp-seat front-seat"
        data-seat-id="${id}"
        data-status="${seat.status}"
        data-name="${seat.occupantName || ""}"
        ${tooltipAttr}
      >${id}</button>`;
    })
    .join("");

  seatLayoutEl.innerHTML = `
    <div class="floor-plan">
      ${seatButtons}
      <div class="fp-front-row" style="grid-row:12;grid-column:1 / span 5;">
        ${frontRowButtons}
      </div>
    </div>
  `;
}

function renderStudents(students) {
  const createdTs = (s) =>
    new Date(s.createdAt || s.joinedAt || s.membershipStartDate || 0).getTime();

  const active = students
    .filter((s) => isStudentCurrentlyActive(s))
    .sort((a, b) => {
      const diff = createdTs(a) - createdTs(b);
      if (diff !== 0) return diff;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });

  studentsTableEl.innerHTML = active
    .map(
      (s) => `
      <tr>
        <td>${s.name}</td>
        <td>${s.phone}</td>
        <td>${s.seatId || "-"}</td>
        <td>
          <div class="date-edit">
            <input
              type="date"
              value="${toDateInputValue(s.membershipStartDate)}"
              data-start-input="${s.id}"
              data-original="${toDateInputValue(s.membershipStartDate)}"
            />
          </div>
        </td>
        <td>
          <div class="date-edit">
            <input
              type="date"
              value="${toDateInputValue(s.membershipEndDate)}"
              data-end-input="${s.id}"
              data-original="${toDateInputValue(s.membershipEndDate)}"
            />
          </div>
        </td>
        <td>${membershipAlertText(s)}</td>
        <td>
          <div class="amount-edit">
            <input type="number" min="1" step="1" value="${Number(s.amountPaid || 0)}" data-amount-input="${s.id}" />
            <button data-action="save-amount" data-id="${s.id}">Save Amount</button>
          </div>
        </td>
        <td>
          <div class="row-actions">
            <button class="save-dates-btn" data-action="save-dates" data-id="${s.id}">Save Dates</button>
            <button class="deactivate-btn" data-action="deactivate-student" data-id="${s.id}">Deactivate</button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");
}

function renderRecentEnded(students) {
  const recentEnded = students.filter(isRecentlyEnded).sort((a, b) => {
    const aTs = new Date(a.membershipEndDate || 0).getTime();
    const bTs = new Date(b.membershipEndDate || 0).getTime();
    return bTs - aTs;
  });

  if (!recentEnded.length) {
    recentEndedTableEl.innerHTML = `<tr><td colspan="4" class="small">No recently ended memberships.</td></tr>`;
    return;
  }

  recentEndedTableEl.innerHTML = recentEnded
    .map(
      (s) => `
      <tr>
        <td>${s.name}</td>
        <td>${s.phone}</td>
        <td>${fmtDate(s.membershipEndDate)}</td>
        <td>Rs ${INR.format(Number(s.amountPaid || 0))}</td>
      </tr>
    `
    )
    .join("");
}

function renderMembershipReminders(students) {
  const dueSoon = students
    .filter((s) => {
      if (!isStudentCurrentlyActive(s)) return false;
      const left = daysUntilEnd(s.membershipEndDate);
      if (left !== 1 && left !== 0) return false;
      const alreadySentForCurrentEnd =
        String(s.membershipReminderSentForEndDate || "") === String(s.membershipEndDate || "");
      return !alreadySentForCurrentEnd;
    })
    .sort((a, b) => {
      const aLeft = daysUntilEnd(a.membershipEndDate) ?? 99;
      const bLeft = daysUntilEnd(b.membershipEndDate) ?? 99;
      if (aLeft !== bLeft) return aLeft - bLeft;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

  if (!dueSoon.length) {
    membershipReminderQueueEl.innerHTML =
      `<p class="small">No reminders due. Students ending in 1 day or today will appear here.</p>`;
    return;
  }

  membershipReminderQueueEl.innerHTML = dueSoon
    .map((s) => {
      const left = daysUntilEnd(s.membershipEndDate);
      const alertText = left === 0 ? "Ends today" : "Ending in 1 day";
      return `
      <article class="queue-item">
        <strong>${s.name}</strong>
        <span class="small">${alertText} • Ends ${fmtDate(s.membershipEndDate)}</span>
        <div class="queue-actions">
          <button data-action="send-membership-reminder" data-id="${s.id}">Send Reminder</button>
        </div>
      </article>
    `;
    })
    .join("");
}

function renderReceiptQueue(queue, students) {
  const pending = queue.filter((q) => q.status === "pending");
  const studentById = new Map(students.map((s) => [s.id, s]));

  if (!pending.length) {
    receiptQueueEl.innerHTML = `<p class="small">No pending receipts. New enrollments/imports will appear here.</p>`;
    return;
  }

  receiptQueueEl.innerHTML = pending
    .map((q) => {
      const student = studentById.get(q.studentId);
      return `
      <article class="queue-item">
        <strong>${student?.name || "Unknown"} (${q.phone})</strong>
        <span class="small">Created ${fmtDate(q.createdAt)}</span>
        <div class="queue-actions">
          <button data-action="send" data-id="${q.id}">Send Receipt</button>
          <button data-action="skip" data-id="${q.id}">Skip</button>
        </div>
      </article>
    `;
    })
    .join("");
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  dashboardStudents = Array.isArray(data.students) ? data.students : [];
  renderStats(data.stats);
  renderSeatLayout(data.seats);
  renderStudents(data.students);
  renderRecentEnded(data.students);
  renderReceiptQueue(data.receiptQueue, data.students);
  renderMembershipReminders(data.students);
  sheetLinkEl.href = data.autoImport?.sheetUrl || "#";
  return data;
}

async function refresh({ withSync = true } = {}) {
  if (withSync) {
    const sync = await api("/api/sync/google-form", { method: "POST", body: "{}" });
    const msg = `Auto-sync: +${sync.createdCount} new, -${sync.deletedCount || 0} removed, ${sync.skippedCount} skipped`;
    syncStatusEl.textContent = msg;
  }
  await loadDashboard();
}

function openRevenueModal() {
  revenueModalEl.classList.remove("hidden");
  revenueModalEl.setAttribute("aria-hidden", "false");
}

function closeRevenueModal() {
  revenueModalEl.classList.add("hidden");
  revenueModalEl.setAttribute("aria-hidden", "true");
}

async function loadRevenueConfigModal(monthKey) {
  const query = monthKey ? `?monthKey=${encodeURIComponent(monthKey)}` : "";
  const data = await api(`/api/revenue/config${query}`);
  const studentById = new Map(dashboardStudents.map((s) => [String(s.id), s]));
  revenueConfigMonthKey = data.monthKey || monthKey || null;
  revenueModalTitleEl.textContent = `Edit ${data.monthLabel} Revenue`;
  if (!data.options.length) {
    saveRevenueConfigBtn.disabled = true;
    revenueOptionsEl.innerHTML = `<p class="small">No current-month payment entries found.</p>`;
    return;
  }
  saveRevenueConfigBtn.disabled = false;
  revenueOptionsEl.innerHTML = data.options
    .map(
      (o) => {
        const student = studentById.get(String(o.studentId || ""));
        const startDate = o.membershipStartDate || student?.membershipStartDate || null;
        const endDate = o.membershipEndDate || student?.membershipEndDate || null;
        return `
      <label class="rev-option">
        <input type="checkbox" data-revenue-key="${o.key}" ${o.included ? "checked" : ""} />
        <span>${o.studentName} (${fmtRange(startDate, endDate)}) - Rs ${INR.format(o.amount)}</span>
      </label>
    `;
      }
    )
    .join("");
}

async function saveRevenueConfig() {
  const includedRevenueKeys = Array.from(revenueOptionsEl.querySelectorAll("input[type='checkbox']:checked")).map(
    (el) => el.dataset.revenueKey
  );
  await api("/api/revenue/config", {
    method: "POST",
    body: JSON.stringify({ includedRevenueKeys, monthKey: revenueConfigMonthKey })
  });
}

async function saveRevenueConfigAndRefresh() {
  await saveRevenueConfig();
  await refresh({ withSync: false });
}

async function handleEnrollSubmit(event) {
  event.preventDefault();
  if (isEnrollSubmitting) return;
  isEnrollSubmitting = true;
  const form = event.currentTarget;

  const submitBtn = form.querySelector("button[type='submit']");
  const originalLabel = submitBtn?.textContent || "Create Enrollment";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";
  }

  const body = Object.fromEntries(new FormData(form).entries());
  body.amount = Number(body.amount);

  try {
    await api("/api/enroll", { method: "POST", body: JSON.stringify(body) });
    form.reset();
    await refresh({ withSync: false });
    alert("Enrollment created.");
  } catch (err) {
    alert(err?.message || "Could not create enrollment.");
  } finally {
    isEnrollSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }
}

async function handleSeatClick(event) {
  const seat = event.target.closest(".seat");
  if (!seat) return;

  const seatId = seat.dataset.seatId;
  const status = seat.dataset.status;

  try {
    if (status === "vacant") {
      const firstName = prompt(`Assign first name to Seat ${seatId}:`);
      if (!firstName) return;
      await api(`/api/seats/${seatId}/assign`, {
        method: "POST",
        body: JSON.stringify({ firstName })
      });
    } else {
      const name = seat.dataset.name || "this student";
      const ok = confirm(`Vacate Seat ${seatId} (${name})?`);
      if (!ok) return;
      await api(`/api/seats/${seatId}/vacate`, { method: "POST", body: "{}" });
    }

    await refresh({ withSync: false });
  } catch (err) {
    alert(err.message);
  }
}

async function handleReceiptAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  try {
    const result = await api(`/api/receipts/${id}/decision`, {
      method: "POST",
      body: JSON.stringify({ action })
    });

    if (action === "send" && result.whatsapp?.url) {
      window.open(result.whatsapp.url, "_blank", "noopener,noreferrer");
    }

    await refresh({ withSync: false });
  } catch (err) {
    alert(err.message);
  }
}

refreshBtn.addEventListener("click", async () => {
  refreshBtn.classList.add("flash-click-long");
  setTimeout(() => refreshBtn.classList.remove("flash-click-long"), 1000);
  try {
    await refresh({ withSync: true });
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("enrollForm").addEventListener("submit", handleEnrollSubmit);
seatLayoutEl.addEventListener("click", handleSeatClick);
receiptQueueEl.addEventListener("click", handleReceiptAction);
membershipReminderQueueEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-action='send-membership-reminder']");
  if (!btn) return;
  const studentId = btn.dataset.id;
  const student = dashboardStudents.find((s) => String(s.id) === String(studentId));
  if (!student) {
    alert("Student not found.");
    return;
  }

  try {
    openWhatsAppMessage(student.phone, makeMembershipReminderMessage(student));
    await api(`/api/students/${student.id}/membership-reminder`, { method: "POST", body: "{}" });
    await refresh({ withSync: false });
  } catch (err) {
    alert(err.message || "Could not open WhatsApp reminder.");
  }
});
statsEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-action='edit-revenue']");
  if (!btn) return;
  try {
    await loadRevenueConfigModal(btn.dataset.monthKey || null);
    openRevenueModal();
  } catch (err) {
    alert(err.message);
  }
});
document.addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  if (btn.id === "refreshBtn") return;
  btn.classList.add("flash-click");
  setTimeout(() => btn.classList.remove("flash-click"), 500);
});
studentsTableEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  const startInput = studentsTableEl.querySelector(`input[data-start-input='${id}']`);
  const endInput = studentsTableEl.querySelector(`input[data-end-input='${id}']`);

  const saveDatesIfChanged = async () => {
    const membershipStartDate = String(startInput?.value || "").trim();
    const membershipEndDate = String(endInput?.value || "").trim();
    const originalStart = String(startInput?.dataset.original || "");
    const originalEnd = String(endInput?.dataset.original || "");

    if (!membershipStartDate || !membershipEndDate) return false;
    if (membershipStartDate === originalStart && membershipEndDate === originalEnd) return false;

    await api(`/api/students/${id}/dates`, {
      method: "POST",
      body: JSON.stringify({ membershipStartDate, membershipEndDate })
    });
    return true;
  };

  if (action === "save-amount") {
    const input = studentsTableEl.querySelector(`input[data-amount-input='${id}']`);
    const amount = Number(input?.value || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Enter a valid amount.");
      return;
    }

    try {
      await saveDatesIfChanged();
      await api(`/api/students/${id}/amount`, {
        method: "POST",
        body: JSON.stringify({ amount })
      });
      await refresh({ withSync: false });
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  if (action === "save-dates") {
    if (!String(startInput?.value || "").trim() || !String(endInput?.value || "").trim()) {
      alert("Select both start and end dates.");
      return;
    }

    try {
      await saveDatesIfChanged();
      await refresh({ withSync: false });
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  if (action === "deactivate-student") {
    const ok = confirm("Deactivate this student? It will remove from Active Students.");
    if (!ok) return;

    try {
      await api(`/api/students/${id}/deactivate`, { method: "POST", body: "{}" });
      await refresh({ withSync: false });
    } catch (err) {
      alert(err.message);
    }
  }
});

closeRevenueModalBtn.addEventListener("click", closeRevenueModal);
revenueModalEl.addEventListener("click", (event) => {
  const closer = event.target.closest("[data-close='revenue-modal']");
  if (closer) closeRevenueModal();
});
saveRevenueConfigBtn.addEventListener("click", async () => {
  saveRevenueConfigBtn.disabled = true;
  const originalText = saveRevenueConfigBtn.textContent;
  saveRevenueConfigBtn.textContent = "Saving...";
  try {
    await saveRevenueConfigAndRefresh();
    await loadRevenueConfigModal(revenueConfigMonthKey);
  } catch (err) {
    alert(err.message);
  } finally {
    saveRevenueConfigBtn.disabled = false;
    saveRevenueConfigBtn.textContent = originalText;
  }
});

revenueOptionsEl.addEventListener("change", (event) => {
  const input = event.target.closest("input[type='checkbox'][data-revenue-key]");
  if (!input) return;

  if (revenueAutoSaveTimer) clearTimeout(revenueAutoSaveTimer);
  revenueAutoSaveTimer = setTimeout(async () => {
    if (revenueAutoSaveBusy) return;
    revenueAutoSaveBusy = true;
    const originalText = saveRevenueConfigBtn.textContent;
    saveRevenueConfigBtn.textContent = "Auto-saving...";
    saveRevenueConfigBtn.disabled = true;
    try {
      await saveRevenueConfigAndRefresh();
      await loadRevenueConfigModal(revenueConfigMonthKey);
    } catch (err) {
      alert(err.message || "Could not save revenue selection.");
    } finally {
      revenueAutoSaveBusy = false;
      saveRevenueConfigBtn.textContent = originalText;
      saveRevenueConfigBtn.disabled = false;
    }
  }, 200);
});

refresh({ withSync: true }).catch((err) => {
  statsEl.innerHTML = `<p class="error">Failed to load: ${err.message}</p>`;
});
