/* 한글(HWPX) 문서 만들기: 신청서와 결과보고서를 .hwpx(한글 파일)로 만든다.
 *
 * HWPX는 XML 파일을 모아 놓은 압축 파일이다. 글꼴·글자 모양·표 테두리 같은 서식 정의는
 * 한글에서 저장한 템플릿의 header.xml(hwpx-assets/header.xml)을 그대로 쓰고,
 * 본문(section0.xml)만 이 파일에서 만든다.
 *
 * 서식 번호(charPr, paraPr, borderFill)는 header.xml에 들어 있는 것만 쓴다.
 *   charPr 13: 함초롬돋움 10pt / 33: 맑은 고딕 12pt / 28: 맑은 고딕 12pt 굵게 / 1: HY헤드라인M 20pt
 *   paraPr 25: 가운데 / 17: 오른쪽 / 0: 왼쪽 (모두 내어쓰기 없음. 15, 21, 26번은 내어쓰기가 있어 쓰지 않는다)
 *   borderFill 3: 실선 테두리 / 16: 연한 하늘색 바탕 실선 테두리(제목 칸)
 */

const NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const PAGE = { width: 59528, height: 84188, left: 5669, right: 5669, top: 2834, bottom: 4251, header: 4251, footer: 2834 };
const CONTENT_W = 48188;
const FLAGS_FIRST = 393216, FLAGS_CONT = 1441792;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---- 글자 수로 줄 수 추정 ---- */
function charW(ch, h) {
  const c = ch.codePointAt(0);
  if (c >= 0xAC00 && c <= 0xD7A3) return h * 0.95;     // 한글
  if (c > 0x2E80) return h;                             // 한자·기호
  if (ch === " ") return h * 0.3;
  return h * 0.55;                                      // 영문·숫자
}
function lineBreaks(text, h, width) {
  const breaks = [0]; let w = 0;
  const chars = Array.from(text);
  let pos = 0;
  for (const ch of chars) {
    const cw = charW(ch, h);
    if (w + cw > width && pos > breaks[breaks.length - 1]) { breaks.push(pos); w = 0; }
    w += cw; pos += ch.length;
  }
  return breaks;
}

/* ---- 문단·줄 정보 ---- */
function lineseg({ vertpos = 0, vertsize = 1200, textheight = 1200, baseline = 1020, spacing = 360, horzsize = CONTENT_W, breaks = [0] }) {
  const segs = breaks.map((tp, i) => `<hp:lineseg textpos="${tp}" vertpos="${vertpos + i * (vertsize + spacing)}" vertsize="${vertsize}" textheight="${textheight}" baseline="${baseline}" spacing="${spacing}" horzpos="0" horzsize="${horzsize}" flags="${i === 0 ? FLAGS_FIRST : FLAGS_CONT}"/>`);
  return `<hp:linesegarray>${segs.join("")}</hp:linesegarray>`;
}
const run = (charPr, text) => text === "" || text == null ? `<hp:run charPrIDRef="${charPr}"/>` : `<hp:run charPrIDRef="${charPr}"><hp:t>${esc(text)}</hp:t></hp:run>`;
function para({ paraPr, charPr, text, id = "2147483648", seg = {}, extraRuns = "" }) {
  const breaks = lineBreaks(text ?? "", seg.vertsize ?? 1200, seg.horzsize ?? CONTENT_W);
  return `<hp:p id="${id}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${extraRuns}${run(charPr, text)}${lineseg({ ...seg, breaks })}</hp:p>`;
}

/* ---- 표 ---- */
const CELL_MARGIN = { left: 510, right: 510, top: 141, bottom: 141 };
// lines: 문단 배열(문자열). 각 문단은 한 줄 이상이 될 수 있다.
function cell({ col, row, width, height, colSpan = 1, rowSpan = 1, borderFill = 3, paraPr = 0, charPr = 33, lines = [""], vertAlign = "CENTER", size = 1200, raw = null }) {
  const inner = Math.max(width - 1022, 0);
  const paras = raw ?? lines.map((t) => para({ paraPr, charPr, text: t, seg: { vertsize: size, textheight: size, baseline: Math.round(size * 0.85), spacing: Math.round(size * 0.3), horzsize: inner } })).join("");
  return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${borderFill}">` +
    `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${vertAlign}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras}</hp:subList>` +
    `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/><hp:cellSz width="${width}" height="${height}"/>` +
    `<hp:cellMargin left="${CELL_MARGIN.left}" right="${CELL_MARGIN.right}" top="${CELL_MARGIN.top}" bottom="${CELL_MARGIN.bottom}"/></hp:tc>`;
}
// 문단 수에 맞는 칸 높이(최소 minH)
function heightFor(lines, width, size, minH) {
  const inner = Math.max(width - 1022, 1);
  const pitch = Math.round(size * 1.45) + 100;
  const n = lines.reduce((sum, t) => sum + lineBreaks(t ?? "", size, inner).length, 0);
  return Math.max(minH, n * pitch + CELL_MARGIN.top + CELL_MARGIN.bottom + 200);
}
let tableSeq = 1974981391;
// rows: [{ cells: [{ text|lines, span, th, ...}], minH }]  열 폭은 widths로 지정
function table({ widths, rows, size = 1200 }) {
  const total = widths.reduce((a, b) => a + b, 0);
  let totalH = 0;
  const trs = rows.map((r, ri) => {
    let col = 0, rowH = r.minH ?? 2200;
    const built = r.cells.map((c) => {
      const span = c.span ?? 1;
      const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
      const lines = c.lines ?? [c.text ?? ""];
      if (!c.raw) rowH = Math.max(rowH, heightFor(lines, w, c.size ?? size, 0));
      const spec = { col, row: ri, width: w, colSpan: span, lines, raw: c.raw ?? null, size: c.size ?? size,
        borderFill: c.th ? 16 : 3, charPr: c.th ? 28 : (c.charPr ?? 33), paraPr: c.th ? 25 : (c.paraPr ?? 0), vertAlign: c.vertAlign ?? "CENTER" };
      col += span;
      return spec;
    });
    totalH += rowH;
    return `<hp:tr>${built.map((b) => cell({ ...b, height: rowH })).join("")}</hp:tr>`;
  });
  const id = tableSeq++;
  const tbl = `<hp:tbl id="${id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${widths.length}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">` +
    `<hp:sz width="${total}" widthRelTo="ABSOLUTE" height="${totalH}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>${trs.join("")}</hp:tbl>`;
  return { tbl, height: totalH };
}
// 표를 담는 문단
function tableParagraph(t, paraPr = 0) {
  const v = t.height + 566;
  return `<hp:p id="2147483648" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="33">${t.tbl}<hp:t/></hp:run>${lineseg({ vertsize: v, textheight: v, baseline: Math.round(v * 0.85), spacing: 600, breaks: [0] })}</hp:p>`;
}
const emptyPara = (size = 800) => para({ paraPr: 0, charPr: 33, text: "", seg: { vertsize: size, textheight: size, baseline: Math.round(size * 0.85), spacing: 480 } });

/* ---- 그림(JPEG) ---- */
export function dataUrlToBytes(dataUrl) {
  const b64 = String(dataUrl).split(",")[1] ?? "";
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return { w: 800, h: 600 };
}
let picSeq = 2065069028;
function picXml({ binId, name, wPx, hPx, maxW, maxH }) {
  const orgW = wPx * 75, orgH = hPx * 75;                 // 96dpi 기준 한글 단위(1/7200인치)
  const k = Math.min(maxW / orgW, maxH / orgH, 1);
  const w = Math.max(Math.round(orgW * k), 1), h = Math.max(Math.round(orgH * k), 1);
  const id = picSeq++, inst = picSeq++;
  const xml = `<hp:pic id="${id}" zOrder="${id % 1000}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${inst}" reverse="0">` +
    `<hp:offset x="0" y="0"/><hp:orgSz width="${orgW}" height="${orgH}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>` +
    `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="0"/>` +
    `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="${w / orgW}" e2="0" e3="0" e4="0" e5="${h / orgH}" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
    `<hc:img binaryItemIDRef="${binId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
    `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${orgW}" y="0"/><hc:pt2 x="${orgW}" y="${orgH}"/><hc:pt3 x="0" y="${orgH}"/></hp:imgRect>` +
    `<hp:imgClip left="0" right="${orgW}" top="0" bottom="${orgH}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${orgW}" dimheight="${orgH}"/><hp:effects/>` +
    `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>그림입니다.\n원본 그림의 이름: ${esc(name)}</hp:shapeComment></hp:pic>`;
  return { xml, h };
}
// 사진 칸 안의 문단들: 그림 + 번호
function photoCellParas(binId, name, wPx, hPx, no) {
  const { xml, h } = picXml({ binId, name, wPx, hPx, maxW: 14600, maxH: 10000 });
  const picPara = `<hp:p id="2147483648" paraPrIDRef="25" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="33">${xml}<hp:t/></hp:run>${lineseg({ vertsize: h, textheight: h, baseline: Math.round(h * 0.85), spacing: 0, horzsize: 15040, breaks: [0] })}</hp:p>`;
  const cap = para({ paraPr: 25, charPr: 13, text: `사진 ${no}`, seg: { vertsize: 1000, textheight: 1000, baseline: 850, spacing: 300, vertpos: h, horzsize: 15040 } });
  return picPara + cap;
}
const PHOTO_COLS = [16062, 16062, 16064];
function photoTable(photos, images) {
  const rows = [{ minH: 2200, cells: [{ text: "활동인증 사진", th: true, span: 3 }] }];
  for (let i = 0; i < photos.length; i += 3) {
    const cells = [0, 1, 2].map((j) => {
      const p = photos[i + j];
      if (!p) return { text: "" };
      const n = images.length + 1;
      const binId = `image${n}`;
      images.push({ id: binId, path: `BinData/${binId}.jpg`, bytes: p.bytes, mediaType: "image/jpg" });
      return { raw: photoCellParas(binId, p.name || binId + ".jpg", p.w, p.h, i + j + 1), vertAlign: "CENTER" };
    });
    rows.push({ minH: 12200, cells });
  }
  return tableParagraph(table({ widths: PHOTO_COLS, rows }));
}

/* ---- 첫 문단: 쪽 설정 + 제목 ---- */
function secPr() {
  return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="3" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>` +
    `<hp:pagePr landscape="WIDELY" width="${PAGE.width}" height="${PAGE.height}" gutterType="LEFT_ONLY"><hp:margin header="${PAGE.header}" footer="${PAGE.footer}" gutter="0" left="${PAGE.left}" right="${PAGE.right}" top="${PAGE.top}" bottom="${PAGE.bottom}"/></hp:pagePr>` +
    `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
    `<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
    `<hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>` +
    `<hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr>`;
}
function titleParagraph(title) {
  const ctrl = `<hp:run charPrIDRef="1"><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>${secPr()}</hp:run>`;
  return `<hp:p id="0" paraPrIDRef="25" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${ctrl}${run(1, title)}${lineseg({ vertsize: 2000, textheight: 2000, baseline: 1700, spacing: 760 + 1100, breaks: [0] })}</hp:p>`;
}

/* ---- 문서 내용 ---- */
const dateKo = (value) => {
  if (!value) return "";
  const d = new Date(value); if (Number.isNaN(d.getTime())) return String(value);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${wd}요일 ${String(d.getHours()).padStart(2, "0")}시`;
};
function signTable(appr) {
  const names = ["담임", "교무부장", "교감", "교장"];
  const w = 7000, widths = [w, w, w, w];
  const head = { minH: 1800, cells: names.map((n) => ({ text: n, th: true, size: 1000 })) };
  const body = { minH: 3000, cells: names.map((_, i) => {
    const s = appr?.steps?.[i]; const done = Boolean(s?.approved);
    const d = done && s.at ? new Date(s.at) : null;
    const date = d && !Number.isNaN(d.getTime()) ? `${d.getMonth() + 1}.${d.getDate()}.` : "";
    return { lines: [done ? (s.by || "승인") : "", date], size: 1000, charPr: 13, paraPr: 25 };
  }) };
  return tableParagraph(table({ widths, rows: [head, body], size: 1000 }), 17);
}
const WID = [8500, 15594, 8500, 15594];
const th = (text) => ({ text, th: true });
const tdv = (text, span = 1) => ({ text: text ?? "", span });
function planLines(plans = []) {
  const out = [];
  plans.forEach((p, i) => {
    if (i) out.push("");
    out.push(dateKo(`${p.date}T00:00`).replace(/ 00시$/, ""));
    String(p.plan ?? "").split("\n").forEach((l) => out.push(l));
  });
  return out.length ? out : [""];
}
function footerRow() {
  return { minH: 2600, cells: [th("확인"), { text: `${new Date().getFullYear()}년      월      일      어드바이저/지도교사 :                    (인)`, span: 3 }] };
}

export function buildApplicationSection(app, appr) {
  const rows = [
    { cells: [th("이름"), tdv(app.name), th("학번"), tdv(app.studentId)] },
    { cells: [th("학년/반"), tdv(`${app.grade}학년 ${app.classroom}반 ${app.number}번`), th("학습 형태"), tdv(app.learningType)] },
    { cells: [th("시작 일시"), tdv(`${dateKo(app.startAt)} 부터`, 3)] },
    { cells: [th("종료 일시"), tdv(`${dateKo(app.endAt)} 까지`, 3)] },
    { cells: [th("학교출발시각"), tdv(app.leaveAt ? `${dateKo(app.leaveAt)} 부터 외출 예정` : "", 3)] },
    { cells: [th("주제"), tdv(app.subject, 3)] },
    { cells: [th("활동 장소"), tdv(app.place, 3)] },
    { cells: [th("동행자명"), tdv(app.companionName), th("관계"), tdv(app.relationship)] },
    { cells: [th("학생 연락처"), tdv(app.studentPhone), th("동행자 연락처"), tdv(app.companionPhone)] },
    { cells: [th("방문처"), tdv(app.visitContact, 3)] },
    { cells: [th("비고"), tdv(app.note, 3)] },
    { minH: 9000, cells: [th("학습계획"), { lines: planLines(app.dailyPlans), span: 3, vertAlign: "TOP" }] },
    footerRow(),
  ];
  return { body: titleParagraph("교외체험학습 신청서") + signTable(appr) + emptyPara() + tableParagraph(table({ widths: WID, rows })), images: [] };
}

// photos: [{ name, bytes(Uint8Array, JPEG), w, h }]
export function buildReportSection(app, report, appr, review, photos = []) {
  const rows = [
    { cells: [th("이름"), tdv(app.name), th("학번"), tdv(app.studentId)] },
    { cells: [th("학년/반"), tdv(`${app.grade}학년 ${app.classroom}반 ${app.number}번`, 3)] },
    { cells: [th("시작 일시"), tdv(`${dateKo(app.startAt)} 부터`, 3)] },
    { cells: [th("종료 일시"), tdv(`${dateKo(app.endAt)} 까지`, 3)] },
    { cells: [th("신청서 일시"), tdv(report.timeMatch === "different" ? "일치하지 않습니다." : "일치합니다.", 3)] },
    { cells: [th("실제 활동 시간"), tdv(report.actualTime, 3)] },
    { cells: [th("변동 이유"), tdv(report.changeReason, 3)] },
    { minH: 12000, cells: [th("체험학습 결과보고란"), { lines: String(report.reportText ?? "").split("\n"), span: 3, vertAlign: "TOP" }] },
  ];
  if (review?.status === "approved") rows.push({ cells: [th("결과보고서 검토"), tdv(`담임 ${review.by || ""} 승인`, 3)] });
  rows.push(footerRow());
  const images = [];
  const body = titleParagraph("교외체험학습 결과 보고서") + signTable(appr) + emptyPara() + tableParagraph(table({ widths: WID, rows }))
    + (photos.length ? emptyPara(600) + photoTable(photos, images) : "");
  return { body, images };
}

/* ---- 파일 묶기 ---- */
const sectionXml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${NS}>${body}</hs:sec>`;
function contentHpf(title, images = []) {
  const imgItems = images.map((im) => `<opf:item id="${im.id}" href="${im.path}" media-type="${im.mediaType}" isEmbeded="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">교외체험학습 신청 관리</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">교외체험학습 신청 관리</opf:meta><opf:meta name="CreatedDate" content="text">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata>` +
    `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${imgItems}<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>` +
    `<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
}
const VERSION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="10" xmlVersion="1.5" application="Hancom Office Hangul" appVersion="12.30.0.6313 MAC64LEDarwin_25.3.0"/>`;
const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`;
const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>`;
const MANIFEST_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;

/** header: header.xml 문자열, bodyXml: buildApplicationSection/buildReportSection 결과, JSZip: 압축 라이브러리 */
export async function packHwpx(JSZip, { header, bodyXml, title, previewText, images = [] }) {
  const zip = new JSZip();
  // mimetype은 첫 번째 항목이고 압축하지 않아야 한다.
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
  zip.file("version.xml", VERSION_XML);
  zip.file("settings.xml", SETTINGS_XML);
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("META-INF/manifest.xml", MANIFEST_XML);
  zip.file("Preview/PrvText.txt", previewText ?? title);
  zip.file("Contents/content.hpf", contentHpf(title, images));
  images.forEach((im) => zip.file(im.path, im.bytes));
  zip.file("Contents/header.xml", header);
  zip.file("Contents/section0.xml", sectionXml(bodyXml));
  return zip.generateAsync({ type: "arraybuffer", mimeType: "application/hwp+zip", compression: "DEFLATE" });
}
