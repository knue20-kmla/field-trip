import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, EmailAuthProvider, onAuthStateChanged, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, reauthenticateWithCredential, updatePassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const approvalSteps = ["담임", "교무부장", "교감", "교장"];
const STAFF_DOMAIN = "staff.fieldtrip.local";   // 교직원 아이디 → 로그인용 이메일 (실제 메일이 아님)
const staffEmail = (id) => `${id}@${STAFF_DOMAIN}`;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const fields = {
  id: $("#record-id"), name: $("#student-name"), studentId: $("#student-id"), grade: $("#grade"),
  classroom: $("#classroom"), number: $("#number"), learningType: $("#learning-type"),
  startAt: $("#start-at"), endAt: $("#end-at"), leaveAt: $("#leave-at"), place: $("#place"),
  subject: $("#subject"), visitContact: $("#visit-contact"), studentPhone: $("#student-phone"),
  companionName: $("#companion-name"), relationship: $("#relationship"),
  companionPhone: $("#companion-phone"), note: $("#application-note"),
};
const reportFields = {
  recordId: $("#report-record"), actualTime: $("#actual-time"), changeReason: $("#change-reason"),
  reportText: $("#report-text"), evidencePhoto: $("#evidence-photo"),
};

/* ---------- 상태 ---------- */
let auth = null, db = null;
let myUid = null, myEmail = "", isAdmin = false;
let myStaff = null;            // 교직원이면 { id, name, step, canManage, mustChange }
let staffList = [];
let appConfig = null;
let recs = [];                 // 화면에 보이는 신청 (학생: 내 것, 담당자: 전체)
let apprById = new Map();      // 신청서 id -> {appRev, steps, rejected, note}
let loaded = false;
let unsubscribers = [];
let selectedAdminKey = null;
let currentFilter = "all";
let pendingPhoto = null;
const photoCache = new Map();
let reportFilledKey = "";
let busy = false;
let chain = Promise.resolve();

const emptyReport = () => ({ submitted: false, timeMatch: "match", actualTime: "", changeReason: "", reportText: "", hasPhoto: false, photoName: "", submittedAt: "" });
const keyOf = (r) => `${r.uid}/${r.id}`;

/* ---------- 공통 도우미 ---------- */
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2600);
}
function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function fmtDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(d);
}
function fmtDate(value) {
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  const wd = new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(d);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${wd}요일`;
}
function dateParts(value) {
  const blank = { year: "", month: "", day: "", weekday: "", hour: "" };
  if (!value) return blank;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return blank;
  return { year: String(d.getFullYear()), month: String(d.getMonth() + 1), day: String(d.getDate()),
    weekday: new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(d), hour: String(d.getHours()).padStart(2, "0") };
}
function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekdaysBetween(startValue, endValue) {
  if (!startValue || !endValue) return [];
  const start = new Date(startValue), end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= last) {
    if (cur.getDay() !== 0 && cur.getDay() !== 6) out.push(localDateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
function dailyPlansText(plans = []) {
  return plans.map((p) => `${fmtDate(p.date)}\n${p.plan}`).join("\n\n");
}
function safeName(s) { return String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40); }

/* ---------- 결재 상태 (담당자만 쓰는 approvals 문서 + 신청서 개정번호 rev) ---------- */
function apprOf(rec) {
  const item = apprById.get(rec.id);
  if (item && item.appRev === rec.rev) {
    return { steps: approvalSteps.map((n, i) => ({ ...(item.steps?.[i] ?? { approved: false, at: "" }), name: n })), rejected: !!item.rejected, note: item.note ?? "" };
  }
  return { steps: approvalSteps.map((name) => ({ name, approved: false, at: "" })), rejected: false, note: "" };
}
const isApproved = (rec) => { const a = apprOf(rec); return !a.rejected && a.steps.every((s) => s.approved); };
function statusLabel(rec) {
  if (apprOf(rec).rejected) return "반려";
  if (rec.report?.submitted) return "보고서 제출";
  if (isApproved(rec)) return "승인 완료";
  return "검토 중";
}
function statusClass(rec) {
  if (apprOf(rec).rejected) return "rejected";
  return isApproved(rec) ? "approved" : "review";
}
const myRecs = () => recs.filter((r) => r.uid === myUid);
const findRec = (uid, id) => recs.find((r) => r.uid === uid && r.id === id) ?? null;

/* ---------- 쓰기 (한 번에 하나씩) ---------- */
function enqueue(task) {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
}
function explainError(e) {
  const code = e?.code ?? "";
  if (code.includes("permission-denied")) return "저장 권한이 없습니다. 본인 신청서만, 결재 전에만 수정할 수 있고, 결재는 본인 단계만 처리할 수 있습니다.";
  if (code.includes("unavailable") || code.includes("deadline")) return "네트워크가 불안정합니다. 잠시 후 다시 시도해 주세요.";
  if (code.includes("resource-exhausted")) return "사용량 한도에 도달했습니다. 담당자에게 알려 주세요.";
  return "저장하지 못했습니다. 다시 시도해 주세요.";
}
async function guarded(button, task) {
  if (busy) return;
  busy = true; if (button) button.disabled = true;
  try { await enqueue(task); } catch (e) { console.error(e); toast(explainError(e)); }
  finally { busy = false; if (button) button.disabled = false; renderAll(); }
}

/* ---------- 신청서 폼 ---------- */
function renderDailyPlanInputs(existing = []) {
  const list = $("#daily-plan-list");
  const byDate = new Map(existing.map((i) => [i.date, i.plan]));
  const typed = new Map($$(".daily-plan-row").map((r) => [r.dataset.date, r.querySelector("textarea").value]));
  const dates = weekdaysBetween(fields.startAt.value, fields.endAt.value);
  if (!dates.length) {
    list.innerHTML = `<div class="empty-state">시작일시와 종료일시를 입력하면 평일 학습계획 입력란이 생성됩니다.</div>`;
    return;
  }
  list.innerHTML = dates.map((date) => `
    <div class="daily-plan-row" data-date="${date}">
      <div class="daily-plan-date">${escapeHtml(fmtDate(date))}</div>
      <textarea rows="3" required aria-label="${escapeHtml(fmtDate(date))} 학습계획" placeholder="해당 날짜의 학습계획을 입력하세요.">${escapeHtml(typed.get(date) ?? byDate.get(date) ?? "")}</textarea>
    </div>`).join("");
  applyAppLock();
}
function getApplicationFromForm() {
  const a = {};
  Object.entries(fields).forEach(([k, n]) => { if (k !== "id") a[k] = n.value.trim(); });
  a.dailyPlans = $$(".daily-plan-row").map((r) => ({ date: r.dataset.date, plan: r.querySelector("textarea").value.trim() }));
  return a;
}
function fillApplicationForm(rec) {
  fields.id.value = rec?.id ?? "";
  const a = rec?.application ?? {};
  Object.entries(fields).forEach(([k, n]) => { if (k !== "id") n.value = a[k] ?? ""; });
  if (!rec) { fields.learningType.value = "개인여행"; fields.relationship.value = "부모님"; }
  renderDailyPlanInputs(a.dailyPlans ?? []);
  applyAppLock();
}
function currentMine() { return fields.id.value ? findRec(myUid, fields.id.value) : null; }
function applyAppLock() {
  const rec = currentMine();
  const locked = Boolean(rec && isApproved(rec));
  const lock = $("#app-lock");
  const a = rec ? apprOf(rec) : null;
  let msg = "", cls = "notice";
  if (rec && locked) { msg = "결재가 모두 끝난 신청서는 수정할 수 없습니다."; cls = "notice ready"; }
  else if (a?.rejected) { msg = `반려되었습니다. 내용을 고쳐 다시 제출하세요.${a.note ? `\n담당자 메모: ${a.note}` : ""}`; cls = "notice danger"; }
  else if (rec) {
    const started = a.steps.some((s) => s.approved);
    msg = started
      ? "일부 결재가 진행 중입니다. 지금 수정해서 제출하면 결재가 처음부터 다시 진행됩니다."
      : "아직 승인 전이라 수정할 수 있습니다. 고친 뒤 '수정 내용 제출'을 누르세요.";
    if (a.note) msg += `\n담당자 메모: ${a.note}`;
    cls = started ? "notice" : "notice ready";
  }
  lock.hidden = !msg; lock.textContent = msg; lock.className = cls; lock.style.whiteSpace = "pre-wrap";
  $("#app-scroll").classList.toggle("form-disabled", locked);
  $$("#application-form input, #application-form select, #application-form textarea").forEach((n) => { if (n.type !== "hidden" && n.id !== "my-record") n.disabled = locked; });
  $("#submit-application").disabled = locked;
  $("#pdf-application").disabled = !locked;          // 최종 결재가 끝난 신청서만 PDF 저장
  $("#pdf-application").title = locked ? "" : "최종 결재가 끝나면 저장할 수 있습니다";
  $("#submit-application").textContent = rec ? "수정 내용 제출" : "신청서 제출";
  $("#delete-application").hidden = !rec || locked;
}
function renderMySelector() {
  const sel = $("#my-record");
  const mine = myRecs().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const want = fields.id.value;
  sel.innerHTML = `<option value="">새 신청서 작성</option>` + mine.map((r) =>
    `<option value="${r.id}">${escapeHtml(r.application.subject || "주제 없음")} · ${escapeHtml(statusLabel(r))}</option>`).join("");
  sel.value = mine.some((r) => r.id === want) ? want : "";
}

/* ---------- 결과보고서 폼 ---------- */
function renderReportSelector() {
  const approved = myRecs().filter(isApproved);
  const sel = reportFields.recordId;
  const prev = sel.value;
  sel.innerHTML = approved.length
    ? approved.map((r) => `<option value="${r.id}">${escapeHtml(r.application.subject || "주제 없음")} · ${escapeHtml(fmtDateTime(r.application.startAt))}</option>`).join("")
    : `<option value="">승인 완료된 신청서 없음</option>`;
  const chosen = approved.find((r) => r.id === prev) ?? approved[0] ?? null;
  sel.value = chosen?.id ?? "";
  const key = `${chosen?.id ?? ""}|${chosen?.report?.submittedAt ?? ""}`;
  if (key !== reportFilledKey) { reportFilledKey = key; pendingPhoto = null; fillReportForm(chosen); }
  setReportEnabled(Boolean(chosen));
}
function fillReportForm(rec) {
  const r = rec?.report ?? emptyReport();
  reportFields.actualTime.value = r.actualTime ?? "";
  reportFields.changeReason.value = r.changeReason ?? "";
  reportFields.reportText.value = r.reportText ?? "";
  reportFields.evidencePhoto.value = "";
  $$("input[name='time-match']").forEach((i) => { i.checked = i.value === (r.timeMatch ?? "match"); });
  showPhoto(rec);
}
async function showPhoto(rec) {
  const box = $("#photo-preview");
  if (pendingPhoto) { renderPhotoBox(box, pendingPhoto); return; }
  if (!rec || !rec.report?.hasPhoto) { box.hidden = true; box.innerHTML = ""; return; }
  const photo = await loadPhoto(rec);
  if (!pendingPhoto && reportFields.recordId.value === rec.id) renderPhotoBox(box, photo ?? { name: rec.report.photoName, data: "" });
}
function renderPhotoBox(box, p) {
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `${p.data ? `<img src="${p.data}" alt="첨부 사진 미리보기" />` : ""}<span>${escapeHtml(p.name || "첨부 사진")}</span>`;
}
async function loadPhoto(rec) {
  const k = keyOf(rec);
  if (photoCache.has(k)) return photoCache.get(k);
  try {
    const snap = await getDoc(doc(db, "photos", rec.id));
    if (!snap.exists()) return null;
    const v = { name: snap.data().name, data: snap.data().data };
    photoCache.set(k, v);
    return v;
  } catch (e) { return null; }
}
function setReportEnabled(enabled) {
  const lock = $("#report-lock");
  lock.textContent = enabled ? "승인 완료된 신청서입니다. 결과보고서를 작성할 수 있습니다." : "담당자 결재가 모두 완료된 신청서만 결과보고서를 작성할 수 있습니다.";
  lock.classList.toggle("ready", enabled);
  $("#report-scroll").classList.toggle("form-disabled", !enabled);
  $$("#report-form textarea, #report-form input[type='radio'], #report-form input[type='file'], #submit-report, #pdf-report, #excel-report").forEach((n) => { n.disabled = !enabled; });
  reportFields.recordId.disabled = !myRecs().some(isApproved);
}

/* ---------- 제출 ---------- */
async function submitApplication(event) {
  event.preventDefault();
  const app = getApplicationFromForm();
  if (new Date(app.endAt) < new Date(app.startAt)) return toast("종료 일시는 시작 일시 이후여야 합니다.");
  if (!app.dailyPlans.length) return toast("주말을 제외한 기간에 해당하는 학습계획 날짜가 없습니다.");
  if (app.dailyPlans.some((p) => !p.plan)) return toast("일별 학습계획을 모두 입력하세요.");
  const existing = currentMine();
  if (existing && isApproved(existing)) return toast("결재가 끝난 신청서는 수정할 수 없습니다.");
  await guarded($("#submit-application"), async () => {
    if (existing) {
      await updateDoc(doc(db, "applications", existing.id), { application: app, rev: existing.rev + 1, updatedAt: serverTimestamp() });
      toast("수정한 신청서를 제출했습니다. 결재가 다시 진행됩니다.");
    } else {
      const id = crypto.randomUUID();
      await setDoc(doc(db, "applications", id), {
        ownerUid: myUid, ownerEmail: myEmail, createdAt: new Date().toISOString(), rev: 1,
        application: app, report: emptyReport(), updatedAt: serverTimestamp(),
      });
      fields.id.value = id;
      toast("신청서를 제출했습니다.");
    }
  });
}
async function deleteApplication() {
  const rec = currentMine();
  if (!rec || isApproved(rec)) return;
  const btn = $("#delete-application");
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1"; btn.textContent = "한 번 더 누르면 삭제됩니다";
    setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "신청서 삭제"; }, 4000);
    return;
  }
  btn.dataset.confirm = ""; btn.textContent = "신청서 삭제";
  await guarded(btn, async () => {
    await deleteDoc(doc(db, "applications", rec.id));
    try { await deleteDoc(doc(db, "photos", rec.id)); } catch {}
    $("#application-form").reset(); fillApplicationForm(null);
    toast("신청서를 삭제했습니다.");
  });
}
async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  let scale = Math.min(1, 900 / Math.max(img.width, img.height));
  let data = "";
  for (let q = 0.78; ; q -= 0.1) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    data = c.toDataURL("image/jpeg", Math.max(q, 0.4));
    if (data.length < 300000 || scale < 0.3) break;
    if (q < 0.5) scale *= 0.8;
  }
  URL.revokeObjectURL(url);
  return { name: file.name, data };
}
async function submitReport(event) {
  event.preventDefault();
  const rec = findRec(myUid, reportFields.recordId.value);
  if (!rec || !isApproved(rec)) return toast("담당자 결재 완료 후 결과보고서를 제출할 수 있습니다.");
  if (!pendingPhoto && !rec.report?.hasPhoto) return toast("활동 인증 사진 1장을 첨부하세요.");
  const report = {
    submitted: true, timeMatch: $("input[name='time-match']:checked").value,
    actualTime: reportFields.actualTime.value.trim(), changeReason: reportFields.changeReason.value.trim(),
    reportText: reportFields.reportText.value.trim(), hasPhoto: true,
    photoName: pendingPhoto?.name ?? rec.report.photoName, submittedAt: new Date().toISOString(),
  };
  await guarded($("#submit-report"), async () => {
    if (pendingPhoto) {
      await setDoc(doc(db, "photos", rec.id), { ownerUid: myUid, name: pendingPhoto.name, data: pendingPhoto.data });
      photoCache.set(keyOf(rec), pendingPhoto);
      pendingPhoto = null;
    }
    await updateDoc(doc(db, "applications", rec.id), { report, updatedAt: serverTimestamp() });
    toast("결과보고서를 제출했습니다.");
  });
}

/* ---------- 담당자 화면 ---------- */
function filteredRecs() {
  return recs.filter((r) => {
    if (currentFilter === "all") return true;
    if (currentFilter === "approved") return isApproved(r);
    if (currentFilter === "rejected") return apprOf(r).rejected;
    return !apprOf(r).rejected && !isApproved(r);
  }).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
function renderRecords() {
  const list = $("#record-list");
  const items = filteredRecs();
  list.innerHTML = items.length ? items.map((r) => `
    <button class="record-item ${keyOf(r) === selectedAdminKey ? "active" : ""}" data-key="${escapeHtml(keyOf(r))}" type="button">
      <strong>${escapeHtml(r.application.name || "이름 없음")} · ${escapeHtml(r.application.subject || "주제 없음")}</strong>
      <span>${escapeHtml(r.application.grade || "-")}학년 ${escapeHtml(r.application.classroom || "-")}반 ${escapeHtml(r.application.number || "-")}번 · ${statusLabel(r)}</span>
    </button>`).join("")
    : `<div class="empty-state">${loaded ? "조건에 맞는 신청서가 없습니다. 학생이 제출하면 여기에 나타납니다." : "불러오는 중…"}</div>`;
}
function selectedAdminRec() { const [uid, id] = (selectedAdminKey || "/").split("/"); return findRec(uid, id); }
function renderDefinitionList(el, pairs) {
  el.innerHTML = pairs.map(([t, v]) => `<dt>${escapeHtml(t)}</dt><dd>${escapeHtml(v || "-")}</dd>`).join("");
}
function renderAdminDetail() {
  const rec = selectedAdminRec();
  $("#empty-detail").hidden = Boolean(rec);
  $("#admin-detail").hidden = !rec;
  if (!rec) return;
  const a = rec.application, appr = apprOf(rec), r = rec.report ?? emptyReport();
  $("#detail-title").textContent = `${a.name || "이름 없음"} 신청서`;
  $("#detail-meta").textContent = `${a.grade || "-"}학년 ${a.classroom || "-"}반 ${a.number || "-"}번 · ${fmtDateTime(a.startAt)} ~ ${fmtDateTime(a.endAt)}`;
  const badge = $("#detail-status");
  badge.textContent = statusLabel(rec); badge.className = `status-badge ${statusClass(rec)}`;
  if (document.activeElement !== $("#admin-note")) $("#admin-note").value = appr.note;
  $("#approval-grid").innerHTML = appr.steps.map((s, i) => `
    <div class="approval-step">
      <strong>${escapeHtml(approvalSteps[i])}${i === myStaff?.step ? " (나)" : ""}</strong>
      <p>${s.approved ? escapeHtml(fmtDateTime(s.at)) : "대기"}</p>
      <button class="${s.approved ? "secondary-button" : "primary-button"}" data-step="${i}" type="button" ${i === myStaff?.step ? "" : "disabled"}>${s.approved ? "승인 취소" : "승인"}</button>
    </div>`).join("");
  renderDefinitionList($("#application-detail"), [
    ["신청자", rec.ownerEmail], ["학습 형태", a.learningType], ["기간", `${fmtDateTime(a.startAt)} ~ ${fmtDateTime(a.endAt)}`],
    ["학교출발", fmtDateTime(a.leaveAt)], ["장소", a.place], ["주제", a.subject],
    ["동행자", `${a.companionName || ""} ${a.relationship ? `(${a.relationship})` : ""}`],
    ["연락처", `학생 ${a.studentPhone || "-"}\n동행자 ${a.companionPhone || "-"}\n방문처 ${a.visitContact || "-"}`],
    ["일별 계획", dailyPlansText(a.dailyPlans ?? [])], ["비고", a.note],
  ]);
  renderDefinitionList($("#report-detail"), [
    ["제출", r.submitted ? fmtDateTime(r.submittedAt) : "미제출"],
    ["일시 일치", r.timeMatch === "different" ? "일치하지 않습니다." : "일치합니다."],
    ["실제 시간", r.actualTime], ["변동 이유", r.changeReason], ["보고 내용", r.reportText], ["증빙 사진", r.photoName],
  ]);
  const img = $("#admin-photo");
  img.hidden = true;
  if (r.hasPhoto) loadPhoto(rec).then((p) => { if (p?.data && keyOf(rec) === selectedAdminKey) { img.src = p.data; img.hidden = false; } });
  // PDF는 최종 결재(4단계 모두 승인)가 끝난 뒤에만 저장할 수 있다.
  const done = isApproved(rec);
  $("#pdf-selected-app").disabled = !done;
  $("#pdf-selected-report").disabled = !done || !r.submitted;
  $("#pdf-hint").textContent = done ? "" : "PDF는 4단계 결재가 모두 끝난 뒤에 저장할 수 있습니다. 미리보기는 언제든 볼 수 있습니다.";
}
async function saveApproval(rec, patch) {
  const cur = apprOf(rec);
  await setDoc(doc(db, "approvals", rec.id), {
    ownerUid: rec.uid, appRev: rec.rev, steps: patch.steps ?? cur.steps,
    rejected: patch.rejected ?? cur.rejected, note: patch.note ?? cur.note, updatedAt: serverTimestamp(),
  });
}
async function toggleApproval(index) {
  const rec = selectedAdminRec(); if (!rec) return;
  if (index !== myStaff?.step) return toast(`${approvalSteps[index]} 단계는 해당 담당자만 처리할 수 있습니다.`);
  const steps = apprOf(rec).steps.map((s) => ({ ...s }));
  const s = steps[index];
  s.approved = !s.approved; s.at = s.approved ? new Date().toISOString() : "";
  await guarded(null, async () => { await saveApproval(rec, { steps, rejected: false }); toast(`${s.name} ${s.approved ? "승인" : "승인 취소"} 처리했습니다.`); });
}
async function rejectRecord() {
  const rec = selectedAdminRec(); if (!rec) return;
  await guarded($("#reject-record"), async () => { await saveApproval(rec, { rejected: true, note: $("#admin-note").value.trim() }); toast("반려 처리했습니다."); });
}
async function saveNote() {
  const rec = selectedAdminRec(); if (!rec) return;
  await guarded($("#save-note"), async () => { await saveApproval(rec, { note: $("#admin-note").value.trim() }); toast("검토 메모를 저장했습니다."); });
}

/* ---------- 현황 ---------- */
function syncStats() {
  $("#stat-total").textContent = recs.length;
  $("#stat-review").textContent = recs.filter((r) => !apprOf(r).rejected && !isApproved(r)).length;
  $("#stat-approved").textContent = recs.filter(isApproved).length;
  $("#stat-report").textContent = recs.filter((r) => r.report?.submitted).length;
}
function renderAll() {
  syncStats();
  renderMySelector();
  renderReportSelector();
  applyAppLock();
  if (isAdmin) { renderRecords(); renderAdminDetail(); }
}

/* ---------- 인쇄용 양식 → PDF ---------- */
const paperHead = () => `<div class="paper-head"><img src="./logo.png" alt=""><div><strong>민족사관고등학교</strong><span>Korean Minjok Leadership Academy</span></div></div>`;
function applicationHtml(app) {
  const s = dateParts(app.startAt), e = dateParts(app.endAt), l = dateParts(app.leaveAt);
  const sign = `${new Date().getFullYear()}년&nbsp;&nbsp;&nbsp;&nbsp;월&nbsp;&nbsp;&nbsp;&nbsp;일&nbsp;&nbsp;&nbsp;&nbsp;어드바이저/지도교사 : &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(인)`;
  return `<article class="print-form">${paperHead()}<h1>교외체험학습 신청서</h1><table>
    <tr><th>이름</th><td colspan="3">${escapeHtml(app.name)}</td><th>학번</th><td colspan="3">${escapeHtml(app.studentId)}</td></tr>
    <tr><th>학년/반</th><td colspan="3">${escapeHtml(app.grade)}학년 ${escapeHtml(app.classroom)}반 ${escapeHtml(app.number)}번</td><th>학습 형태</th><td colspan="3">${escapeHtml(app.learningType)}</td></tr>
    <tr><th>시작 일시</th><td colspan="7">${s.year}년 ${s.month}월 ${s.day}일 ${s.weekday}요일 ${s.hour}시 부터</td></tr>
    <tr><th>종료 일시</th><td colspan="7">${e.year}년 ${e.month}월 ${e.day}일 ${e.weekday}요일 ${e.hour}시 까지</td></tr>
    <tr><th>학교출발시각</th><td colspan="7">${l.year ? `${l.year}년 ${l.month}월 ${l.day}일 ${l.weekday}요일 ${l.hour}시 부터 외출 예정` : ""}</td></tr>
    <tr><th>주제</th><td colspan="7">${escapeHtml(app.subject)}</td></tr>
    <tr><th>활동 장소</th><td colspan="7">${escapeHtml(app.place)}</td></tr>
    <tr><th>동행자명</th><td>${escapeHtml(app.companionName)}</td><th>관계</th><td>${escapeHtml(app.relationship)}</td><th>비고</th><td colspan="3">${escapeHtml(app.note)}</td></tr>
    <tr><th>연락처</th><td colspan="2">학생 ${escapeHtml(app.studentPhone)}</td><td colspan="2">동행자 ${escapeHtml(app.companionPhone)}</td><td colspan="3">방문처 ${escapeHtml(app.visitContact)}</td></tr>
    <tr><th>학습계획</th><td class="print-large" colspan="7">${escapeHtml(dailyPlansText(app.dailyPlans ?? []))}</td></tr>
    <tr><th>확인</th><td colspan="7">${sign}</td></tr></table></article>`;
}
function reportHtml(app, report, photo) {
  const s = dateParts(app.startAt), e = dateParts(app.endAt);
  const sign = `${new Date().getFullYear()}년&nbsp;&nbsp;&nbsp;&nbsp;월&nbsp;&nbsp;&nbsp;&nbsp;일&nbsp;&nbsp;&nbsp;&nbsp;어드바이저/지도교사 : &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(인)`;
  return `<article class="print-form">${paperHead()}<h1>교외체험학습 결과 보고서</h1><table>
    <tr><th>이름</th><td colspan="3">${escapeHtml(app.name)}</td><th>학번</th><td colspan="3">${escapeHtml(app.studentId)}</td></tr>
    <tr><th>학년/반</th><td colspan="7">${escapeHtml(app.grade)}학년 ${escapeHtml(app.classroom)}반 ${escapeHtml(app.number)}번</td></tr>
    <tr><th>시작 일시</th><td colspan="7">${s.year}년 ${s.month}월 ${s.day}일 ${s.weekday}요일 ${s.hour}시 부터</td></tr>
    <tr><th>종료 일시</th><td colspan="7">${e.year}년 ${e.month}월 ${e.day}일 ${e.weekday}요일 ${e.hour}시 까지</td></tr>
    <tr><th>신청서 일시</th><td colspan="7">${report.timeMatch === "different" ? "일치하지 않습니다." : "일치합니다."}</td></tr>
    <tr><th>실제 활동 시간</th><td colspan="7">${escapeHtml(report.actualTime)}</td></tr>
    <tr><th>변동 이유</th><td colspan="7">${escapeHtml(report.changeReason)}</td></tr>
    <tr><th>체험학습 결과보고란</th><td class="print-large" colspan="7">${escapeHtml(report.reportText)}</td></tr>
    <tr><th>활동인증 사진</th><td colspan="7">${photo?.data ? `<img src="${photo.data}" alt="활동 인증 사진" style="max-width:220px;max-height:170px;display:block;margin-bottom:6px;">` : ""}${escapeHtml(photo?.name || report.photoName)}</td></tr>
    <tr><th>확인</th><td colspan="7">${sign}</td></tr></table></article>`;
}
async function htmlToPdf(html) {
  const host = $("#print-sheet");
  host.innerHTML = html;
  if (document.fonts?.ready) await document.fonts.ready;
  await Promise.all(Array.from(host.querySelectorAll("img")).map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })));
  const canvas = await html2canvas(host, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
  host.innerHTML = "";
  const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
  const margin = 10, w = 210 - margin * 2, pageH = 297 - margin * 2;
  const sliceH = Math.floor(pageH * canvas.width / w);
  for (let y = 0, page = 0; y < canvas.height; y += sliceH, page++) {
    const h = Math.min(sliceH, canvas.height - y);
    const part = document.createElement("canvas");
    part.width = canvas.width; part.height = h;
    part.getContext("2d").drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    if (page) pdf.addPage();
    pdf.addImage(part.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, w, h * w / canvas.width);
  }
  return pdf.output("arraybuffer");
}

/* ---------- 엑셀 ---------- */
function sheetFromRows(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  ws["!merges"] = rows.flatMap((r, i) => r.length === 1 ? [{ s: { r: i, c: 0 }, e: { r: i, c: 3 } }] : r.length === 2 ? [{ s: { r: i, c: 1 }, e: { r: i, c: 3 } }] : []);
  return ws;
}
function workbookBuffer(sheetName, ws) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}
function applicationRows(a) {
  return [["교외체험학습 신청서"], [],
    ["이름", a.name, "학번", a.studentId],
    ["학년/반/번호", `${a.grade}학년 ${a.classroom}반 ${a.number}번`, "학습 형태", a.learningType],
    ["시작 일시", fmtDateTime(a.startAt)], ["종료 일시", fmtDateTime(a.endAt)], ["학교출발시각", fmtDateTime(a.leaveAt)],
    ["주제", a.subject], ["활동 장소", a.place],
    ["동행자명", a.companionName, "관계", a.relationship],
    ["학생 연락처", a.studentPhone, "동행자 연락처", a.companionPhone],
    ["방문처", a.visitContact], ["비고", a.note], [],
    ["날짜별 학습계획"], ...(a.dailyPlans ?? []).map((p) => [fmtDate(p.date), p.plan])];
}
function reportRows(a, r) {
  return [["교외체험학습 결과 보고서"], [],
    ["이름", a.name, "학번", a.studentId],
    ["학년/반/번호", `${a.grade}학년 ${a.classroom}반 ${a.number}번`],
    ["신청 일시", `${fmtDateTime(a.startAt)} ~ ${fmtDateTime(a.endAt)}`],
    ["신청서와 일시", r.timeMatch === "different" ? "일치하지 않습니다." : "일치합니다."],
    ["실제 활동 시간", r.actualTime], ["변동 이유", r.changeReason], ["결과보고", r.reportText], ["증빙 사진", r.photoName]];
}
function listRows() {
  const head = ["이름", "학번", "학년", "반", "번호", "학습 형태", "시작", "종료", "장소", "주제", "동행자", "관계", "결재 상태", "결재 완료 단계", "보고서 제출", "보고서 제출일"];
  const body = filteredRecs().map((r) => {
    const a = r.application, ap = apprOf(r);
    return [a.name, a.studentId, a.grade, a.classroom, a.number, a.learningType, fmtDateTime(a.startAt), fmtDateTime(a.endAt), a.place, a.subject,
      a.companionName, a.relationship, statusLabel(r), ap.steps.filter((s) => s.approved).map((s) => s.name).join(", "),
      r.report?.submitted ? "제출" : "미제출", r.report?.submitted ? fmtDateTime(r.report.submittedAt) : ""];
  });
  return [head, ...body];
}

/* ---------- 파일 저장 (브라우저 다운로드) ---------- */
function saveFile(filename, data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("파일을 저장했습니다.");
}
async function withButton(btn, task) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "만드는 중…";
  try { await task(); } catch (e) { console.error(e); toast("파일을 만들지 못했습니다."); }
  finally { btn.textContent = label; btn.disabled = false; }
}
const dateTag = () => new Date().toISOString().slice(0, 10);
function reportFromForm(rec) {
  return { ...(rec?.report ?? emptyReport()), timeMatch: $("input[name='time-match']:checked")?.value ?? "match",
    actualTime: reportFields.actualTime.value.trim(), changeReason: reportFields.changeReason.value.trim(), reportText: reportFields.reportText.value.trim() };
}
function bindExport(btn, make) { btn.addEventListener("click", () => withButton(btn, async () => { const r = await make(); if (r) saveFile(r.name, r.data); })); }

bindExport($("#pdf-application"), async () => {
  const rec = currentMine();
  if (!rec || !isApproved(rec)) { toast("최종 결재가 끝난 뒤에 PDF로 저장할 수 있습니다."); return null; }
  return { name: `신청서_${safeName(rec.application.name)}_${dateTag()}.pdf`, data: await htmlToPdf(applicationHtml(rec.application)) };
});
bindExport($("#excel-application"), async () => { const a = getApplicationFromForm(); return { name: `신청서_${safeName(a.name)}_${dateTag()}.xlsx`, data: workbookBuffer("신청서", sheetFromRows(applicationRows(a), [16, 36, 16, 30])) }; });
bindExport($("#pdf-report"), async () => {
  const rec = findRec(myUid, reportFields.recordId.value); if (!rec) return null;
  const photo = pendingPhoto ?? await loadPhoto(rec);
  return { name: `결과보고서_${safeName(rec.application.name)}_${dateTag()}.pdf`, data: await htmlToPdf(reportHtml(rec.application, reportFromForm(rec), photo)) };
});
bindExport($("#excel-report"), async () => {
  const rec = findRec(myUid, reportFields.recordId.value); if (!rec) return null;
  const r = reportFromForm(rec);
  return { name: `결과보고서_${safeName(rec.application.name)}_${dateTag()}.xlsx`, data: workbookBuffer("결과보고서", sheetFromRows(reportRows(rec.application, { ...r, photoName: pendingPhoto?.name ?? r.photoName }), [16, 36, 16, 30])) };
});
bindExport($("#pdf-selected-app"), async () => {
  const r = selectedAdminRec(); if (!r) return null;
  if (!isApproved(r)) { toast("최종 결재가 끝난 뒤에 PDF로 저장할 수 있습니다."); return null; }
  return { name: `신청서_${safeName(r.application.name)}_${dateTag()}.pdf`, data: await htmlToPdf(applicationHtml(r.application)) };
});
bindExport($("#excel-selected-app"), async () => { const r = selectedAdminRec(); return r && { name: `신청서_${safeName(r.application.name)}_${dateTag()}.xlsx`, data: workbookBuffer("신청서", sheetFromRows(applicationRows(r.application), [16, 36, 16, 30])) }; });
bindExport($("#pdf-selected-report"), async () => {
  const r = selectedAdminRec(); if (!r) return null;
  if (!isApproved(r)) { toast("최종 결재가 끝난 뒤에 PDF로 저장할 수 있습니다."); return null; }
  if (!r.report?.submitted) { toast("아직 결과보고서가 제출되지 않았습니다."); return null; }
  return { name: `결과보고서_${safeName(r.application.name)}_${dateTag()}.pdf`, data: await htmlToPdf(reportHtml(r.application, r.report, await loadPhoto(r))) };
});
bindExport($("#excel-selected-report"), async () => {
  const r = selectedAdminRec(); if (!r) return null;
  if (!r.report?.submitted) { toast("아직 결과보고서가 제출되지 않았습니다."); return null; }
  return { name: `결과보고서_${safeName(r.application.name)}_${dateTag()}.xlsx`, data: workbookBuffer("결과보고서", sheetFromRows(reportRows(r.application, r.report), [16, 36, 16, 30])) };
});
bindExport($("#export-all"), async () => {
  const ws = XLSX.utils.aoa_to_sheet(listRows());
  ws["!cols"] = [10, 12, 6, 6, 6, 12, 20, 20, 24, 28, 12, 10, 12, 30, 12, 20].map((wch) => ({ wch }));
  return { name: `체험학습_접수현황_${dateTag()}.xlsx`, data: workbookBuffer("접수현황", ws) };
});

/* ---------- 이벤트 ---------- */
$$("#role-switch .role-button").forEach((b) => b.addEventListener("click", () => {
  $$("#role-switch .role-button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `${b.dataset.view}-view`));
}));
$$(".filter").forEach((b) => b.addEventListener("click", () => {
  currentFilter = b.dataset.filter;
  $$(".filter").forEach((x) => x.classList.toggle("active", x === b));
  renderRecords();
}));
$("#record-list").addEventListener("click", (e) => {
  const b = e.target.closest(".record-item"); if (!b) return;
  selectedAdminKey = b.dataset.key; renderRecords(); renderAdminDetail();
});
$("#approval-grid").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-step]"); if (b) toggleApproval(Number(b.dataset.step));
});
$("#application-form").addEventListener("submit", submitApplication);
$("#report-form").addEventListener("submit", submitReport);
fields.startAt.addEventListener("change", () => renderDailyPlanInputs());
fields.endAt.addEventListener("change", () => renderDailyPlanInputs());
$("#new-application").addEventListener("click", () => { $("#application-form").reset(); fillApplicationForm(null); renderMySelector(); });
$("#delete-application").addEventListener("click", deleteApplication);
$("#my-record").addEventListener("change", (e) => { fillApplicationForm(e.target.value ? findRec(myUid, e.target.value) : null); });
reportFields.recordId.addEventListener("change", () => { reportFilledKey = ""; renderReportSelector(); });
reportFields.evidencePhoto.addEventListener("change", async () => {
  const file = reportFields.evidencePhoto.files[0];
  if (!file) return;
  try { pendingPhoto = await resizePhoto(file); renderPhotoBox($("#photo-preview"), pendingPhoto); }
  catch { toast("사진을 읽지 못했습니다. 다른 사진을 선택하세요."); }
});
function openPreview(title, html) {
  $("#preview-title").textContent = title;
  $("#preview-body").innerHTML = html;
  $("#preview-modal").hidden = false;
  $("#preview-modal .modal-card").scrollTop = 0;
}
$("#preview-app").addEventListener("click", () => {
  const r = selectedAdminRec(); if (!r) return;
  openPreview(`${r.application.name || ""} 신청서 미리보기`, applicationHtml(r.application));
});
$("#preview-report").addEventListener("click", async () => {
  const r = selectedAdminRec(); if (!r) return;
  if (!r.report?.submitted) return toast("아직 결과보고서가 제출되지 않았습니다.");
  openPreview(`${r.application.name || ""} 결과보고서 미리보기`, reportHtml(r.application, r.report, await loadPhoto(r)));
});
$("#preview-close").addEventListener("click", () => { $("#preview-modal").hidden = true; });
$("#preview-modal").addEventListener("click", (e) => { if (e.target.id === "preview-modal") $("#preview-modal").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#preview-modal").hidden = true; });
$("#save-note").addEventListener("click", saveNote);
$("#reject-record").addEventListener("click", rejectRecord);


/* ---------- 로그인과 시작 ---------- */
function showBanner(text) { const b = $("#banner"); b.hidden = !text; b.textContent = text || ""; }
function authErrorText(e) {
  const c = e?.code ?? "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") || c.includes("invalid-email")) return "아이디 또는 비밀번호가 올바르지 않습니다.";
  if (c.includes("too-many-requests")) return "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (c.includes("weak-password")) return "비밀번호는 8자 이상이어야 합니다.";
  if (c.includes("email-already-in-use")) return "이미 사용 중인 아이디입니다. (삭제한 아이디는 Firebase 콘솔에서 사용자도 지워야 다시 쓸 수 있습니다.)";
  if (c.includes("requires-recent-login")) return "보안을 위해 다시 로그인한 뒤 시도해 주세요.";
  if (c.includes("network")) return "네트워크 연결을 확인해 주세요.";
  return "처리하지 못했습니다. 다시 시도해 주세요.";
}
function setView(name) {
  $$("#role-switch .role-button").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `${name}-view`));
}
function showSignedOut(message = "") {
  unsubscribers.forEach((u) => u()); unsubscribers = [];
  recs = []; apprById = new Map(); staffList = []; loaded = false; myUid = null; isAdmin = false; myStaff = null;
  $("#pw-modal").hidden = true;
  $("#login-view").hidden = false; $("#app-shell").hidden = true; $("#user-box").hidden = true;
  $("#login-error").textContent = message;
}
function ingestRecords(snap) {
  recs = snap.docs.map((d) => {
    const it = d.data();
    return { id: d.id, uid: it.ownerUid, ownerEmail: it.ownerEmail ?? "", createdAt: it.createdAt ?? "", rev: it.rev ?? 1,
      application: it.application ?? {}, report: { ...emptyReport(), ...(it.report ?? {}) } };
  });
  loaded = true;
}

/* 비밀번호 변경 */
let pwForced = false;
function openPasswordModal(forced = false) {
  pwForced = forced;
  $("#pw-form").reset(); $("#pw-error").textContent = "";
  $("#pw-note").textContent = forced ? "처음 로그인했습니다. 임시 비밀번호를 본인만 아는 비밀번호로 바꿔 주세요." : "현재 비밀번호를 한 번 더 입력하고 새 비밀번호를 정하세요.";
  $("#pw-cancel").hidden = forced;
  $("#pw-modal").hidden = false;
  $("#pw-current").focus();
}
async function submitPassword(event) {
  event.preventDefault();
  const cur = $("#pw-current").value, nw = $("#pw-new").value, nw2 = $("#pw-new2").value;
  const err = $("#pw-error");
  if (nw.length < 8) { err.textContent = "새 비밀번호는 8자 이상이어야 합니다."; return; }
  if (nw !== nw2) { err.textContent = "새 비밀번호 확인이 일치하지 않습니다."; return; }
  if (nw === cur) { err.textContent = "현재 비밀번호와 다른 비밀번호를 입력하세요."; return; }
  const btn = $("#pw-save"); btn.disabled = true;
  try {
    const user = auth.currentUser;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur));
    await updatePassword(user, nw);
    if (myStaff?.mustChange) { await updateDoc(doc(db, "staff", myUid), { mustChange: false }); myStaff.mustChange = false; }
    $("#pw-modal").hidden = true;
    toast("비밀번호를 변경했습니다.");
  } catch (e) { console.error(e); err.textContent = authErrorText(e); }
  finally { btn.disabled = false; }
}

/* 교직원 계정 관리 (관리 권한이 있는 사람만) */
function renderStaffList() {
  const list = $("#staff-list");
  list.innerHTML = staffList.length ? staffList.map((s) => `
    <div class="staff-item">
      <div><strong>${escapeHtml(s.name)} · ${escapeHtml(approvalSteps[s.step] ?? "")}</strong>
        <span>아이디 ${escapeHtml(s.id)}${s.canManage ? " · 계정 관리 권한" : ""}${s.mustChange ? " · 비밀번호 변경 전" : ""}</span></div>
      ${s.uid === myUid ? "" : `<button class="ghost-button" data-del="${escapeHtml(s.uid)}" type="button">삭제</button>`}
    </div>`).join("") : `<div class="empty-state">등록된 교직원이 없습니다.</div>`;
}
async function createAccount(event) {
  event.preventDefault();
  const id = $("#acc-id").value.trim().toLowerCase(), name = $("#acc-name").value.trim();
  const pw = $("#acc-password").value, step = Number($("#acc-step").value);
  if (!/^[a-z0-9._-]{4,20}$/.test(id)) return toast("아이디는 영문 소문자, 숫자, . _ - 로 4~20자여야 합니다.");
  if (pw.length < 8) return toast("임시 비밀번호는 8자 이상이어야 합니다.");
  const btn = $("#create-account"); btn.disabled = true;
  try {
    // 현재 로그인(관리자)을 유지한 채 새 계정을 만들기 위해 별도 앱 인스턴스를 쓴다.
    const secondary = initializeApp(appConfig, `secondary-${Date.now()}`);
    const sAuth = getAuth(secondary);
    const cred = await createUserWithEmailAndPassword(sAuth, staffEmail(id), pw);
    try {
      await setDoc(doc(db, "staff", cred.user.uid), { id, name, step, canManage: $("#acc-manage").checked, mustChange: true, createdAt: new Date().toISOString() });
    } catch (e) {
      await signOut(sAuth);
      throw Object.assign(new Error("staff-doc"), { code: "staff-doc" });
    }
    await signOut(sAuth);
    $("#account-form").reset();
    toast(`${name} 선생님 계정을 만들었습니다.`);
  } catch (e) {
    console.error(e);
    toast(e.code === "staff-doc" ? "계정은 만들어졌지만 교직원 등록에 실패했습니다. 같은 아이디를 Firebase 콘솔에서 삭제한 뒤 다시 만드세요." : authErrorText(e));
  } finally { btn.disabled = false; }
}
async function deleteStaff(uid, button) {
  if (button.dataset.confirm !== "1") {
    button.dataset.confirm = "1"; button.textContent = "한 번 더 누르면 삭제";
    setTimeout(() => { button.dataset.confirm = ""; button.textContent = "삭제"; }, 4000);
    return;
  }
  try { await deleteDoc(doc(db, "staff", uid)); toast("교직원 등록을 삭제했습니다. 이 계정은 더 이상 결재할 수 없습니다."); }
  catch (e) { console.error(e); toast(explainError(e)); }
}

async function enterApp(user) {
  myUid = user.uid;
  const isPasswordUser = user.providerData.some((p) => p.providerId === "password");
  if (isPasswordUser) {
    let snap = null;
    try { snap = await getDoc(doc(db, "staff", myUid)); } catch (e) { console.error(e); }
    if (!snap?.exists()) { await signOut(auth); showSignedOut("교직원으로 등록되지 않은 계정입니다. 담당자에게 문의하세요."); return; }
    myStaff = snap.data(); myEmail = ""; isAdmin = true;
  } else {
    myStaff = null; myEmail = user.email ?? ""; isAdmin = false;
  }
  $("#login-view").hidden = true; $("#app-shell").hidden = false; $("#user-box").hidden = false;
  const displayName = myStaff ? myStaff.name : (user.displayName || myEmail.split("@")[0]);
  $("#user-name").textContent = displayName;
  $("#user-role").textContent = myStaff ? approvalSteps[myStaff.step] : "학생";
  $("#user-avatar").textContent = (displayName || "?").trim().slice(0, 1).toUpperCase();
  $('#role-switch [data-view="application"]').hidden = Boolean(myStaff);
  $('#role-switch [data-view="report"]').hidden = Boolean(myStaff);
  $('#role-switch [data-view="admin"]').hidden = !myStaff;
  $('#role-switch [data-view="accounts"]').hidden = !myStaff?.canManage;
  $("#change-password").hidden = !myStaff;
  showBanner("");
  setView(myStaff ? "admin" : "application");
  const apps = collection(db, "applications"), appr = collection(db, "approvals");
  const watch = (ref, fn) => onSnapshot(ref, fn, (e) => { console.error(e); showBanner("내용을 불러오지 못했습니다. 페이지를 새로고침하세요."); });
  unsubscribers.push(
    watch(isAdmin ? apps : query(apps, where("ownerUid", "==", myUid)), (snap) => { ingestRecords(snap); renderAll(); }),
    watch(isAdmin ? appr : query(appr, where("ownerUid", "==", myUid)), (snap) => {
      apprById = new Map(snap.docs.map((d) => [d.id, d.data()])); renderAll();
    }),
  );
  if (myStaff?.canManage) {
    unsubscribers.push(watch(collection(db, "staff"), (snap) => {
      staffList = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => a.step - b.step || String(a.name).localeCompare(String(b.name), "ko"));
      renderStaffList();
    }));
  }
  fillApplicationForm(null);
  renderAll();
  if (myStaff?.mustChange) openPasswordModal(true);
}

function start() {
  $$("#login-tabs [data-login]").forEach((b) => b.addEventListener("click", () => {
    $$("#login-tabs [data-login]").forEach((x) => x.classList.toggle("active", x === b));
    $("#login-student").hidden = b.dataset.login !== "student";
    $("#login-staff").hidden = b.dataset.login !== "staff";
    $("#login-error").textContent = "";
  }));
  if (!firebaseConfig?.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
    $("#login-error").textContent = "firebase-config.js에 Firebase 설정이 아직 입력되지 않았습니다. README.md의 설정 순서를 따라 주세요.";
    $("#sign-in").disabled = true; $("#staff-sign-in").disabled = true;
    return;
  }
  appConfig = firebaseConfig;
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getFirestore(app);
  $("#sign-in").addEventListener("click", async () => {
    $("#login-error").textContent = "";
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { if (e?.code !== "auth/popup-closed-by-user") $("#login-error").textContent = "로그인하지 못했습니다. 팝업 차단을 해제하고 다시 시도해 주세요."; }
  });
  $("#login-staff").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#login-error").textContent = "";
    const id = $("#staff-id").value.trim().toLowerCase();
    const btn = $("#staff-sign-in"); btn.disabled = true;
    try { await signInWithEmailAndPassword(auth, staffEmail(id), $("#staff-password").value); $("#staff-password").value = ""; }
    catch (e) { $("#login-error").textContent = authErrorText(e); }
    finally { btn.disabled = false; }
  });
  $("#sign-out").addEventListener("click", () => signOut(auth));
  $("#change-password").addEventListener("click", () => openPasswordModal(false));
  $("#pw-form").addEventListener("submit", submitPassword);
  $("#pw-cancel").addEventListener("click", () => { if (!pwForced) $("#pw-modal").hidden = true; });
  $("#account-form").addEventListener("submit", createAccount);
  $("#staff-list").addEventListener("click", (e) => { const b = e.target.closest("button[data-del]"); if (b) deleteStaff(b.dataset.del, b); });
  onAuthStateChanged(auth, (user) => { if (user) enterApp(user); else showSignedOut(); });
}
start();
