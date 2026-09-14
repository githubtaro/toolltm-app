// ToolLtm テストスイート（v0.13 時点）
//
//   実行:  node test_v0_13.js
//   前提:  同じディレクトリに index.html があること。依存パッケージなし（Node標準のみ）。
//   終了コード: 全pass=0 / 1本でもfail=1（CIにそのまま掛けられる）
//
// このファイルがリポジトリ唯一のテスト。v0.10〜v0.12 の回帰（R01〜R08）と
// v0.13 の新規仕様（T17〜T26）の両方をここでカバーする。
//
//   R01 順次消費とカーソル（v0.10）
//   R02 PARK 12h超の除外（v0.11）
//   R03 fixW2Types シグネチャ補正（v0.11）
//   R04 校正による隣接同一スロット統合（v0.12）
//   R05 INI / Measure パーサ
//   R06 NCログパーサとジョブ組み立て
//   R07 差分・交換検知・スロット→バー解決
//   R08 ファイル読み取り（UTF-16LE フォールバック）※非同期
//   T17 順序型 1パス目          T18 2パス目 孤児救済
//   T19 尻尾許容                T20 総量保存
//   T21 Measureログ 最新1本選別  T22 segCutoff とローリング保持
//   T23 交換CSV の理由・メモ列   T24 long_inside 関連の小修正
//   T25 期待バー不明ジョブの貪欲消費（v0.12互換の意図的な残置）
//   T26 保存領域の表示
//   T27 加工記録CSV の列とエスケープ（v0.13.1）
//   T28 画面とCSVが同じ突合結果を使う
//   T29 役割列と尻尾秒
//
// 方式: index.html の <script> を切り出して vm 上で評価し、DOM と localStorage は
//       最小スタブを当てる。ブラウザを立ち上げずに内部関数を直接叩ける。
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---------- harness ----------
// 時計を 2026-09-11 に固定する。segCutoff() は「今日から SEG_KEEP_DAYS 日前」なので、
// 固定しないと 2026-09-07 のフィクスチャが 60 日後に「保持期間外」へ落ちてテストが腐る。
const TODAY = "2026-09-11";
const FROZEN = Date.parse(TODAY + "T12:00:00+09:00");
class FrozenDate extends Date {
  constructor(...a){ if(a.length === 0) super(FROZEN); else super(...a); }
  static now(){ return FROZEN; }
}
function loadApp(){
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  if(!m) throw new Error("index.html に <script> が見つからない");

  // DOM / ブラウザAPIの最小スタブ。トップレベルの $("...").onclick = ... 等を通すためだけのもの。
  const els = {};
  const el = id => els[id] || (els[id] = {id, value:"", textContent:"", innerHTML:"", className:"", disabled:false,
                                          onclick:null, onchange:null, click(){}});
  const store = new Map();
  const ctx = {
    console,
    setTimeout, clearTimeout, Date: FrozenDate, JSON, Math, RegExp, Object, Array, String, Number, Set, Map, Promise, TextDecoder, Blob:function(){}, URL:{createObjectURL(){return "";}, revokeObjectURL(){}},
    document: { getElementById: el, createElement: () => ({click(){}, set href(v){}, get href(){return "";}}) },
    localStorage: {
      get length(){ return store.size; },
      key: i => [...store.keys()][i] ?? null,
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k,v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    confirm: () => true,
    alert: () => {},
    prompt: () => null
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);

  // 内部の const/let 束縛はグローバルオブジェクトに載らないので、末尾で明示的に取り出す
  const epilogue = `
  ;globalThis.__app = {
    loadDB, saveDB, segCutoff, isSegKept, SEG_KEEP_DAYS,
    matchSegments, barOf, secToHms, hmsToSec,
    parseNoteLine, parseJobLog, parseNcPath, expectedBars, KIND, fillUnits,
    parseIni, parseMeasure, fixW2Types, buildDiff, latestSnapshot,
    machineFromPath, readFileText, msToLocalIso,
    pickLatestPerMachine, exchangesCsv, csvCell, EX_REASONS,
    computeJobMatches, jobsCsv, jobTeethCount, byDateTime,
    lsUsageBytes, lsUsageLine, LS_LIMIT_MB,
    renderJobs, renderExchanges, setExReason,
    SEG_TAIL_MAX, PARKJ, MERGE_GAP
  };`;
  vm.runInContext(m[1] + epilogue, ctx, {filename:"index.html:script"});
  return {app: ctx.__app, els, el, store, ctx};
}

// ---------- assertions ----------
let pass = 0, fail = 0;
const failures = [];
function t(name, fn){
  try{ fn(); pass++; console.log("  ok   " + name); }
  catch(e){ fail++; failures.push(name + " :: " + e.message); console.log("  FAIL " + name + "\n       " + e.message); }
}
async function tAsync(name, fn){
  try{ await fn(); pass++; console.log("  ok   " + name); }
  catch(e){ fail++; failures.push(name + " :: " + e.message); console.log("  FAIL " + name + "\n       " + e.message); }
}
function report(){
  console.log(`\n${pass} passed, ${fail} failed`);
  if(fail){ for(const f of failures) console.log("  - " + f); process.exit(1); }
}
function eq(actual, expected, what){
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if(a !== b) throw new Error(`${what||""} expected ${b}, got ${a}`);
}
function ok(cond, what){ if(!cond) throw new Error(what || "条件不成立"); }

const APP = loadApp();
const A = APP.app;

// ---------- fixtures ----------
// 2026-09-07 d1（実データ。指示書§⑤の検証用フィクスチャ）
// スロット: s1=11 s2=12 s3=16（石膏支台） / s8=50 s9=51 s10=52（CAD/CAM冠）
const D1_SNAP = {
  id:"s_d1", machine:"d1", takenAt:"2026-09-08T09:00",
  tools:[1,2,3,8,9,10].map(slot => ({slot, type:{1:11,2:12,3:16,8:50,9:51,10:52}[slot], run:0, max:0, cut:0, flag:0}))
};
function seg(m,slot,a,b){ return {machine:m, slot, a:"2026-09-07T"+a, b:"2026-09-07T"+b, broken:false}; }
const D1_SEGS = [
  // 冠×3（#25 11:40 / #45 11:45 / #16 11:48）
  seg("d1",8,"11:46:00","11:54:00"), seg("d1",9,"11:55:00","11:57:00"), seg("d1",10,"11:58:00","11:59:00"),
  seg("d1",8,"12:00:00","12:08:00"), seg("d1",9,"12:09:00","12:11:00"), seg("d1",10,"12:12:00","12:13:00"),
  seg("d1",8,"12:14:00","12:22:00"), seg("d1",9,"12:23:00","12:25:00"), seg("d1",10,"12:26:00","12:27:00"),
  // #27 の1回目（16なし）
  seg("d1",1,"12:42:00","12:51:00"), seg("d1",2,"12:52:00","13:00:00"),
  // #27 の2回目（孤児）
  seg("d1",1,"13:01:00","13:10:00"), seg("d1",2,"13:10:30","13:36:00"), seg("d1",3,"13:36:30","13:43:00"),
  // #25(13:13)
  seg("d1",1,"13:43:30","13:50:00"), seg("d1",2,"13:50:30","14:08:00"), seg("d1",3,"14:08:30","14:23:00"),
  // #44
  seg("d1",1,"14:24:00","14:32:00"), seg("d1",2,"14:32:30","14:50:00"), seg("d1",3,"14:50:30","14:57:00"),
  // #37
  seg("d1",1,"14:58:00","15:05:00"), seg("d1",2,"15:05:30","15:20:00"), seg("d1",3,"15:21:00","15:45:00"),
  // #16
  seg("d1",1,"15:46:00","15:52:00"), seg("d1",2,"15:52:30","16:04:00"), seg("d1",3,"16:05:00","16:45:00"),
  // #14
  seg("d1",1,"16:45:30","16:55:00"), seg("d1",2,"16:55:30","17:25:00"), seg("d1",3,"17:26:00","17:37:00"),
  // #47
  seg("d1",1,"17:37:30","17:44:00"), seg("d1",2,"17:44:30","18:02:00"), seg("d1",3,"18:02:30","18:07:00"),
  // #11
  seg("d1",1,"18:07:30","18:15:00"), seg("d1",2,"18:15:30","18:31:00"), seg("d1",3,"18:31:30","18:36:00"),
  // #12（日末、16なし）
  seg("d1",1,"18:36:30","18:41:00"), seg("d1",2,"18:42:00","18:53:00")
];
const STONE = [11,12,16], CROWN = [50,51,52];
function job(tag, hhmm, bars){
  return {id:"j_"+tag, date:"2026-09-07", machine:"d1", hhmm, expectedBars:bars, teeth:tag, raw:"r_"+tag};
}
const D1_JOBS = [
  job("27a","1134",STONE), job("25a","1140",CROWN), job("45a","1145",CROWN), job("16a","1148",CROWN),
  job("25b","1313",STONE), job("44","1338",STONE), job("37","1342",STONE), job("16b","1420",STONE),
  job("14","1425",STONE), job("47","1639",STONE), job("11","1649",STONE), job("12","1742",STONE),
  job("45b","1744",STONE)
];
function d1db(){ return {snapshots:[D1_SNAP], exchanges:[], segments:D1_SEGS.map(s=>({...s})), jobs:D1_JOBS.map(j=>({...j}))}; }

// renderJobs と同じ2パス突合を、DOMなしで再現する（表示ロジックではなく帰属ロジックの検証）
function runTwoPass(db, jobs){
  const cursors = {}, consumed = new Set(), res = {};
  for(const j of jobs){
    const mt = A.matchSegments(db, j, j.date, cursors[j.machine] ?? null);
    if(mt){ cursors[j.machine] = mt.lastEnd; for(const k of mt.consumedKeys) consumed.add(k); }
    res[j.id] = {mt, rescued:false};
  }
  for(const j of jobs){
    const r = res[j.id];
    if(r.mt) continue;
    const avail = db.segments.filter(s => !consumed.has(s.machine+"|"+s.a));
    const mt = A.matchSegments(db, j, j.date, null, {mode:"rescue", segments:avail});
    if(mt){ r.mt = mt; r.rescued = true; for(const k of mt.consumedKeys) consumed.add(k); }
  }
  return {res, consumed};
}
const barsOf = mt => mt ? Object.keys(mt.used).map(Number).sort((a,b)=>a-b) : null;

console.log("\n=== R01: 順次消費とカーソル（v0.10） ===");
function seqDb(){
  return {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",1,"09:00:00","09:10:00"), seg("d1",2,"09:11:00","09:20:00"), seg("d1",3,"09:21:00","09:25:00"),
    seg("d1",1,"09:30:00","09:40:00"), seg("d1",2,"09:41:00","09:50:00"), seg("d1",3,"09:51:00","09:55:00")
  ]};
}
t("R01-1 カーソルは消費した最後のセグメントの終了時刻になる", () => {
  const mt = A.matchSegments(seqDb(), job("a","0855",STONE), "2026-09-07", null);
  eq(mt.lastEnd, "2026-09-07T09:25:00");
});
t("R01-2 連続ネストは直前ジョブの消費終了以降から突合する", () => {
  const db = seqDb();
  const j1 = job("a","0855",STONE), j2 = job("b","0856",STONE);   // NC時刻はほぼ同時
  const mt1 = A.matchSegments(db, j1, "2026-09-07", null);
  const mt2 = A.matchSegments(db, j2, "2026-09-07", mt1.lastEnd);
  eq(mt1.picked.map(p=>p.a), ["2026-09-07T09:00:00","2026-09-07T09:11:00","2026-09-07T09:21:00"], "1本目");
  eq(mt2.picked.map(p=>p.a), ["2026-09-07T09:30:00","2026-09-07T09:41:00","2026-09-07T09:51:00"], "2本目");
});
t("R01-3 カーソルがNC時刻より前なら無視され、窓はNC時刻から始まる", () => {
  const db = seqDb();
  const mt = A.matchSegments(db, job("c","0925",STONE), "2026-09-07", "2026-09-07T08:00:00");
  eq(mt.picked[0].a, "2026-09-07T09:30:00", "過去のカーソルで窓は広がらない");
});
t("R01-4 不突合(null)ではカーソルを進めない＝後続の窓を狭めない", () => {
  const db = seqDb();
  const jobs = [job("x","0855",CROWN), job("y","0856",STONE)];    // 1本目は期待外で null
  const {res} = runTwoPass(db, jobs);
  eq(res["j_x"].mt, null, "冠ジョブは石膏セグメントで null");
  eq(res["j_y"].mt.picked[0].a, "2026-09-07T09:00:00", "後続は先頭から突合できる");
});
t("R01-5 マシンが違うセグメントは拾わない", () => {
  const db = seqDb();
  for(const s of db.segments) s.machine = "d2";
  eq(A.matchSegments(db, job("m","0855",STONE), "2026-09-07", null), null);
});

console.log("\n=== R02: PARK 12h超の除外（v0.11） ===");
t("R02-1 12h超のセグメントは拾わず、打ち切りもしない", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    {machine:"d1", slot:1, a:"2026-09-07T09:00:00", b:"2026-09-07T22:00:01"},   // 13h 装着放置
    seg("d1",1,"22:10:00","22:20:00"),
    seg("d1",2,"22:21:00","22:30:00"), seg("d1",3,"22:31:00","22:35:00")
  ]};
  const mt = A.matchSegments(db, job("p","0855",STONE), "2026-09-07", null);
  eq(barsOf(mt), STONE, "PARKを飛ばして続行");
  eq(mt.used[11], 600, "11 は 22:10-22:20 の600秒のみ（13hは混入しない）");
});
t("R02-2 一巡の途中にPARKが挟まっても連鎖は切れない", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",1,"09:00:00","09:10:00"),
    {machine:"d1", slot:3, a:"2026-09-07T09:11:00", b:"2026-09-08T09:11:01"},   // 16 が24h装着放置
    {machine:"d1", slot:2, a:"2026-09-08T10:00:00", b:"2026-09-08T10:09:00"}
  ]};
  const mt = A.matchSegments(db, job("q","0855",STONE), "2026-09-07", null);
  eq(barsOf(mt), [11,12], "PARKで break していない");
});
t("R02-3 ちょうど12hは除外されない（境界は超過のみ）", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    {machine:"d1", slot:1, a:"2026-09-07T09:00:00", b:"2026-09-07T21:00:00"}    // 12h00m00s
  ]};
  const mt = A.matchSegments(db, job("r","0855",STONE), "2026-09-07", null);
  eq(mt.used[11], 43200, "12h ちょうどは消費される");
});

console.log("\n=== R03: fixW2Types シグネチャ補正（v0.11） ===");
const w2sig = () => [{slot:16,type:67},{slot:17,type:69},{slot:18,type:18}];
t("R03-1 シグネチャ完全一致で 66/67/69 に読み替える", () => {
  const tools = w2sig();
  A.fixW2Types("w2", tools);
  eq(tools.map(t=>t.type), [66,67,69]);
});
t("R03-2 冪等（補正済みに再適用しても変わらない）", () => {
  const tools = w2sig();
  A.fixW2Types("w2", tools); A.fixW2Types("w2", tools); A.fixW2Types("w2", tools);
  eq(tools.map(t=>t.type), [66,67,69]);
});
t("R03-3 w2 以外では発動しない", () => {
  for(const m of ["d1","d2","w1"]){
    const tools = w2sig();
    A.fixW2Types(m, tools);
    eq(tools.map(t=>t.type), [67,69,18], m + " は素通し");
  }
});
t("R03-4 シグネチャが一部でも違えば発動しない（機械側で直れば自動失効）", () => {
  const cases = [
    [{slot:16,type:66},{slot:17,type:67},{slot:18,type:69}],   // 既に正常登録
    [{slot:16,type:67},{slot:17,type:69},{slot:18,type:19}],   // 18 が違う
    [{slot:16,type:67},{slot:17,type:68},{slot:18,type:18}],   // 17 が違う
    [{slot:16,type:67},{slot:17,type:69}]                      // 18 が無い
  ];
  for(const tools of cases){
    const before = tools.map(t=>t.type).join("/");
    A.fixW2Types("w2", tools);
    eq(tools.map(t=>t.type).join("/"), before, "変化なし: " + before);
  }
});
t("R03-5 tools が無くても落ちない", () => {
  A.fixW2Types("w2", null); A.fixW2Types("w2", undefined);
});
t("R03-6 loadDB 経由で過去スナップショットも読み替わる", () => {
  APP.store.set("toolltm.v1", JSON.stringify({
    snapshots:[{id:"s", machine:"w2", takenAt:"2026-08-01T09:00", tools:w2sig()}],
    exchanges:[], segments:[], jobs:[]}));
  eq(A.loadDB().snapshots[0].tools.map(t=>t.type), [66,67,69]);
  APP.store.delete("toolltm.v1");
});

console.log("\n=== R04: 校正による隣接同一スロット統合（v0.12） ===");
t("R04-1 同一スロットで間隔≤2分なら1本に統合し、間の空白も保持時間に含む", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",1,"09:00:00","09:05:00"), seg("d1",1,"09:06:00","09:10:00"),   // 1分空き＝再測定
    seg("d1",2,"09:11:00","09:20:00"), seg("d1",3,"09:21:00","09:25:00")
  ]};
  const mt = A.matchSegments(db, job("g","0855",STONE), "2026-09-07", null);
  eq(barsOf(mt), STONE, "11 の細切れで打ち切られない");
  eq(mt.used[11], 600, "09:00→09:10 の600秒");
  eq(mt.picked.length, 3, "3本として扱われる");
});
t("R04-2 統合されたセグメントは元の生セグメント全部を消費済みにする", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",1,"09:00:00","09:05:00"), seg("d1",1,"09:06:00","09:10:00"),
    seg("d1",2,"09:11:00","09:20:00"), seg("d1",3,"09:21:00","09:25:00")
  ]};
  const mt = A.matchSegments(db, job("g","0855",STONE), "2026-09-07", null);
  ok(mt.consumedKeys.includes("d1|2026-09-07T09:00:00"), "1本目");
  ok(mt.consumedKeys.includes("d1|2026-09-07T09:06:00"), "統合された2本目も消費済み");
  eq(mt.consumedKeys.length, 4, "生セグメント4本ぶん");
});
t("R04-3 間隔ちょうど2分は統合、2分超は別セグメント", () => {
  const mk = gapEnd => ({snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",1,"09:00:00","09:05:00"), seg("d1",1,gapEnd,"09:12:00")
  ]});
  const merged = A.matchSegments(mk("09:07:00"), job("h","0855",STONE), "2026-09-07", null);
  eq(merged.picked.length, 1, "2分ちょうどは統合");
  eq(merged.used[11], 720, "09:00→09:12");
  const split = A.matchSegments(mk("09:07:01"), job("h","0855",STONE), "2026-09-07", null);
  eq(split.picked.length, 1, "統合されず、11の再登場で打ち切り");
  eq(split.used[11], 300, "1本目の300秒のみ");
});
t("R04-4 スロットが違えば統合しない", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",1,"09:00:00","09:05:00"), seg("d1",2,"09:06:00","09:10:00"), seg("d1",3,"09:11:00","09:15:00")
  ]};
  const mt = A.matchSegments(db, job("i","0855",STONE), "2026-09-07", null);
  eq(mt.picked.length, 3);
});

console.log("\n=== R05: INI / Measure パーサ ===");
const INI_SAMPLE = `[ToolProperties_Tool001]
Type=11
ActRunTime=01:02:03
MaxRunTime=25:00:00
ActCuttingTime=00:30:00
ErrStatusFlag=0
[ToolProperties_Tool002]
Type=0
ActRunTime=00:00:00
ErrStatusFlag=0
[ToolProperties_Tool003]
Type=12
ActRunTime=02:00:00
MaxRunTime=25:00:00
ActCuttingTime=00:40:00
ErrStatusFlag=1040
[ToolProperties_Tool004]
Type=16
ActRunTime=03:00:00
MaxRunTime=10:00:00
ActCuttingTime=00:50:00
ErrStatusFlag=256
`;
t("R05-1 Type=0 と ErrStatusFlag=1040 は除外、セクション数は全件数える", () => {
  const {tools, sections} = A.parseIni(INI_SAMPLE);
  eq(sections, 4, "セクション数");
  eq(tools.map(t=>t.type), [11,16], "有効工具");
});
t("R05-2 HH:MM:SS が秒に変換される", () => {
  const {tools} = A.parseIni(INI_SAMPLE);
  eq(tools[0].run, 3723, "01:02:03");
  eq(tools[0].max, 90000, "25:00:00");
  eq(tools[0].cut, 1800, "00:30:00");
});
t("R05-3 flag256 は除外せず保持する（参考情報）", () => {
  const {tools} = A.parseIni(INI_SAMPLE);
  eq(tools[1].flag, 256);
});
t("R05-4 hmsToSec は不正入力で 0 を返す", () => {
  eq(A.hmsToSec(""), 0); eq(A.hmsToSec("あ:い:う"), 0); eq(A.hmsToSec("1:2"), 0);
  eq(A.hmsToSec("100:00:00"), 360000);
});
t("R05-5 secToHms は往復し、負値は符号付き", () => {
  eq(A.secToHms(3723), "01:02:03");
  eq(A.secToHms(0), "00:00:00");
  eq(A.secToHms(-90), "-00:01:30");
});
t("R05-6 Measure: 装着→返却のペアでセグメントになる", () => {
  const segs = A.parseMeasure(
`2026-09-07, 09:00:00.123 Storing measuring result of tool 1 after toolchange
2026-09-07, 09:10:00.456 Control measure of collet after depositing tool 1
2026-09-07, 09:11:00.000 Storing measuring result of tool 2 after toolchange
2026-09-07, 09:20:00.000 Control measure of collet after depositing tool 2`);
  eq(segs.length, 2);
  eq(segs[0], {slot:1, a:"2026-09-07T09:00:00", b:"2026-09-07T09:10:00"});
});
t("R05-7 返却なしで次の装着が来たら broken フラグが立つ", () => {
  const segs = A.parseMeasure(
`2026-09-07, 09:00:00.0 Storing measuring result of tool 1 after toolchange
2026-09-07, 09:30:00.0 Storing measuring result of tool 2 after toolchange
2026-09-07, 09:40:00.0 Control measure of collet after depositing tool 2`);
  eq(segs.length, 2);
  eq(segs[0].broken, true, "1本目は返却記録なし");
  ok(!segs[1].broken, "2本目は正常");
});
t("R05-8 requested行だけの再測定は装着に数えない", () => {
  const segs = A.parseMeasure(
`2026-09-07, 09:00:00.0 Requested measuring of tool 1
2026-09-07, 09:01:00.0 Storing measuring result of tool 1 after toolchange
2026-09-07, 09:10:00.0 Control measure of collet after depositing tool 1`);
  eq(segs.length, 1);
  eq(segs[0].a, "2026-09-07T09:01:00");
});
t("R05-9 返却のスロットが噛み合わない行は無視される", () => {
  const segs = A.parseMeasure(
`2026-09-07, 09:00:00.0 Storing measuring result of tool 1 after toolchange
2026-09-07, 09:05:00.0 Control measure of collet after depositing tool 9
2026-09-07, 09:10:00.0 Control measure of collet after depositing tool 1`);
  eq(segs.length, 1);
  eq(segs[0].b, "2026-09-07T09:10:00");
});

console.log("\n=== R06: NCログパーサとジョブ組み立て ===");
t("R06-1 NC出力パスから素材/厚み/マシン/ブランク/日付/時刻を取る", () => {
  const r = A.parseNcPath("C:\\Users\\Public\\Documents\\hyperDENT\\NC Output_wet1\\260618_TiA_10T_w1_b1_20260706_1014.iso");
  eq(r.material, "TiA"); eq(r.thick, "10T"); eq(r.machine, "w1");
  eq(r.blank, "b1"); eq(r.ymd, "20260706"); eq(r.hhmm, "1014");
  eq(r.isBlock, false, "英字を含むのでディスク");
});
t("R06-2 英字を含まない名前はブロック扱い", () => {
  eq(A.parseNcPath("C:\\x\\260618_20260706_1014.iso").isBlock, true);
});
t("R06-3 注記行が直後の非空行から拾われ、次の.iso行で打ち切られる", () => {
  const jobs = A.parseJobLog(
`C:\\x\\260618_TiA_10T_w1_b1_20260706_1014.iso
w1 TiA Br B #45-47 全3 前2 支台2 ポン1 ユ6
C:\\x\\260619_Stone_20260706_1130.iso
d1 Stone 石支台 #36 全1`);
  eq(jobs.length, 2);
  eq(jobs[0].kind, "Br"); eq(jobs[0].template, "B"); eq(jobs[0].teeth, "45-47");
  eq(jobs[0].units, 3); eq(jobs[0].veneer, 2); eq(jobs[0].userdef, 6);
  eq(jobs[0].expectedBars, [61,62,64], "TiA テンプレB");
  eq(jobs[1].kind, "石支台"); eq(jobs[1].expectedBars, [11,12,16]);
});
t("R06-4 全角の数字・スペース・＃を正規化して拾う", () => {
  const r = A.parseNoteLine("ｄ１　Stone　石支台　＃３６　全１");
  eq(r.teeth, "36"); eq(r.units, 1);
});
t("R06-5 ブロックで材料不明なら CAD/CAM 冠と仮定しフラグを立てる", () => {
  const jobs = A.parseJobLog("C:\\x\\260618_20260706_1014.iso\nd2 Cr #22 全1");
  eq(jobs[0].material, "CADCAM");
  eq(jobs[0].materialAssumed, true);
  eq(jobs[0].expectedBars, [50,51,52]);
});
t("R06-6 単独大文字のテンプレ判定は Metal系(TiA/TiP)ジョブに限る", () => {
  eq(A.parseNoteLine("w1 TiA Cr B #16 全1").template, "B", "TiA なら採用");
  eq(A.parseNoteLine("d2 CAD Cr #22 全1").template, undefined, "CAD/CAM の C は拾わない");
});
t("R06-7 期待バーは材料とテンプレの組み合わせで決まる", () => {
  eq(A.expectedBars("Stone", null), [11,12,16]);
  eq(A.expectedBars("PEEK", null), [11,12,16]);
  eq(A.expectedBars("HR", null), [50,51,52]);
  eq(A.expectedBars("TiA", "A"), [1,2,4]);
  eq(A.expectedBars("TiP", "B"), [61,62,64]);
  eq(A.expectedBars("TiA", "C"), [66,67,69]);
  eq(A.expectedBars(null, "B"), null, "材料不明なら null");
});
t("R06-8 連結冠(Con)はポンティック0で内訳を補完する", () => {
  const j = A.fillUnits({kind:"Con", units:null, abut:3, pontic:null});
  eq(j.units, 3); eq(j.pontic, 0); eq(j.abut, 3);
});
t("R06-8b Con で全Nも支Nも無ければ units は null のまま（既定値2を作らない）", () => {
  const j = A.fillUnits({kind:"Con", units:null, abut:null, pontic:null});
  eq(j.units, null, "原文に無い歯数を捏造しない");
  eq(j.abut, null);
  eq(j.pontic, 0, "ポンティック0だけは確定情報なので入れる");
  const k = A.fillUnits({kind:"Con", units:5, abut:null, pontic:null});
  eq(k.units, 5); eq(k.abut, 5, "全Nがあれば支Nに逆流させる既存挙動は維持");
});
t("R06-9 .iso 行が無ければジョブは0件", () => {
  eq(A.parseJobLog("情報: なにか\n-- 区切り").length, 0);
});

console.log("\n=== R07: 差分・交換検知・スロット→バー解決 ===");
t("R07-1 RunTime減少で交換検知、finalRun は交換直前の値", () => {
  const cur = {tools:[{slot:1, type:11, run:600, max:90000, cut:5000, flag:0}]};
  const prev = {takenAt:"2026-09-06T09:00", tools:[{slot:1, type:11, run:80000, max:90000, cut:4000, flag:0}]};
  const d = A.buildDiff(cur, prev)[0];
  eq(d.exchanged, true);
  eq(d.finalRun, 80000, "交換直前の生涯RunTime");
  eq(d.dRun, 600, "交換後の新規稼働分");
  eq(d.dCut, 1000, "Cuttingは交換を跨いで累積");
});
t("R07-2 増加時は Δ稼働、初回は前回なしで null", () => {
  const cur = {tools:[{slot:1, type:11, run:5000, max:90000, cut:4000, flag:0}]};
  eq(A.buildDiff(cur, {takenAt:"x", tools:[{slot:1,type:11,run:3000,cut:3500}]})[0].dRun, 2000);
  const first = A.buildDiff(cur, null)[0];
  eq(first.dRun, null); eq(first.dCut, null); eq(first.exchanged, false);
});
t("R07-3 差分はスロットではなくバー番号(Type)でペアリングする", () => {
  const cur  = {tools:[{slot:9, type:11, run:100, max:0, cut:10, flag:0}]};
  const prev = {takenAt:"x", tools:[{slot:1, type:11, run:80, cut:5}]};
  eq(A.buildDiff(cur, prev)[0].dRun, 20, "スロットが移動しても同じバーとして比較される");
});
t("R07-4 barOf はセグメント時刻以降で最初のスナップショットを使う", () => {
  const db = {snapshots:[
    {id:"a", machine:"d1", takenAt:"2026-09-07T12:00", tools:[{slot:9, type:51}]},
    {id:"b", machine:"d1", takenAt:"2026-09-07T18:00", tools:[{slot:9, type:50}]}
  ], exchanges:[], segments:[], jobs:[]};
  eq(A.barOf(db, "d1", 9, "2026-09-07T10:00:00"), 51, "切替前は51");
  eq(A.barOf(db, "d1", 9, "2026-09-07T15:00:00"), 50, "切替後は50");
  eq(A.barOf(db, "d1", 9, "2026-09-07T20:00:00"), 50, "以降のスナップが無ければ最新");
  eq(A.barOf(db, "d1", 3, "2026-09-07T10:00:00"), null, "未登録スロットは null");
  eq(A.barOf(db, "w1", 9, "2026-09-07T10:00:00"), null, "スナップの無いマシンは null");
});
t("R07-5 latestSnapshot は指定時刻より前の最新を返す", () => {
  const db = {snapshots:[
    {id:"a", machine:"d1", takenAt:"2026-09-05T09:00", tools:[]},
    {id:"b", machine:"d1", takenAt:"2026-09-07T09:00", tools:[]},
    {id:"c", machine:"d2", takenAt:"2026-09-08T09:00", tools:[]}
  ]};
  eq(A.latestSnapshot(db, "d1", "2026-09-06T00:00").id, "a");
  eq(A.latestSnapshot(db, "d1", null).id, "b");
  eq(A.latestSnapshot(db, "w1", null), null);
});
t("R07-6 machineFromPath はフォルダ名とファイル名接頭辞の両方を見る", () => {
  eq(A.machineFromPath("data/d1/20260908/MeasureToolRefPosZ.TXT"), "d1");
  eq(A.machineFromPath("data/W2/x/ToolProperties.INI"), "w2", "大文字も可");
  eq(A.machineFromPath("data/backup/d2-MeasureToolRefPosZ.TXT"), "d2", "ファイル名接頭辞");
  eq(A.machineFromPath("data/backup/d2_x.TXT"), "d2");
  eq(A.machineFromPath("data/なぞ/x.TXT"), null);
  eq(A.machineFromPath("data/d3/x.TXT"), null, "存在しないマシン名");
});

console.log("\n=== T17: 順序型 1パス目（2026-09-07 d1） ===");
t("T17-1 #27(11:34) は冠セグメントで打ち切られ 1パス目では null", () => {
  const db = d1db();
  const mt = A.matchSegments(db, D1_JOBS[0], "2026-09-07", null);
  eq(mt, null, "#27 1パス目");
});
t("T17-2 冠3件は従来通り 50/51/52 を1組ずつ消費", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  for(const id of ["j_25a","j_45a","j_16a"]) eq(barsOf(res[id].mt), CROWN, id);
  eq(res["j_25a"].mt.picked[0].a, "2026-09-07T11:46:00");
  eq(res["j_45a"].mt.picked[0].a, "2026-09-07T12:00:00");
  eq(res["j_16a"].mt.picked[0].a, "2026-09-07T12:14:00");
});
t("T17-3 #25(13:13) は 13:36 の孤児16を飛ばし 13:43 の 11 から消費（v0.12のズレが直る）", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  const p = res["j_25b"].mt.picked;
  eq(barsOf(res["j_25b"].mt), STONE);
  eq(p.map(x=>x.a), ["2026-09-07T13:43:30","2026-09-07T13:50:30","2026-09-07T14:08:30"], "#25(13:13) の消費元");
  ok(p.every(x => x.a !== "2026-09-07T13:36:30"), "13:36 の孤児16を食っていない");
});
t("T17-4 支台ジョブは 16 が自分の 12 より後の時刻になる（1件ズレの連鎖が消える）", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  for(const id of ["j_25b","j_44","j_37","j_16b","j_14","j_47","j_11"]){
    const p = res[id].mt.picked;
    eq(p.map(x=>x.bar), STONE, id+" のバー順");
    const t12 = p.find(x=>x.bar===12), t16 = p.find(x=>x.bar===16);
    ok(t16.a > t12.b, `${id}: 16(${t16.a}) が 12(${t12.b}) より後`);
  }
});
t("T17-5 #12 は 11,12 のみで null にしない", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  eq(barsOf(res["j_12"].mt), [11,12], "#12");
});
t("T17-6 #45(17:44) は枯渇で null（救済でも拾えない）", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  eq(res["j_45b"].mt, null, "#45(17:44)");
});
t("T17-7 順序違いは打ち切り（12→11 の並びは 11 で止まる）", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], segments:[
    seg("d1",1,"09:00:00","09:05:00"), seg("d1",3,"09:06:00","09:10:00"), seg("d1",2,"09:11:00","09:20:00")
  ], jobs:[]};
  const mt = A.matchSegments(db, job("x","0900",STONE), "2026-09-07", null);
  eq(barsOf(mt), [11], "11 の次に 16 が来たら打ち切り");
});

console.log("\n=== T18: 2パス目 孤児救済 ===");
t("T18-1 #27 が 12:42 の 11→12 を拾い、救済フラグが立つ", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  const r = res["j_27a"];
  ok(r.rescued, "救済で拾えている");
  eq(barsOf(r.mt), [11,12], "#27 のバー");
  eq(r.mt.picked.map(x=>x.a), ["2026-09-07T12:42:00","2026-09-07T12:52:00"], "#27 の消費元");
});
t("T18-2 13:01 の 11 で再登場打ち切り＝13:01〜13:43 の3本は孤児のまま", () => {
  const db = d1db();
  const {consumed} = runTwoPass(db, D1_JOBS);
  for(const a of ["13:01:00","13:10:30","13:36:30"]){
    ok(!consumed.has("d1|2026-09-07T"+a), a + " は誰にも消費されていない");
  }
});
t("T18-3 2パス目はカーソルを使わず NC時刻以降24hを探す", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], segments:[
    seg("d1",1,"16:00:00","16:05:00"), seg("d1",2,"16:06:00","16:10:00"), seg("d1",3,"16:11:00","16:20:00")
  ], jobs:[]};
  const mt = A.matchSegments(db, job("y","0900",STONE), "2026-09-07", null, {mode:"rescue", segments:db.segments});
  eq(barsOf(mt), STONE, "7時間後のセグメントでも拾う");
});
t("T18-4 24hを超えるセグメントは救済対象外", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], segments:[
    {machine:"d1", slot:1, a:"2026-09-08T10:00:00", b:"2026-09-08T10:05:00"},
    {machine:"d1", slot:2, a:"2026-09-08T10:06:00", b:"2026-09-08T10:10:00"},
    {machine:"d1", slot:3, a:"2026-09-08T10:11:00", b:"2026-09-08T10:20:00"}
  ], jobs:[]};
  const mt = A.matchSegments(db, job("z","0900",STONE), "2026-09-07", null, {mode:"rescue", segments:db.segments});
  eq(mt, null, "翌日25時間後は拾わない");
});

t("T18-5 2パス目は他系の孤児を読み飛ばし、最初の E[0] から消費する（v0.13.2 修正点）", () => {
  // d系の実態: 石膏(11/12/16)とCAD/CAM(50/51/52)が同じ日に混在する。
  // 救済範囲の先頭に別系統の孤児が残っていても、その先の自分のセグメントに届くこと。
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",3,"12:15:00","12:18:00"),                                          // 前ジョブの取りこぼし(16)＝他系の孤児
    seg("d1",8,"12:20:00","12:33:00"), seg("d1",9,"12:34:00","12:36:00"), seg("d1",10,"12:37:00","12:40:00")
  ]};
  const j = job("cr","1213",CROWN);
  eq(A.matchSegments(db, j, "2026-09-07", null, {mode:"rescue", segments:db.segments}) && true, true, "救済できる");
  const mt = A.matchSegments(db, j, "2026-09-07", null, {mode:"rescue", segments:db.segments});
  eq(barsOf(mt), CROWN);
  eq(mt.picked[0].a, "2026-09-07T12:20:00", "12:15 の 16 を読み飛ばして 50 から始まる");
});
t("T18-6 読み飛ばした孤児は消費済みにならない", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",3,"12:15:00","12:18:00"),
    seg("d1",8,"12:20:00","12:33:00"), seg("d1",9,"12:34:00","12:36:00"), seg("d1",10,"12:37:00","12:40:00")
  ]};
  const mt = A.matchSegments(db, job("cr","1213",CROWN), "2026-09-07", null, {mode:"rescue", segments:db.segments});
  ok(!mt.consumedKeys.includes("d1|2026-09-07T12:15:00"), "孤児は他のジョブの救済に残る");
  eq(mt.consumedKeys.length, 3);
});
t("T18-7 1パス目の打ち切りは変わらない（読み飛ばしが漏れていない）", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",3,"12:15:00","12:18:00"),
    seg("d1",8,"12:20:00","12:33:00"), seg("d1",9,"12:34:00","12:36:00"), seg("d1",10,"12:37:00","12:40:00")
  ]};
  eq(A.matchSegments(db, job("cr","1213",CROWN), "2026-09-07", null), null,
     "1パス目は期待外(16)で打ち切り＝別ジョブが始まっているとみなす");
});
t("T18-8 読み飛ばした後も順序ルールは同じ（崩れたら打ち切り）", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",3,"12:15:00","12:18:00"),                     // 他系の孤児
    seg("d1",8,"12:20:00","12:33:00"),                     // 50
    seg("d1",10,"12:34:00","12:36:00"),                    // 52（順序違い）
    seg("d1",9,"12:37:00","12:40:00")                      // 51
  ]};
  const mt = A.matchSegments(db, job("cr","1213",CROWN), "2026-09-07", null, {mode:"rescue", segments:db.segments});
  eq(barsOf(mt), [50], "50 の次が 52 なので打ち切り");
});
t("T18-9 混在日の2ジョブが1パス目で共倒れしても、2パス目で両方拾える", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], segments:[
    seg("d1",3,"12:15:00","12:18:00"),
    seg("d1",8,"12:20:00","12:33:00"), seg("d1",9,"12:34:00","12:36:00"), seg("d1",10,"12:37:00","12:40:00"),
    seg("d1",1,"13:00:00","13:33:00"), seg("d1",2,"13:34:00","13:56:00"), seg("d1",3,"13:57:00","13:59:00")
  ], jobs:[
    {id:"j_br", date:"2026-09-07", hhmm:"1209", machine:"d1", kind:"Br", units:3, expectedBars:STONE},
    {id:"j_cr", date:"2026-09-07", hhmm:"1213", machine:"d1", kind:"Cr", expectedBars:CROWN}
  ]};
  const {res} = runTwoPass(db, db.jobs);
  ok(res["j_br"].rescued && res["j_cr"].rescued, "両方とも2パス目で拾われる");
  eq(barsOf(res["j_br"].mt), STONE);
  eq(barsOf(res["j_cr"].mt), CROWN);
  eq(res["j_cr"].mt.picked[0].a, "2026-09-07T12:20:00", "冠は自分の12:20群");
  eq(res["j_br"].mt.picked[0].a, "2026-09-07T13:00:00", "ブリッジは13:00群");
});

console.log("\n=== T19: 尻尾許容（2026-08-19 w2 long_inside） ===");
// w2 スロット s16=66 s17=67 s18=69（物理と一致＝v0.11のw2補正は発動しない）
const W2_SNAP = {id:"s_w2", machine:"w2", takenAt:"2026-08-20T09:00",
  tools:[{slot:16,type:66,run:0,max:0,cut:0,flag:0},{slot:17,type:67,run:0,max:0,cut:0,flag:0},{slot:18,type:69,run:0,max:0,cut:0,flag:0}]};
function wseg(slot,a,b){ return {machine:"w2", slot, a:"2026-08-19T"+a, b:"2026-08-19T"+b, broken:false}; }
function w2db(tailEnd){
  return {snapshots:[W2_SNAP], exchanges:[], jobs:[], segments:[
    wseg(16,"11:06:00","11:36:00"),
    wseg(17,"11:36:10","12:31:00"),
    wseg(18,"12:32:00","13:10:00"),
    wseg(17,"13:10:39", tailEnd),          // 尻尾候補
    wseg(16,"13:12:40","13:41:00")
  ]};
}
const TIC = [66,67,69];
t("T19-1 ≤10分の E[1] 尻尾は消費し lastEnd が伸びる", () => {
  const db = w2db("13:12:26");
  const j1 = {id:"w1j", date:"2026-08-19", machine:"w2", hhmm:"1100", expectedBars:TIC};
  const mt = A.matchSegments(db, j1, "2026-08-19", null);
  eq(barsOf(mt), TIC, "バー種");
  ok(mt.tail, "尻尾フラグ");
  eq(mt.picked.length, 4, "4本消費（66/67/69＋尻尾67）");
  eq(mt.picked[3].bar, 67);
  eq(mt.picked[3].dur, 107, "尻尾は1:47");
  eq(mt.lastEnd, "2026-08-19T13:12:26", "lastEnd は尻尾込み");
  eq(mt.used[67], 3290 + 107, "67 は本体(11:36:10-12:31:00=3290s)＋尻尾(107s)の合算");
});
t("T19-2 次ジョブは尻尾の直後（13:12:40 の 66）から始まる", () => {
  const db = w2db("13:12:26");
  const j1 = {id:"w1j", date:"2026-08-19", machine:"w2", hhmm:"1100", expectedBars:TIC};
  const j2 = {id:"w2j", date:"2026-08-19", machine:"w2", hhmm:"1300", expectedBars:TIC};
  const mt1 = A.matchSegments(db, j1, "2026-08-19", null);
  const mt2 = A.matchSegments(db, j2, "2026-08-19", mt1.lastEnd);
  eq(mt2.picked[0].a, "2026-08-19T13:12:40", "ジョブ2の開始");
});
t("T19-3 10分超の尻尾は消費しない", () => {
  const db = w2db("13:25:00");   // 14:21 → 861秒
  const j1 = {id:"w1j", date:"2026-08-19", machine:"w2", hhmm:"1100", expectedBars:TIC};
  const mt = A.matchSegments(db, j1, "2026-08-19", null);
  eq(mt.picked.length, 3, "3本のみ");
  ok(!mt.tail, "尻尾フラグは立たない");
  eq(mt.lastEnd, "2026-08-19T13:10:00", "lastEnd は69の終了");
});
t("T19-4 尻尾候補が E[1] 以外なら消費しない", () => {
  const db = w2db("13:12:26");
  db.segments[3].slot = 18;      // 69 が短く再登場しても尻尾ではない
  const j1 = {id:"w1j", date:"2026-08-19", machine:"w2", hhmm:"1100", expectedBars:TIC};
  const mt = A.matchSegments(db, j1, "2026-08-19", null);
  eq(mt.picked.length, 3, "E[2]の再登場は尻尾扱いしない");
});

console.log("\n=== T20: 総量保存（帰属だけが変わる） ===");
t("T20-1 同一セグメントが2つ以上のジョブに帰属しない", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  const seen = new Map();
  for(const j of D1_JOBS){
    const mt = res[j.id].mt; if(!mt) continue;
    for(const k of mt.consumedKeys){
      ok(!seen.has(k), `${k} が ${seen.get(k)} と ${j.id} で二重帰属`);
      seen.set(k, j.id);
    }
  }
});
t("T20-2 帰属した合計 ≦ セグメント総量、かつ孤児5本ぶんだけ少ない", () => {
  const db = d1db();
  const {res} = runTwoPass(db, D1_JOBS);
  const total = {};                                  // 稼働セグメント画面のバー別合計（PARKなし）
  for(const s of D1_SEGS){
    const bar = A.barOf(db, "d1", s.slot, s.b);
    total[bar] = (total[bar]||0) + (Date.parse(s.b)-Date.parse(s.a))/1000;
  }
  const attributed = {};
  for(const j of D1_JOBS){
    const mt = res[j.id].mt; if(!mt) continue;
    for(const b of Object.keys(mt.used)) attributed[b] = (attributed[b]||0) + mt.used[b];
  }
  for(const b of Object.keys(total)) ok((attributed[b]||0) <= total[b], `バー${b}: 帰属${attributed[b]||0} ≦ 総量${total[b]}`);
  // 未帰属＝13:01/13:10/13:36 の孤児3本ぶん
  const orphan = [["13:01:00","13:10:00"],["13:10:30","13:36:00"],["13:36:30","13:43:00"]]
    .reduce((n,[a,b]) => n + (Date.parse("2026-09-07T"+b)-Date.parse("2026-09-07T"+a))/1000, 0);
  const diff = Object.keys(total).reduce((n,b) => n + total[b] - (attributed[b]||0), 0);
  eq(diff, orphan, "未帰属の総量＝孤児3本ぶん");
});
t("T20-3 バー別合計（稼働セグメント画面）は突合の有無に影響されない", () => {
  const db = d1db();
  const before = db.segments.map(s => s.a + "/" + s.b + "/" + s.slot).join(",");
  runTwoPass(db, D1_JOBS);
  const after = db.segments.map(s => s.a + "/" + s.b + "/" + s.slot).join(",");
  eq(after, before, "突合はセグメントを書き換えない");
});

console.log("\n=== T21: Measureログ 最新1本選別 ===");
const F = (p, lm, size) => ({webkitRelativePath:p, name:p.split("/").pop(), lastModified:lm, size});
t("T21-1 マシンごとに lastModified 最大の1本だけ残る", () => {
  const r = A.pickLatestPerMachine([
    F("data/d1/20260901_0900/MeasureToolRefPosZ.TXT", 1000, 10),
    F("data/d1/20260908_0858/MeasureToolRefPosZ.TXT", 3000, 10),
    F("data/d1/20260905_0900/MeasureToolRefPosZ.TXT", 2000, 10),
    F("data/w2/20260908_0900/MeasureToolRefPosZ.TXT", 500, 10)
  ], f => (/\/(d1|d2|w1|w2)\//.exec(f.webkitRelativePath)||[])[1] || null);
  eq(r.picked.map(f=>f.lastModified).sort((a,b)=>a-b), [500,3000], "採用ファイル");
  eq(r.skipped, {d1:2, w2:0}, "スキップ本数");
  eq(r.unknown.length, 0);
});
t("T21-2 lastModified 同値なら size 最大を採る", () => {
  const r = A.pickLatestPerMachine([
    F("data/d2/a/MeasureToolRefPosZ.TXT", 7000, 1024),
    F("data/d2/b/MeasureToolRefPosZ.TXT", 7000, 9999),
    F("data/d2/c/MeasureToolRefPosZ.TXT", 7000, 4096)
  ], f => (/\/(d1|d2|w1|w2)\//.exec(f.webkitRelativePath)||[])[1] || null);
  eq(r.picked.length, 1);
  eq(r.picked[0].size, 9999, "size 最大");
  eq(r.skipped.d2, 2);
});
t("T21-3 マシン判定不可は unknown に落ちる（個別スキップ行の対象）", () => {
  const r = A.pickLatestPerMachine([
    F("data/なぞ/MeasureToolRefPosZ.TXT", 1, 1),
    F("data/w1/x/MeasureToolRefPosZ.TXT", 2, 1)
  ], f => (/\/(d1|d2|w1|w2)\//.exec(f.webkitRelativePath)||[])[1] || null);
  eq(r.unknown.length, 1);
  eq(r.picked.length, 1);
});
t("T21-4 実際の machineFromPath 相当の経路でも d1 が1本に絞られる", () => {
  const files = [];
  for(let i=0;i<31;i++) files.push(F(`data/d1/2026090${i%9}_0900/MeasureToolRefPosZ.TXT`, 1000+i, 10*1024*1024));
  const r = A.pickLatestPerMachine(files, f => "d1");
  eq(r.picked.length, 1);
  eq(r.skipped.d1, 30, "30本スキップ＝ログ1行に集約される本数");
});

console.log("\n=== T22: segCutoff とローリング保持 ===");
t("T22-1 segCutoff は今日の SEG_KEEP_DAYS 日前を YYYY-MM-DD で返す", () => {
  const cut = A.segCutoff(new Date("2026-09-08T10:00:00Z"));
  ok(/^\d{4}-\d{2}-\d{2}$/.test(cut), "書式: " + cut);
  const days = (Date.parse("2026-09-08") - Date.parse(cut)) / 86400000;
  ok(Math.abs(days - A.SEG_KEEP_DAYS) <= 1, `日数差 ${days} ≒ ${A.SEG_KEEP_DAYS}`);
});
t("T22-2 isSegKept はカットオフ当日を残し、前日を落とす", () => {
  ok(A.isSegKept("2026-06-10T09:00:00", "2026-06-10"), "当日は保持");
  ok(A.isSegKept("2026-06-11T00:00:00", "2026-06-10"), "翌日は保持");
  ok(!A.isSegKept("2026-06-09T23:59:59", "2026-06-10"), "前日は落とす");
});
t("T22-3 loadDB のフィルタと取込の間引きが同じ判定を使う", () => {
  const cut = A.segCutoff();
  const oldA = "2000-01-01T00:00:00";
  const newA = TODAY + "T09:00:00";
  APP.store.set("toolltm.v1", JSON.stringify({
    snapshots:[], exchanges:[], jobs:[],
    segments:[{machine:"d1",slot:1,a:oldA,b:oldA}, {machine:"d1",slot:1,a:newA,b:newA}]
  }));
  const db = A.loadDB();
  eq(db.segments.length, 1, "古い方は loadDB で落ちる");
  eq(A.isSegKept(oldA, cut), false, "取込側も同じ判定");
  eq(A.isSegKept(db.segments[0].a, cut), true);
  APP.store.delete("toolltm.v1");
});
t("T22-4 SEG_EPOCH は残っていない（固定エポックの廃止）", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  ok(!/(const|let|var)\s+SEG_EPOCH/.test(html), "SEG_EPOCH の宣言がソースに残存");
  ok(!/s\.a\s*[<>]=?\s*SEG_EPOCH/.test(html), "SEG_EPOCH による判定が残存");
  ok(/SEG_KEEP_DAYS\s*=\s*60/.test(html), "SEG_KEEP_DAYS=60");
});
t("T22-5 SEG_KEEP_DAYS は 60", () => { eq(A.SEG_KEEP_DAYS, 60); });

console.log("\n=== T25: 期待バー不明ジョブの貪欲消費（v0.12互換） ===");
function greedyDb(){
  return {snapshots:[D1_SNAP], exchanges:[], jobs:[], segments:[
    seg("d1",1,"09:00:00","09:10:00"),   // 11
    seg("d1",2,"09:11:00","09:20:00"),   // 12
    seg("d1",3,"09:21:00","09:25:00"),   // 16
    seg("d1",1,"09:26:00","09:35:00"),   // 11 再登場＝次のワーク
    seg("d1",2,"09:36:00","09:45:00")
  ]};
}
const UNKNOWN = {id:"j_unk", date:"2026-09-07", machine:"d1", hhmm:"0855", expectedBars:null, raw:"unk"};
t("T25-1 期待バー null でも null を返さず、再登場まで貪欲に拾う", () => {
  const mt = A.matchSegments(greedyDb(), UNKNOWN, "2026-09-07", null);
  ok(mt, "null ではない");
  eq(barsOf(mt), [11,12,16], "3本拾う");
  eq(mt.picked.length, 3, "11 の再登場で打ち切り");
});
t("T25-2 estimated フラグが立つ（表示の「(推定)」の根拠）", () => {
  const mt = A.matchSegments(greedyDb(), UNKNOWN, "2026-09-07", null);
  ok(mt.estimated, "estimated");
  const normal = A.matchSegments(d1db(), D1_JOBS[4], "2026-09-07", null);
  ok(!normal.estimated, "期待バーありは estimated にならない");
});
t("T25-3 カーソルが前進し、後続ジョブが2パス目送りにならない", () => {
  const db = greedyDb();
  const jobs = [UNKNOWN, {id:"j_next", date:"2026-09-07", machine:"d1", hhmm:"0900", expectedBars:STONE, raw:"n"}];
  const {res} = runTwoPass(db, jobs);
  eq(res["j_unk"].mt.lastEnd, "2026-09-07T09:25:00", "貪欲ジョブの lastEnd");
  ok(!res["j_next"].rescued, "後続は1パス目で解決");
  eq(res["j_next"].mt.picked[0].a, "2026-09-07T09:26:00", "後続はカーソル以降から開始");
});
t("T25-4 貪欲でもPARK(12h超)は拾わず、合計に24hが混入しない", () => {
  const db = greedyDb();
  db.segments[0] = {machine:"d1", slot:1, a:"2026-09-07T09:00:00", b:"2026-09-08T09:00:01", broken:false};
  const mt = A.matchSegments(db, UNKNOWN, "2026-09-07", null);
  eq(mt.used[11], 540, "11 は 09:26-09:35 の540秒のみ（24hの装着放置は除外）");
  eq(mt.picked.map(p=>p.a), ["2026-09-07T09:11:00","2026-09-07T09:21:00","2026-09-07T09:26:00"], "PARKを飛ばして続行");
});
t("T25-5 貪欲でも消費セグメントは二重帰属しない", () => {
  const db = greedyDb();
  const jobs = [UNKNOWN, {id:"j_next", date:"2026-09-07", machine:"d1", hhmm:"0900", expectedBars:STONE, raw:"n"}];
  const {res} = runTwoPass(db, jobs);
  const a = new Set(res["j_unk"].mt.consumedKeys);
  for(const k of res["j_next"].mt.consumedKeys) ok(!a.has(k), k + " が二重帰属");
});

console.log("\n=== T26: 保存領域の表示 ===");
t("T26-1 lsUsageLine は「保存領域 x.x / 5.0 MB」の形", () => {
  APP.store.clear();
  APP.store.set("toolltm.v1", "x".repeat(524288 - 10));   // キー10文字込みで 512K文字 → UTF-16で1.0MB
  const line = A.lsUsageLine();
  ok(/^保存領域 \d+\.\d \/ 5\.0 MB$/.test(line), "書式: " + line);
  eq(line, "保存領域 1.0 / 5.0 MB");
  APP.store.clear();
});
t("T26-2 使用量はキー＋値をUTF-16(char×2)で数える", () => {
  APP.store.clear();
  APP.store.set("ab", "cd");
  eq(A.lsUsageBytes(), 8, "(2+2)*2");
  APP.store.set("ef", "日本語");
  eq(A.lsUsageBytes(), 8 + (2+3)*2);
  APP.store.clear();
});
t("T26-3 LS_LIMIT_MB は 5.0", () => { eq(A.LS_LIMIT_MB, 5.0); });

console.log("\n=== T23: 交換CSV の理由・メモ列 ===");
t("T23-1 ヘッダ末尾に 理由,メモ が付く", () => {
  const csv = A.exchangesCsv([]);
  ok(csv.trim().endsWith("手入力補正,理由,メモ"), "ヘッダ: " + csv.trim());
});
t("T23-2 値が出力され、メモ内のカンマはクォートされる", () => {
  const csv = A.exchangesCsv([{
    detectedAt:"2026-09-08T09:00", machine:"w2", type:67, finalRun:43658,
    cutAtExchange:12000, prevTakenAt:"2026-09-07T18:00", finalRunEdited:false,
    reason:"寿命(切削面)", memo:"前歯Br,口蓋側に横線"
  }]);
  const row = csv.trim().split("\n")[1];
  ok(row.includes(",寿命(切削面),"), "理由が素で出る: " + row);
  ok(row.endsWith('"前歯Br,口蓋側に横線"'), "メモがクォートされる: " + row);
  const head = row.split('"')[0].split(",").slice(0,9);
  eq(head, ["2026-09-08T09:00","w2","67","43658","12:07:38","03:20:00","2026-09-07T18:00","0","寿命(切削面)"], "理由までの9列");
});
t("T23-3 未記入は空欄、ダブルクォートと改行もエスケープされる", () => {
  const csv = A.exchangesCsv([
    {detectedAt:"a", machine:"d1", type:50, finalRun:1, cutAtExchange:1, prevTakenAt:"b", finalRunEdited:false},
    {detectedAt:"a", machine:"d1", type:51, finalRun:1, cutAtExchange:1, prevTakenAt:"b", finalRunEdited:false,
     reason:"脱落", memo:'ディスク"厚"\n再発'}
  ]);
  const lines = csv.split("\n");
  ok(lines[1].endsWith(",,"), "未記入は空欄2つ: " + lines[1]);
  ok(csv.includes('"ディスク""厚""\n再発"'), "クォート二重化と改行の内包");
});
t("T23-4 EX_REASONS は指示書の7種", () => {
  eq(A.EX_REASONS, ["段取り","寿命(切削面)","脱落","折損","異音","傷(品質)","その他"]);
});
t("T23-5 setExReason は保存し、空選択で null に戻る", () => {
  APP.store.set("toolltm.v1", JSON.stringify({snapshots:[], jobs:[], segments:[],
    exchanges:[{id:"e1", machine:"w2", type:67, detectedAt:"2026-09-08T09:00", prevTakenAt:"2026-09-07T18:00", finalRun:1, cutAtExchange:1}]}));
  A.setExReason("e1", "折損");
  eq(A.loadDB().exchanges[0].reason, "折損");
  A.setExReason("e1", "");
  eq(A.loadDB().exchanges[0].reason, null);
  APP.store.delete("toolltm.v1");
});

console.log("\n=== T27: jobsCsv の列とエスケープ（v0.13.1） ===");
const HEAD27 = ["日付","時刻","マシン","種別","材料","厚み","テンプレ","テンプレ名","歯式",
                "全","支台","ポン","前","ユ","期待バー","実消費(バー別)",
                "役割1秒","役割2秒","役割3秒","尻尾秒","合計秒","合計","状態","注記","歯数(算出)"];
function csvRows(csv){                       // クォート内の改行を潰さずに行へ割る素朴なパーサ
  const rows = []; let cur = [], f = "", q = false;
  for(let i=0;i<csv.length;i++){
    const c = csv[i];
    if(q){
      if(c === '"' && csv[i+1] === '"'){ f += '"'; i++; }
      else if(c === '"') q = false;
      else f += c;
    }else if(c === '"') q = true;
    else if(c === ","){ cur.push(f); f = ""; }
    else if(c === "\n"){ cur.push(f); rows.push(cur); cur = []; f = ""; }
    else if(c !== "\r") f += c;
  }
  if(f !== "" || cur.length) { cur.push(f); rows.push(cur); }
  rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}
t("T27-1 ヘッダが25列・指定の順で出る（BOM付き）", () => {
  const csv = A.jobsCsv({jobs:[], segments:[], snapshots:[], exchanges:[]});
  ok(csv.startsWith("\uFEFF"), "BOM");
  eq(csvRows(csv)[0], HEAD27);
});
t("T27-2 歯数(算出): クラウン=1 / 石膏支台=1 / Br=全N / Con=fillUnits後の値", () => {
  const db = {snapshots:[], exchanges:[], segments:[], jobs:[
    {id:"a", date:"2026-09-07", hhmm:"0900", machine:"d1", kind:"Cr",    units:null, expectedBars:CROWN},
    {id:"b", date:"2026-09-07", hhmm:"0901", machine:"d1", kind:"石支台", units:null, expectedBars:STONE},
    {id:"c", date:"2026-09-07", hhmm:"0902", machine:"w1", kind:"Br",    units:3,    expectedBars:[61,62,64]},
    {id:"d", date:"2026-09-07", hhmm:"0903", machine:"w1", kind:"Con",   ...A.fillUnits({kind:"Con", units:null, abut:4, pontic:null})},
    {id:"e", date:"2026-09-07", hhmm:"0904", machine:"w1", kind:"In",    units:null, expectedBars:CROWN}
  ]};
  const col = HEAD27.indexOf("歯数(算出)");
  eq(csvRows(A.jobsCsv(db)).slice(1).map(r => r[col]), ["1","1","3","4","1"]);
});
t("T27-3 全N の無い Br は歯数(算出)が空になる（書き漏れは合計に乗らない）", () => {
  const db = {snapshots:[], exchanges:[], segments:[], jobs:[
    {id:"a", date:"2026-09-07", hhmm:"0900", machine:"w1", kind:"Br", units:null, teeth:"45-47", expectedBars:[61,62,64]}
  ]};
  const r = csvRows(A.jobsCsv(db))[1];
  eq(r[HEAD27.indexOf("歯数(算出)")], "", "空");
  eq(r[HEAD27.indexOf("全")], "", "原文の全列も空のまま");
});
t("T27-4 注記のカンマ・改行・ダブルクォートがクォートされ、原文が復元できる", () => {
  const note = 'w1 TiA Br B #45-47 全3, 前2\n"再加工"';
  const db = {snapshots:[], exchanges:[], segments:[], jobs:[
    {id:"a", date:"2026-09-07", hhmm:"0900", machine:"w1", kind:"Br", units:3, note, expectedBars:[61,62,64]}
  ]};
  const csv = A.jobsCsv(db);
  ok(csv.includes('"w1 TiA Br B #45-47 全3, 前2\n""再加工"""'), "クォート済み: " + JSON.stringify(csv));
  const rows = csvRows(csv);
  eq(rows.length, 2, "改行込みでも1行のまま");
  eq(rows[1][HEAD27.indexOf("注記")], note, "原文が復元できる");
});
t("T27-5 種別は KIND 辞書で日本語化され、辞書外はそのまま出る", () => {
  const db = {snapshots:[], exchanges:[], segments:[], jobs:[
    {id:"a", date:"2026-09-07", hhmm:"0900", machine:"d1", kind:"石支台", expectedBars:STONE},
    {id:"b", date:"2026-09-07", hhmm:"0901", machine:"d1", kind:"謎",     expectedBars:STONE},
    {id:"c", date:"2026-09-07", hhmm:"0902", machine:"d1", kind:null,     expectedBars:STONE}
  ]};
  const col = HEAD27.indexOf("種別");
  eq(csvRows(A.jobsCsv(db)).slice(1).map(r => r[col]), ["石膏支台","謎",""]);
});
t("T27-6 全ジョブが出る（画面フィルタに依らず db.jobs 全件・日時昇順）", () => {
  const db = {snapshots:[], exchanges:[], segments:[], jobs:[
    {id:"c", date:"2026-09-08", hhmm:"0900", machine:"d2", kind:"Cr", expectedBars:CROWN},
    {id:"a", date:"2026-09-07", hhmm:"0900", machine:"d1", kind:"Cr", expectedBars:CROWN},
    {id:"b", date:"2026-09-07", hhmm:"1400", machine:"w1", kind:"Cr", expectedBars:CROWN}
  ]};
  const rows = csvRows(A.jobsCsv(db)).slice(1);
  eq(rows.map(r => r[0] + " " + r[1]), ["2026-09-07 09:00","2026-09-07 14:00","2026-09-08 09:00"]);
});

t("T27-7 Br/Con で全Nが無い行は状態列に 全N欠 が + 連結で付く", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], segments:[
    seg("d1",1,"09:00:00","09:10:00"), seg("d1",2,"09:11:00","09:20:00"), seg("d1",3,"09:21:00","09:25:00")
  ], jobs:[
    {id:"a", date:"2026-09-07", hhmm:"0855", machine:"d1", kind:"Br",  units:null, teeth:"45-47", expectedBars:STONE},
    {id:"b", date:"2026-09-07", hhmm:"0930", machine:"d1", kind:"Br",  units:3,    teeth:"45-47", expectedBars:STONE},
    {id:"c", date:"2026-09-07", hhmm:"0931", machine:"d1", kind:"Con", units:null, teeth:"35-36", expectedBars:STONE},
    {id:"c2", date:"2026-09-07", hhmm:"0933", machine:"d1", kind:"Con", teeth:"35-36", expectedBars:STONE,
     ...A.fillUnits({kind:"Con", units:null, abut:null, pontic:null})},
    {id:"c3", date:"2026-09-07", hhmm:"0934", machine:"d1", kind:"Con", teeth:"35-36", expectedBars:STONE,
     ...A.fillUnits({kind:"Con", units:null, abut:3, pontic:null})},
    {id:"d", date:"2026-09-07", hhmm:"0932", machine:"d1", kind:"Cr",  units:null, teeth:"14",    expectedBars:STONE},
    {id:"e", date:"2020-01-01", hhmm:"0900", machine:"d1", kind:"Br",  units:null, teeth:"45-47", expectedBars:STONE}
  ]};
  const rows = csvRows(A.jobsCsv(db)).slice(1);
  const st = Object.fromEntries(rows.map(r => [r[0] + " " + r[1], r[HEAD27.indexOf("状態")]]));
  eq(st["2026-09-07 08:55"], "ok+全N欠",     "突合できた Br でも全N欠が付く");
  eq(st["2026-09-07 09:30"], "未突合",       "全Nがあれば付かない");
  eq(st["2026-09-07 09:31"], "未突合+全N欠", "Con も対象・突合の成否とは独立");
  eq(st["2026-09-07 09:33"], "未突合+全N欠", "fillUnits を通した支N無しの Con でも発火する（既定値2が作られない）");
  eq(st["2026-09-07 09:34"], "未突合", "支Nから導出できた Con には付かない");
  eq(st["2026-09-07 09:32"], "未突合",       "Cr は対象外（歯数1が入るため）");
  eq(st["2020-01-01 09:00"], "保持期間外+全N欠", "保持期間外でも付く");
  const brRow = rows.find(r => r[1] === "08:55");
  eq(brRow[HEAD27.indexOf("歯数(算出)")], "", "歯数(算出)は空のまま");
});

console.log("\n=== T28: 画面とCSVが同じ突合結果を使う ===");
t("T28-1 9/7 d1 の状態列が 救済 / ok / 未突合 になる", () => {
  const db = d1db();
  const rows = csvRows(A.jobsCsv(db)).slice(1);
  const st = {};
  for(const r of rows) st[r[1] + "_" + r[HEAD27.indexOf("歯式")]] = r[HEAD27.indexOf("状態")];
  const byTime = Object.fromEntries(rows.map(r => [r[1], r[HEAD27.indexOf("状態")]]));
  eq(byTime["11:34"], "救済", "#27 は2パス目で救済");
  eq(byTime["13:13"], "ok",   "#25 は通常突合");
  eq(byTime["17:44"], "未突合", "#45 は枯渇");
  eq(byTime["17:42"], "ok",   "#12 は 11,12 のみでも ok");
});
t("T28-2 CSV と computeJobMatches の結果が一致する（二重実装になっていない）", () => {
  const db = d1db();
  const list = db.jobs.slice().sort((a,b)=>(a.date+a.hhmm)<(b.date+b.hhmm)?-1:1);
  const res = A.computeJobMatches(db, list);
  const rows = csvRows(A.jobsCsv(db)).slice(1);
  const iTotal = HEAD27.indexOf("合計秒");
  list.forEach((j, i) => {
    const mt = res[j.id].mt;
    const want = mt ? String(Object.values(mt.used).reduce((n,v)=>n+v,0)) : "";
    eq(rows[i][iTotal], want, j.id + " の合計秒");
  });
});
t("T28-3 renderJobs は画面フィルタが掛かっても全件で突合する", () => {
  // 日跨ぎの仕掛け: 前日NCのジョブが翌日未明のセグメントを消費する。
  // 日付フィルタで前日ジョブが落ちるとカーソルが引き継がれず、当日ジョブが前日ぶんを食ってしまう。
  const d0 = "2026-09-06", d1 = "2026-09-07";
  const S = (slot,a,b) => ({machine:"d1", slot, a:d1+"T"+a, b:d1+"T"+b, broken:false});
  const db = {snapshots:[D1_SNAP], exchanges:[], segments:[
    S(1,"00:35:00","00:40:00"), S(2,"00:45:00","00:52:00"), S(3,"00:55:00","01:04:00"),  // 前日NCジョブのぶん
    S(1,"01:10:00","01:22:00"), S(2,"01:23:00","01:36:00"), S(3,"01:37:00","01:51:00")   // 当日ジョブのぶん
  ], jobs:[
    {id:"prev", date:d0, hhmm:"2300", machine:"d1", kind:"石支台", expectedBars:STONE, raw:"prev"},
    {id:"curr", date:d1, hhmm:"0030", machine:"d1", kind:"石支台", expectedBars:STONE, raw:"curr"}
  ]};
  APP.store.set("toolltm.v1", JSON.stringify(db));
  const render = (m, d) => {
    APP.el("jobViewMachine").value = m; APP.el("jobViewDate").value = d;
    A.renderJobs();
    return APP.el("jobListArea").innerHTML;
  };
  const rowOf = (html, date) => (html.split("<tr>").find(r => r.includes("<td>"+date+"</td>")) || "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const unfiltered = rowOf(render("", ""), d1);
  const byDate     = rowOf(render("", d1), d1);
  const byMachine  = rowOf(render("d1", ""), d1);
  ok(/11=00:12:00/.test(unfiltered), "当日ジョブは自分の 01:10 群を消費: " + unfiltered);
  eq(byDate, unfiltered, "日付で絞っても同じ行になる");
  eq(byMachine, unfiltered, "マシンで絞っても同じ行になる");
  APP.store.delete("toolltm.v1");
});
t("T28-4 保持期間外のジョブは件数・歯数が出て、秒の列は空", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], segments:[], jobs:[
    {id:"old", date:"2020-01-05", hhmm:"0912", machine:"w1", kind:"Cr", units:null,
     teeth:"14", userdef:4, expectedBars:[61,62,64]}
  ]};
  const r = csvRows(A.jobsCsv(db))[1];
  eq(r[HEAD27.indexOf("状態")], "保持期間外");
  eq(r[HEAD27.indexOf("歯数(算出)")], "1", "歯数は入る");
  eq(r[HEAD27.indexOf("ユ")], "4", "ユ数も入る");
  eq(r[HEAD27.indexOf("期待バー")], "61/62/64", "期待バーも入る");
  for(const c of ["実消費(バー別)","役割1秒","役割2秒","役割3秒","尻尾秒","合計秒","合計"]){
    eq(r[HEAD27.indexOf(c)], "", c + " は空");
  }
});
t("T28-5 未突合のジョブも同様に秒の列だけ空", () => {
  const db = d1db();
  const rows = csvRows(A.jobsCsv(db)).slice(1);
  const r = rows.find(x => x[1] === "17:44");
  eq(r[HEAD27.indexOf("状態")], "未突合");
  for(const c of ["実消費(バー別)","役割1秒","役割2秒","役割3秒","尻尾秒","合計秒","合計"]){
    eq(r[HEAD27.indexOf(c)], "", c + " は空");
  }
});

console.log("\n=== T29: 役割列と尻尾秒 ===");
t("T29-1 役割列はバー番号でなく期待バーの位置で決まる", () => {
  const db = d1db();
  const rows = csvRows(A.jobsCsv(db)).slice(1);
  const iu = HEAD27.indexOf("実消費(バー別)"), r1 = HEAD27.indexOf("役割1秒"), r3 = HEAD27.indexOf("役割3秒");
  const stone = rows.find(x => x[1] === "13:13");     // 11/12/16
  const crown = rows.find(x => x[1] === "13:00" || x[HEAD27.indexOf("期待バー")] === "50/51/52");
  eq(stone[HEAD27.indexOf("期待バー")], "11/12/16");
  eq(crown[HEAD27.indexOf("期待バー")], "50/51/52");
  eq(stone[r1], stone[iu].split(";").find(x=>x.startsWith("11=")).split("=")[1], "石膏は11が役割1");
  eq(crown[r1], crown[iu].split(";").find(x=>x.startsWith("50=")).split("=")[1], "冠は50が役割1");
  eq(stone[r3], stone[iu].split(";").find(x=>x.startsWith("16=")).split("=")[1], "石膏は16が役割3");
  eq(crown[r3], crown[iu].split(";").find(x=>x.startsWith("52=")).split("=")[1], "冠は52が役割3");
});
t("T29-2 尻尾秒は独立列に出て、かつ役割2秒に含まれる", () => {
  const db = w2db("13:12:26");
  db.jobs = [{id:"w1j", date:"2026-08-19", hhmm:"1100", machine:"w2", kind:"Br", units:3,
              teeth:"25-27", material:"TiA", templateName:"long_inside", expectedBars:TIC}];
  const r = csvRows(A.jobsCsv(db))[1];
  eq(r[HEAD27.indexOf("状態")], "尻尾");
  eq(r[HEAD27.indexOf("尻尾秒")], "107");
  eq(r[HEAD27.indexOf("役割2秒")], String(3290 + 107), "本体3290 + 尻尾107");
  eq(r[HEAD27.indexOf("合計秒")], String(1800 + 3290 + 107 + 2280), "全バーの合計");
});
t("T29-3 尻尾なしの突合済みジョブは尻尾秒が 0", () => {
  const db = d1db();
  const r = csvRows(A.jobsCsv(db)).slice(1).find(x => x[1] === "13:13");
  eq(r[HEAD27.indexOf("尻尾秒")], "0");
});
t("T29-4 推定(期待バー空)は役割1〜3が空、合計秒だけ出る", () => {
  const db = {snapshots:[D1_SNAP], exchanges:[], jobs:[
    {id:"u", date:"2026-09-07", hhmm:"0855", machine:"d1", kind:"Cr", expectedBars:null}
  ], segments:[
    seg("d1",1,"09:00:00","09:10:00"), seg("d1",2,"09:11:00","09:20:00"), seg("d1",3,"09:21:00","09:25:00")
  ]};
  const r = csvRows(A.jobsCsv(db))[1];
  eq(r[HEAD27.indexOf("状態")], "推定");
  eq(r[HEAD27.indexOf("期待バー")], "");
  for(const c of ["役割1秒","役割2秒","役割3秒"]) eq(r[HEAD27.indexOf(c)], "", c);
  eq(r[HEAD27.indexOf("合計秒")], "1380", "600+540+240");
  eq(r[HEAD27.indexOf("合計")], "00:23:00");
});
t("T29-5 状態は複数該当を + で連結する（救済+尻尾）", () => {
  // w2 に冠スロットも持たせ、C系ジョブの窓の先頭を冠セグメントで塞ぐ。
  // 1パス目: C系は期待外(50)で打ち切り→null、冠ジョブが50/51/52を消費。
  // 2パス目: 未消費になった 66/67/69＋尻尾67 を C系が拾い直す → 救済 かつ 尻尾。
  const snap = {id:"s_w2b", machine:"w2", takenAt:"2026-08-20T09:00", tools:[
    {slot:16,type:66,run:0,max:0,cut:0,flag:0},{slot:17,type:67,run:0,max:0,cut:0,flag:0},
    {slot:18,type:69,run:0,max:0,cut:0,flag:0},{slot:8,type:50,run:0,max:0,cut:0,flag:0},
    {slot:9,type:51,run:0,max:0,cut:0,flag:0},{slot:10,type:52,run:0,max:0,cut:0,flag:0}]};
  const db = {snapshots:[snap], exchanges:[], segments:[
    wseg(8,"09:30:00","09:34:00"), wseg(9,"09:35:00","09:38:00"), wseg(10,"09:39:00","09:40:00"),
    wseg(16,"11:06:00","11:36:00"), wseg(17,"11:36:10","12:31:00"),
    wseg(18,"12:32:00","13:10:00"), wseg(17,"13:10:39","13:12:26")
  ], jobs:[
    {id:"tic",   date:"2026-08-19", hhmm:"0900", machine:"w2", kind:"Br", units:3, expectedBars:TIC},
    {id:"crown", date:"2026-08-19", hhmm:"0905", machine:"w2", kind:"Cr", expectedBars:CROWN}
  ]};
  const rows = csvRows(A.jobsCsv(db)).slice(1);
  const st = Object.fromEntries(rows.map(r => [r[1], r[HEAD27.indexOf("状態")]]));
  eq(st["09:00"], "救済+尻尾", "C系は2パス目で拾われ、尻尾も食っている");
  eq(st["09:05"], "ok", "冠は通常突合");
  const tic = rows.find(r => r[1] === "09:00");
  eq(tic[HEAD27.indexOf("尻尾秒")], "107");
});

console.log("\n=== ⑥ 同梱の小修正（long_inside） ===");
t("T24-1 \"C(long_inside)\" が インレー誤検出されない", () => {
  const r = A.parseNoteLine("w2 TiA Cr C(long_inside) #16 全1");
  ok(r.kind !== "In", "kind=" + r.kind);
  eq(r.kind, "Cr");
});
t("T24-2 石支台は includes で拾える", () => {
  eq(A.parseNoteLine("d1 Stone 石支台 #36 全1").kind, "石支台");
});
t("T24-3 templateName に long_inside が入る", () => {
  eq(A.parseNoteLine("w2 TiA Cr C(long_inside) #16 全1").templateName, "long_inside");
  eq(A.parseNoteLine("w2 TiA Cr C(LONG_INSIDE) #16 全1").templateName, "LONG_INSIDE");
});
t("T24-4 既存の templateName（insurance_v2 / Slow）は壊れない", () => {
  eq(A.parseNoteLine("d2 CAD Cr insurance_v2 #22 全1").templateName, "insurance_v2");
  eq(A.parseNoteLine("w1 TiA Br B #45-47 Slow 全3").templateName, "Slow");
});
t("T24-5 long_inside ジョブでも expectedBars は C系のまま", () => {
  const r = A.parseNoteLine("w2 TiA Cr C(long_inside) #16 全1");
  eq(A.expectedBars(r.material, r.template), [66,67,69]);
});

(async () => {
  console.log("\n=== R08: ファイル読み取り（UTF-16LE フォールバック・v0.11） ===");
  const mkFile = buf => ({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  await tAsync("R08-1 通常のUTF-8はそのまま読める（日本語含む）", async () => {
    const text = "2026-09-07, 09:00:00.0 Storing measuring result of tool 1 after toolchange\n日本語";
    eq(await A.readFileText(mkFile(Buffer.from(text, "utf8"))), text);
  });
  await tAsync("R08-2 d系のUTF-16LEログはNUL検出で再デコードされる", async () => {
    const text = "2026-09-07, 09:00:00.0 Storing measuring result of tool 1 after toolchange";
    const got = await A.readFileText(mkFile(Buffer.from(text, "utf16le")));
    eq(got, text, "UTF-8で読むとNULが混ざる → UTF-16LEで読み直す");
    eq(A.parseMeasure(got).length, 0, "装着のみなのでセグメントは0（パースは通る）");
  });
  await tAsync("R08-3 空ファイルでも落ちない", async () => {
    eq(await A.readFileText(mkFile(Buffer.alloc(0))), "");
  });
  report();
})();
