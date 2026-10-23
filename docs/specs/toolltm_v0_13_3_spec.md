# ToolLtm v0.13.3 実装指示書 — ジルコニア対応・テンプレ名の拡張・交換履歴の表示制限

作成: 2026-10-20 ／ 対象: `index.html`（v0.13.2）＋ `test_v0_13.js`（113本）
規模: 小〜中（定数の一本化・関数1つ・UI2箇所・テスト4群）。突合ロジックの変更は**なし**。
実装者への前提: 単一HTMLファイルのまま。`node test_v0_13.js` が 113/113 pass の状態から始め、終了時も全pass であること。design-doc.md の更新は本指示書の範囲外（別紙「design-doc 追記」を参照）。

---

## 0. 背景（なぜこの5点か）

2026-10-19〜20 の運用で判明した事実:

1. **ジルコニアが「材料不明」になる**: `BAR_MAP` に `Zr:[13,14,15]` / `Zr_Fissure:[13,14,33]` は v0.8 から定義されているが、NC名・注記のどちらの材料トークン正規表現にも `Zr` が無く、`expectedBars()` にも分岐が無い。定義だけあって配線されていない状態。結果、Zr ジョブは期待バー空→貪欲消費「(推定)」に落ち、d2 で後続の CAD/CAM 冠（50/51/52）まで食う可能性がある。
2. **注記の書式が画面のどこにも出ていない**: 認識する語（材料・テンプレ・種別）はコードと設計書 §6 と本人の記憶に分散し、貼り付け欄には例が1行あるだけ。「覚えられない」はこの構造の帰結。
3. **`Normal` は書いても残らない**: templateName のホワイトリストに無いため null で保存されていた。Normal/Slow で加工時間が約1.5倍違う＝バー保持時間の分母が変わるので、ToolLtm の寿命集計に直接関係する。
4. **交換履歴が長くなり視認性が落ちた**: 全件を常時表示している。見たいのはほぼ最新数件。
5. 材料トークンの正規表現が NC名用と注記用の2箇所に重複しており、追加のたびに2箇所直す構造。

---

## 1. 変更一覧

| # | 項目 | 触る場所（v0.13.2 の行番号は目安） |
|---|---|---|
| ① | 材料トークンを定数 `MAT_TOKENS` に一本化し `Zr` を追加 | `parseNcPath`（L378）、`parseNoteLine`（L407） |
| ② | `expectedBars` に Zr 分岐と第3引数 `fissure` | `expectedBars`（L438）、呼び出し2箇所（L484, L488） |
| ③ | テンプレ名トークン: `Normal` を追加、`Fissure` を独立フラグ `job.fissure` に | `parseNoteLine` の `tn`（L432）、`parseJobLog` の job 組み立て（L473〜） |
| ④ | 貼り付け欄の下に「認識する語」を定数から生成して表示 | `jobInput`（L145）直下、init |
| ⑤ | 交換履歴: 既定で最新10件＋「すべて表示」＋マシン絞り込み | `renderExchanges`（L681）、`exchangeArea`（L116） |
| ⑥ | CSV: 列26「裂溝」を追加、画面の加工物欄に裂溝タグ | `jobsCsv`（L845）、`fmtUnits`（L1114） |

---

## ① 材料トークンの一本化と Zr

**仕様**
- 定数を追加する: `const MAT_TOKENS = ["TiA","TiP","Zr","Stone","WAX","PMMA","PEEK","HR"];`
- `parseNcPath` の `matToken` 判定と `parseNoteLine` の `mat` 判定は、どちらもこの配列から正規表現を組み立てる（`new RegExp("^(" + MAT_TOKENS.join("|") + ")$", "i")` 等）。**文字列リテラルの正規表現を2箇所に残さない。**
- 大文字小文字は従来どおり無視（`zr` / `ZR` も拾う）。保存する `material` の値は従来どおりマッチした原文（`Zr`）。
- `CAD` の第2信号（`\bCAD\b` → CADCAM）は変更しない。

**根拠**: 定数化しておけば ④ の表示とテスト T32 が同じ配列を参照でき、「コードと画面の食い違い」が構造的に起きない。

---

## ② expectedBars の Zr 分岐

**仕様**
```
function expectedBars(material, template, fissure){
  ...既存の STONE系 / HR系 / TiA系 の分岐は変更しない...
  if(M === "ZR") return fissure ? BAR_MAP.Zr_Fissure : BAR_MAP.Zr;   // 13/14/33 : 13/14/15
  return null;
}
```
- 第3引数は省略可（既存テストの2引数呼び出しを壊さない）。
- 呼び出し側（`parseJobLog`）は `expectedBars(job.material, job.template, job.fissure)` に変更。CADCAM 仮定の分岐（L488）は `fissure` を渡さなくてよい。
- Zr にテンプレ A/B/C の区分は無い。`template` が入っていても無視する（Zr の分岐は `template` を見ない）。

**確定事項（本人確認済み 2026-10-20）**: d2 のジルコニア用バーのスロットは 13/14/15。裂溝用は 15 が 33 に置き換わる。

---

## ③ テンプレ名トークンの拡張と `fissure` フラグ

### 現行の問題
`tn` のホワイトリストは `[A-Za-z]+_v\d+` / `insurance\w*` / `long_inside` / `Slow` の4種。`Normal` は拾われず null。`Fissure` も拾われない。

### 新仕様

**(a) テンプレ名（戦略）**: `templateName` は従来どおり**単一の文字列**。ホワイトリストに `Normal` を追加する。優先順位は既存どおり（`_v\d+` → `insurance*` → `long_inside` → `Slow` → `Normal` の順で最初に当たったもの）。
- **境界規則**: `long_inside` / `Slow` / `Normal` の判定は、(b) の `Fissure` と同じ「前後が英数字でなければ一致」（`(?<![A-Za-z0-9])…(?![A-Za-z0-9])`、大文字小文字無視）にする。既存の `\b(Slow)\b` / `\b(long_inside)\b` もこれに置き換える。理由: 正規表現の `\b` は `_` を単語文字として扱うため、`\bSlow\b` は `Slow_Fissure` に一致しない（T31-2・T31-3 が要求する挙動）。`_v\d+` と `insurance\w*` のパターンは変更しない。
- `Normal` は**空に正規化しない**。CSV「テンプレ名」列で、空＝未記入、`Normal`＝明示、を区別できるようにする（本人判断 2026-10-20）。design-doc §5 の「何も書かれていない CAD ジョブは Normal とみなし、値は埋めずに null のまま」と対になる規則で、どちらも記録と仮定を混ぜないためのもの。
- 保存する値はマッチした原文（`normal` と書けば `normal`）。辞書は持たない方針を維持。

**(b) 裂溝フラグ**: `Fissure` は戦略ではなくバーセットの修飾子なので、`templateName` に混ぜず **`job.fissure: true|false`** として独立に持つ。
- 検出は `(?<![A-Za-z0-9])Fissure(?![A-Za-z0-9])` を大文字小文字無視で。前後が英数字でなければ一致＝**`_` を区切りとして扱う**。これにより `Normal_Fissure` / `Slow_Fissure` / `Fissure` / `Slow Fissure` のいずれも、`templateName` と `fissure` に正しく分かれる。
- `_v\d+`（`insurance_v2` など）と `insurance\w*` の既存パターンは触らない。`long_inside` は (a) の境界規則に移す（`C(long_inside)` も `long_inside_Fissure` も従来どおり一致する。T24-3 の大文字表記も含め既存テストは変わらない）。
- `fissure` は材料を問わず**書かれたとおり**記録する。期待バーに効くのは Zr のときだけ（②）。TiA ジョブに Fissure と書いても期待バーは変わらず、フラグだけ残る。

**(c) KIND との干渉確認**: ASCII キー（Cr/In/On/Br/Con）は `\b` 一致なので `Fissure` / `Normal` 内部の文字列には当たらない。テストで固定する（T30-6）。

**書き方の例と結果**

| 注記 | material | template | templateName | fissure | expectedBars |
|---|---|---|---|---|---|
| `d2 Zr Br #23-35 全3` | Zr | — | — | false | 13/14/15 |
| `d2 Zr Br Fissure #23-35 全3` | Zr | — | — | true | 13/14/**33** |
| `d2 Zr Cr Slow Fissure #16 全1` | Zr | — | Slow | true | 13/14/33 |
| `d2 Zr Cr Normal_Fissure #16 全1` | Zr | — | Normal | true | 13/14/33 |
| `d2 Zr Cr Normal #16 全1` | Zr | — | Normal | false | 13/14/15 |
| `w1 TiA Br B Fissure #45-47 全3` | TiA | B | — | true | 61/62/64（変わらない） |
| `w1 TiA Cr C(long_inside) #16 全1` | TiA | C | long_inside | false | 66/67/69（既存どおり） |

---

## ④ 認識する語の一覧表示

**仕様**
- `jobInput` の `textarea` 直下に `<div class="msg" id="jobTokens"></div>` を置く。中身は関数 `renderJobTokens()` が生成し、init で1回呼ぶ（テストからも呼べるようにするため関数にする）。
- 内容は**コードの定数から生成**する。文字列を手書きしない。
  ```
  材料: TiA / TiP / Zr / Stone / WAX / PMMA / PEEK / HR / CAD　　テンプレ: A B C（TiA/TiP のみ）
  種別: Cr In On Br Con 石支台　　戦略: Normal Slow long_inside insurance_vN　　修飾: Fissure
  数量: 全N 支台N ポンN 前N ユN　　歯式: #45-47
  ```
  - 材料 = `MAT_TOKENS` ＋ `CAD`（第2信号）
  - 種別 = `Object.keys(KIND)`
  - 戦略 = 新定数 `TEMPLATE_TOKENS = ["long_inside","Slow","Normal"]` ＋ 固定表示 `insurance_vN`（`_v\d+` パターンの代表例）。`tn` の `long_inside` / `Slow` / `Normal` の判定もこの配列から組み立てる。**配列の順＝優先順位**とし、配列の先頭から順に試して最初に当たった語を採る（1本の選択肢正規表現にまとめると「注記中で左にある語」が勝ってしまい、(a) の優先順位と変わるため）。
  - 修飾 = `Fissure`（定数 `FISSURE_TOKEN`）
  - 数量・歯式は固定文言でよい（正規表現が `全\s*(\d+)` 等で定数化しにくいため）。
- 1〜2行に収まる長さ。placeholder の例も `Zr` を含む行を1つ足す（例: `d2 Zr Br Fissure #23-35 全3`）。

---

## ⑤ 交換履歴の表示制限とマシン絞り込み

**仕様**
- 状態はモジュール変数 `const exView = {machine:"", showAll:false};`。**localStorage に保存しない**（リロードで既定に戻る）。
- `function setExView(patch){ Object.assign(exView, patch); renderExchanges(); }` を追加。UI のコントロールとテストの両方がこれを呼ぶ。
- `renderExchanges` の処理順:
  1. `db.exchanges` を `exView.machine` で絞る（空なら全部）
  2. `detectedAt` 降順に並べる（現行どおり）
  3. `exView.showAll` が false なら先頭 `EX_DEFAULT_LIMIT = 10` 件に切る
  4. 表の**上**にコントロール行、**下**に件数行を出す
- コントロール行: `マシン <select>`（全部/d1/d2/w1/w2、`onchange="setExView({machine:this.value})"`）。
- 件数行（表の下、既存の説明文の前）:
  - 制限中: `最新10件を表示中（d1: 全37件）` ＋ ボタン `すべて表示`（`setExView({showAll:true})`）
  - 全件中: `全37件を表示中` ＋ ボタン `最新10件に戻す`（`setExView({showAll:false})`）
  - マシン絞り込み無しなら `（全N件）`、絞り込み有りなら `（d1: 全N件）`。
- 絞り込み結果が0件なら「該当なし。」（既存の「まだ交換イベントの記録なし。」は `db.exchanges` 自体が空のときだけ）。
- 行の操作（理由 select / メモ / 編集 / 削除）は変更しない。`setExReason` は再描画しない現行仕様のまま。`editExMemo` / `editExchange` / `delExchange` が呼ぶ `renderExchanges()` は `exView` を保ったまま再描画される（表示状態がリセットされないこと）。
- 交換検知時や取込後の `renderExchanges()` 呼び出し箇所は変更不要（既定状態で描画される）。

**設計判断のメモ**: 折りたたみ（details）は開いた瞬間に今と同じ長さになり、ページ送りはマシン・バーで探す用途に合わない。「最新N件＋全件切替＋マシン絞り込み」は、普段は10行、探すときはマシンで絞って Ctrl+F、で足りる。

---

## ⑥ CSV と画面表示

- `jobsCsv`: ヘッダ末尾に **列26「裂溝」** を追加。値は `j.fissure ? 1 : ""`。既存25列の順序・内容は変えない。
- `fmtUnits`: `templateName` の後に、`j.fissure` なら `裂溝` を表示（例: `ブリッジ #23-35 Slow 裂溝 全3/ユ0`）。
- `test_v0_13.js` の `HEAD27` と T27-1 の期待値を26列に更新する（T27-2 以降は `indexOf` 参照なので影響なし）。

---

## 2. テスト（`test_v0_13.js` に追加。番号はテストの通し番号であり、バー番号ではない）

- **T30 Zr と裂溝の期待バー**
  - T30-1 注記 `Zr` → material=Zr、expectedBars=[13,14,15]
  - T30-2 NC名の `_Zr_` トークンからも material=Zr（注記に材料が無い場合）
  - T30-3 `Zr` ＋ `Fissure` → [13,14,33]、`fissure=true`
  - T30-4 `TiA B` ＋ `Fissure` → [61,62,64] のまま、`fissure=true`（材料を問わず記録・バーは Zr のみ変更）
  - T30-5 `expectedBars("Zr", "B")` → [13,14,15]（template は無視）
  - T30-6 `Fissure` / `Normal` が KIND のどのキーにも誤マッチしない（`kind` は注記の Cr/Br のとおり）
  - T30-7 d2 のスナップショット（s13=13, s14=14, s15=15）を置き、Zr ジョブが順序型で 13→14→15 を消費する（`matchSegments` の結合確認。既存ロジックの変更は無いので1本でよい）
- **T31 テンプレ名の分離**
  - T31-1 `Normal` → templateName="Normal"（null にも "" にもならない）
  - T31-2 `Normal_Fissure` → templateName="Normal", fissure=true
  - T31-3 `Slow_Fissure` → "Slow", true ／ `Slow Fissure` も同じ
  - T31-4 `long_inside` / `insurance_v2` / `Slow` の既存挙動が変わらない（T24-4 と重複してよい）
  - T31-5 `MAT_TOKENS` / `TEMPLATE_TOKENS` が配列として export され、`parseNoteLine` がそれ以外の語（例: `Fast`）を templateName にしない
- **T32 認識語の一覧**
  - T32-1 init 後の `jobTokens` の innerHTML に `MAT_TOKENS` の全要素、`Object.keys(KIND)` の全要素、`TEMPLATE_TOKENS` の全要素、`Fissure`、`CAD` が含まれる
  - T32-2 `MAT_TOKENS` に要素を一時的に push して `renderJobTokens()` を呼び直すと一覧にも出る＝手書きでないことの確認。終了時に pop して戻す
- **T33 交換履歴の表示制限**
  - T33-1 交換レコード25件を入れて `renderExchanges()` → `<tr>` の本体行が10件、件数行に `最新10件を表示中（全25件）`
  - T33-2 `setExView({showAll:true})` → 25件、`全25件を表示中`
  - T33-3 `setExView({machine:"w2", showAll:false})` → w2 の件数（≤10）だけ、件数行に `w2:`
  - T33-4 10件制限中に `editExMemo` 相当の再描画（`renderExchanges()` 直接呼び）をしても `exView` が保たれる
  - T33-5 `db.exchanges` が空なら従来の「まだ交換イベントの記録なし。」、絞り込みで0件なら「該当なし。」
- **既存テストの更新**: T27-1 のヘッダ期待値を26列に。
- **テストから参照する名前**: 新しく作る `MAT_TOKENS` / `TEMPLATE_TOKENS` / `FISSURE_TOKEN` / `renderJobTokens` / `setExView` / `exView` / `EX_DEFAULT_LIMIT` は、`test_v0_13.js` の `globalThis.__app = {…}` 一覧に追加しないとテストから見えない。

変異テスト（任意だが推奨）: `expectedBars` の Zr 分岐を外す→T30 が落ちる／`Fissure` の境界規則を `\b` に戻す→T31-2 が落ちる／`EX_DEFAULT_LIMIT` の slice を外す→T33-1 が落ちる、を確認する。

---

## 3. 受け入れ確認（実機）

1. 貼り付け欄の下に認識語の一覧が出る。`Zr` が材料に含まれている。
2. 10/19 の d2 ジルコニア行（13:57 ブリッジ #23-35）を**注記を `d2 Zr Br #23-35 全3/支2/ポ1/ユ0` にして再登録**（旧行は削除）→ 期待バー `13/14/15`、材料不明バッジが消える。セグメントが取込済みなら実消費が 13/14/15 で出る。
3. **NC ファイル名にジルコニアを示す文字列が `Zr` 以外で入っている場合**（hyperDENT の材料名が `ZrO2` や銘柄名のとき）、注記の `Zr` で救われるので動作はするが、ファイル名側の表記を報告すること（`MAT_TOKENS` に別名を足すかの判断材料）。
4. 交換履歴が最新10件で出て、「すべて表示」で全件、マシン select で絞れる。理由 select を変えても表示状態が崩れない。
5. 加工記録 CSV のヘッダ末尾が `…,注記,歯数(算出),裂溝` になる。

---

## 4. 範囲外・未決（design-doc の未決一覧へ転記するもの）

本指示書には**含めない**。別途判断。

| # | 件名 | 状態 | 根拠・メモ |
|---|---|---|---|
| 1 | 2パス目救済の帰属優先規則 | **未決・実害あり** | v0.13.2 で 9/11 w2 10:52 の救済が消え、9/10 19:11 の未突合ブリッジ（全4で43分＝明らかに過少）が翌日のセグメントを横取り。暫定案＝2パス目の探索範囲を同日内に限定（113本pass・w1 の救済は維持を確認済み）。「最も近いNCが勝つ」規則は w1 17:23/17:25 の順送りで破綻するため不採用 |
| 2 | 「返却記録なし」セグメントの統合扱い | 未決 | 校正の再測定（≤2分断片・本物の切削）と停止（数分〜数時間・ほぼ停止時間）が同じ形。現状は無条件統合のため、停止中の時間が次ジョブの荒削りに乗る（9/11 d1 17:31 の 50=11:22 に 1:13 が混入）。閾値案は実データ（9/11 d1 に 1:24:39 と 1:13 の2例）で決める |
| 3 | 交換を伴わない脱落の記録口 | 未決 | 中止ジョブを貼らない運用にすると、脱落→再ネストの回数がどこにも残らず脱落率の分子が過少になる |
| 4 | 校正の正式対応 | v0.14候補 | 種別「校正」・期待バー `[11]`・NCログ無し記録のための手入力UI。暫定は `CAL_Stone_<機械>_<YYYYMMDD>_<HHMM>.iso` ＋ `d1 Stone 校正 ユ0` の疑似NC行（コード変更なしで動作確認済み） |
| 5 | バッチ誤起動の構造的対策 | §2 の話 | 4本を1本に統合し IP で保存先を自動判定。前提＝各機の固定 IP。繋ぎは INI の系統指紋照合で d↔w のみ中断 |
| 6 | スナップショットの保持上限 | 要観察 | 保存領域 3.5/5.0 MB（9/16）。取込ごとに増える構造。次の候補は同一マシン1日1枚への間引き |

---

## 5. バージョン表記・変更履歴コメント

ヘッダ文言を `v0.13.3` に。ソース先頭の変更履歴コメントに本書①〜⑥を1行ずつ追記（番号は既存の続き）。

## 6. 実装者への申し送り

- 作業ルールはリポジトリ直下の `CLAUDE.md` に従う（ブランチで作業・design-doc.md は編集しない・報告の形）。本書と CLAUDE.md が食い違う場合は実装せず報告する。
- 完了報告に含めるもの: ①〜⑥ の反映箇所／テスト本数（113 → 113＋T30〜T33）と全 pass の証拠／本書からの逸脱と理由（下の §7 にも記録）／design-doc への提案（§A・§C・§I・§6 の該当節と文案）。
- 完了時、`test_v0_13.js` に T31 が実在することを確かめてから、CLAUDE.md の「意図的な挙動（直さない）」表に次の1行を足す:
  `| templateName: 注記の Normal を空に正規化しない（空＝未記入、Normal＝明示） | T31 |`

## 7. 実装時の判断

（実装者が記入する。本書と違う判断をした場合のみ、項目・判断・理由・固定したテストを1行ずつ。無ければ「なし」と書く。）

- ⑤ 件数行: 絞り込み後の件数が `EX_DEFAULT_LIMIT` 以下のときは `全N件を表示中`（絞り込み時は `w2: 全6件を表示中`）とし、切替ボタンは出さない。理由: 本書は10件超の場合の文言しか定めておらず、10件以下で「最新10件を表示中」「すべて表示」を出すと押しても変化しないため。固定: T33-3・T33-4
- ⑤ 全件表示中の件数行は、絞り込みがあればマシン名を前置する（`d1: 全37件を表示中`）。理由: 制限中の `（d1: 全N件）` と揃え、何の全件かを示すため。固定: T33-4
- ⑤ 絞り込み0件の「該当なし。」表示でもマシン select は残す。理由: 消すと絞り込みを戻せなくなるため。固定: T33-5
- ④ 認識語は2行（材料・テンプレ・種別 ／ 戦略・修飾・数量・歯式）にまとめた。本書の例は3行だが「1〜2行に収まる長さ」の指定に合わせた。固定: T32-1（内容のみ。改行位置はテストしない）
- テスト: T31-6（CSV列26「裂溝」と fmtUnits の裂溝タグ）を追加。§2 に⑥のテストが無かったため。そのため `fmtUnits` も `__app` に追加した
