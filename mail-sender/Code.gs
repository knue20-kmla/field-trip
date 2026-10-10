/**
 * 교외체험학습 신청 관리 - 학생 안내 메일 발송 (Google Apps Script 웹 앱)
 *
 * 담임이 신청서/결과보고서를 승인하거나 반려하면 웹 앱(app.js)이 이 스크립트를 호출한다.
 * 받는 사람과 메일 내용은 요청 값이 아니라 Firestore의 데이터로 정한다.
 *  1) 요청의 Firebase 로그인 토큰이 유효한지 확인하고,
 *  2) 그 토큰으로 Firestore를 직접 읽는다. (Firestore 보안 규칙이 그대로 적용된다.)
 *     - 승인된 담임(step 0)인지 staff 문서를 읽어 확인
 *     - 담임이 읽을 수 있는 신청서(본인 반)만 읽힌다
 *  3) 신청서에 저장된 학생 이메일로, DB에 저장된 승인/반려 결과만 안내한다.
 */

const PROJECT_ID = 'field-trip-e5c30';
const API_KEY = 'AIzaSyCgKN6MkX5IIJMhfFugSDLwGt010-gl-Nc';   // Firebase 웹 API 키(공개 값)
const SITE_URL = 'https://knue20-kmla.github.io/field-trip/';
const SENDER_NAME = '교외체험학습 신청 시스템';
const FRESH_MS = 5 * 60 * 1000;   // 처리한 지 5분이 지난 요청은 메일을 보내지 않는다(재전송 방지)

function doGet() {
  return json_({ ok: true, message: 'field-trip mail sender' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    return json_(handle_(req));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** 처음 한 번 편집기에서 실행해 권한(메일 보내기, 외부 요청)을 승인하는 용도 */
function authorize() {
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch('https://www.google.com');
}

function handle_(req) {
  const idToken = req.idToken, kind = req.kind, appId = req.appId;
  if (!idToken || (kind !== 'application' && kind !== 'report') || !/^[A-Za-z0-9_-]{8,64}$/.test(String(appId))) {
    return { ok: false, error: '잘못된 요청' };
  }

  // 1) 토큰 확인
  const me = lookup_(idToken);

  // 2) 승인된 담임인지 확인 (규칙상 본인 staff 문서만 읽을 수 있다)
  const staff = fsGet_('staff/' + me.uid, idToken);
  if (!staff || staff.approved === false || Number(staff.step) !== 0) return { ok: false, error: '담임 권한이 아닙니다' };

  // 3) 신청서 (규칙상 본인 반 신청서만 읽을 수 있다)
  const app = fsGet_('applications/' + appId, idToken);
  if (!app) return { ok: false, error: '신청서를 찾을 수 없습니다' };
  const to = String(app.ownerEmail || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: '학생 이메일이 올바르지 않습니다' };

  const a = app.application || {};
  const name = a.name || '학생';
  const subject = a.subject || '교외체험학습';
  let title, lead, note, stamp;

  if (kind === 'application') {
    const ap = fsGet_('approvals/' + appId, idToken);
    if (!ap || ap.appRev !== app.rev) return { ok: true, sent: false, reason: '처리 기록 없음' };
    stamp = ap.updatedAt;
    if (ap.rejected === true) {
      title = '교외체험학습 신청서가 반려되었습니다';
      lead = name + ' 학생의 「' + subject + '」 신청서가 담임 선생님에 의해 반려되었습니다. 내용을 고쳐 다시 제출해 주세요.';
      note = ap.note;
    } else if (ap.steps && ap.steps[0] && ap.steps[0].approved === true) {
      title = '교외체험학습 신청서를 담임 선생님이 승인했습니다';
      lead = name + ' 학생의 「' + subject + '」 신청서를 담임 선생님이 승인했습니다. 이어서 교무부장, 교감, 교장의 결재가 진행됩니다. 4단계 결재가 모두 끝나면 결과보고서를 작성할 수 있습니다.';
      note = '';
    } else {
      return { ok: true, sent: false, reason: '승인 또는 반려 상태가 아닙니다' };
    }
  } else {
    const rv = fsGet_('reportReviews/' + appId, idToken);
    const rep = app.report || {};
    if (!rv || rv.appRev !== app.rev || rv.reportAt !== rep.submittedAt) return { ok: true, sent: false, reason: '검토 기록 없음' };
    stamp = rv.updatedAt;
    if (rv.status === 'approved') {
      title = '교외체험학습 결과보고서가 승인되었습니다';
      lead = name + ' 학생의 「' + subject + '」 결과보고서를 담임 선생님이 승인했습니다.';
      note = rv.note;
    } else if (rv.status === 'rejected') {
      title = '교외체험학습 결과보고서가 반려되었습니다';
      lead = name + ' 학생의 「' + subject + '」 결과보고서가 반려되었습니다. 내용을 고쳐 다시 제출해 주세요.';
      note = rv.note;
    } else {
      return { ok: true, sent: false, reason: '승인 또는 반려 상태가 아닙니다' };
    }
  }

  // 방금 처리한 건만 보낸다
  const at = stamp ? new Date(stamp).getTime() : 0;
  if (!at || Date.now() - at > FRESH_MS) return { ok: true, sent: false, reason: '오래된 처리입니다' };

  // 같은 처리에 대해 메일이 두 번 가지 않게
  const cache = CacheService.getScriptCache();
  const key = (kind + ':' + appId + ':' + stamp).slice(0, 240);
  if (cache.get(key)) return { ok: true, sent: false, reason: '이미 보냈습니다' };

  const html =
    '<div style="font-family:Malgun Gothic,Apple SD Gothic Neo,sans-serif;line-height:1.7;color:#222">' +
    '<h2 style="margin:0 0 12px">' + esc_(title) + '</h2>' +
    '<p>' + esc_(lead) + '</p>' +
    (note ? '<p style="padding:10px 14px;background:#f6f1ea;border-radius:8px"><b>담임 선생님 메모</b><br>' + esc_(note).replace(/\n/g, '<br>') + '</p>' : '') +
    '<p><a href="' + SITE_URL + '">신청 사이트로 이동</a></p>' +
    '<p style="color:#888;font-size:12px">이 메일은 발신 전용입니다. 문의는 담임 선생님께 해 주세요.</p></div>';

  MailApp.sendEmail({ to: to, subject: '[교외체험학습] ' + title, htmlBody: html, name: SENDER_NAME });
  cache.put(key, '1', 6 * 60 * 60);
  return { ok: true, sent: true };
}

/* ---- Firebase 로그인 토큰 확인 ---- */
function lookup_(idToken) {
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ idToken: idToken }),
  });
  if (res.getResponseCode() !== 200) throw new Error('로그인 확인 실패');
  const u = (JSON.parse(res.getContentText()).users || [])[0];
  if (!u) throw new Error('로그인 확인 실패');
  return { uid: u.localId, email: u.email };
}

/* ---- Firestore REST (요청자의 토큰으로 읽으므로 보안 규칙이 적용된다) ---- */
function fsGet_(path, idToken) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/' + path;
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + idToken }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 404) return null;
  if (code === 403) throw new Error('읽기 권한 없음(' + path.split('/')[0] + ')');
  if (code !== 200) throw new Error('DB 오류 ' + code);
  return decode_({ mapValue: { fields: JSON.parse(res.getContentText()).fields || {} } });
}

function decode_(v) {
  if (v === undefined || v === null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode_);
  if ('mapValue' in v) {
    const out = {}, f = v.mapValue.fields || {};
    Object.keys(f).forEach(function (k) { out[k] = decode_(f[k]); });
    return out;
  }
  return null;
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
