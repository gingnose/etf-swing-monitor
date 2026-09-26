import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { PortfolioOpening, PortfolioEntryInput, PortfolioView, PortfolioChange } from "../domain/portfolio";
import "./portfolio.css";

type Props = {
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  onAuthError: (reason: unknown) => void;
};
type View = PortfolioView & { revision: number };
type Entry = PortfolioView["entries"][number];
type Change = PortfolioChange;
type Envelope = { requestId: string; revision: number; change: Change };
const symbols = ["SOXL", "TQQQ"] as const;
const kinds = { deposit: "入金", withdraw: "出金", fx: "両替", buy: "買付", sell: "売却", split: "株式分割" };
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const isZero = (s: string) => /^0+(\.0+)?$/.test(s);
const statusOf = (error: unknown) => error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
function Field({ label, value, set, date = false, optional = false, integer = false }: {
  label: string; value: string; set: (v: string) => void; date?: boolean; optional?: boolean; integer?: boolean;
}) {
  return <label className="portfolio-field">{label}<input type={date ? "date" : "text"} inputMode={date ? undefined : "decimal"}
    required={!optional} value={value} onChange={e => set(e.target.value)} autoComplete="off"
    pattern={date ? undefined : integer ? "[0-9]+" : "[0-9]+([.][0-9]+)?"} /></label>;
}
function Select({ label, value, set, children }: { label: string; value: string; set: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return <div className="portfolio-field"><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={e => set(e.target.value)}>{children}</select></div>;
}
function OpeningForm({ opening, plan, save }: { opening: PortfolioOpening | null; plan: string; save: (opening: PortfolioOpening, plan: string) => void }) {
  const [date, setDate] = useState(opening?.date ?? today());
  const [jpy, setJpy] = useState(opening?.cashJpy ?? "0");
  const [usd, setUsd] = useState(opening?.cashUsd ?? "0");
  const [monthly, setMonthly] = useState(plan);
  const [holdings, setHoldings] = useState(() => symbols.map(symbol => ({ symbol,
    quantity: opening?.holdings.find(h => h.symbol === symbol)?.quantity ?? "0",
    costUsd: opening?.holdings.find(h => h.symbol === symbol)?.costUsd ?? "0" })));
  function submit(e: FormEvent) {
    e.preventDefault();
    save({ date, cashJpy: jpy, cashUsd: usd, holdings: holdings.map(h => ({ ...h, quantity: h.quantity || "0", costUsd: h.costUsd || "0" })).filter(h => !(isZero(h.quantity) && isZero(h.costUsd))) }, monthly || "0");
  }
  return <form onSubmit={submit} autoComplete="off">
    <h3>{opening ? "開始時点の訂正" : "開始時点を登録"}</h3>
    <p className="portfolio-help">開始日の取引前の残高を入力してください。既存保有分の取得総額は、この現金残高から差し引きません。</p>
    {opening && <p className="portfolio-help">訂正後は、開始時点以降の取引を使って残高と損益を再計算します。</p>}
    <div className="portfolio-fields">
      <Field label="開始日（JST）" date value={date} set={setDate} />
      <Field label="円現金（JPY）" value={jpy} set={setJpy} />
      <Field label="米ドル現金（USD）" value={usd} set={setUsd} />
      {!opening && <Field label="毎月の入金予定（JPY・任意）" value={monthly} set={setMonthly} optional />}
    </div>
    <details><summary>既存の保有株（任意）</summary>
      <p className="portfolio-help">保有がない銘柄は数量と取得総額の両方を0または空欄にしてください。</p>
      {holdings.map((h, i) => <div className="portfolio-holding" key={h.symbol}><h4>{h.symbol}</h4><div className="portfolio-fields">
        <Field label={`${h.symbol} 数量`} value={h.quantity} optional set={v => setHoldings(old => old.map((x, n) => n === i ? { ...x, quantity: v } : x))} />
        <Field label="取得総額（手数料込み・USD）" value={h.costUsd} optional set={v => setHoldings(old => old.map((x, n) => n === i ? { ...x, costUsd: v } : x))} />
      </div></div>)}
    </details>
    <button className="primary" type="submit">{opening ? "開始時点の訂正を保存" : "開始時点を保存"}</button>
  </form>;
}
function EntryForm({ entry, save, cancel }: { entry?: Entry; save: (e: PortfolioEntryInput) => void; cancel: () => void }) {
  const [kind, setKind] = useState<PortfolioEntryInput["kind"]>(entry?.kind ?? "deposit");
  const [date, setDate] = useState(entry?.date ?? today());
  const [note, setNote] = useState(entry?.note ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => ({ currency: "JPY", amount: "", from: "JPY", to: "USD", paid: "", received: "", symbol: "SOXL", quantity: "", grossUsd: "", feeUsd: "0", numerator: "", denominator: "", ...Object.fromEntries(Object.entries(entry ?? {}).filter(([, v]) => typeof v === "string")) }));
  const set = (key: string) => (value: string) => setValues(old => ({ ...old, [key]: value }));
  const field = (key: string, label: string, integer = false) => <Field key={key} label={label} value={values[key]} set={set(key)} integer={integer} />;
  function submit(e: FormEvent) {
    e.preventDefault();
    const common = { kind, date, ...(note.trim() ? { note: note.trim() } : {}) };
    const keys = kind === "deposit" || kind === "withdraw" ? ["currency", "amount"] : kind === "fx" ? ["from", "to", "paid", "received"] : kind === "split" ? ["symbol", "numerator", "denominator"] : ["symbol", "quantity", "grossUsd", "feeUsd"];
    save({ ...common, ...Object.fromEntries(keys.map(key => [key, values[key]])) } as PortfolioEntryInput);
  }
  return <form onSubmit={submit} autoComplete="off"><h3>{entry ? "取引の訂正" : "取引を記録"}</h3>
    <p className="portfolio-help">半角数字で入力：JPYは整数、USDは小数2桁、数量は小数6桁まで。</p>
    <div className="portfolio-fields">
      <Select label="取引の種類" value={kind} set={v => setKind(v as typeof kind)}>{Object.entries(kinds).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</Select>
      <Field label="取引日（JST）" date value={date} set={setDate} />
      {(kind === "deposit" || kind === "withdraw") && <><Select label="通貨" value={values.currency} set={set("currency")}><option>JPY</option><option>USD</option></Select>{field("amount", `金額（${values.currency}）`)}</>}
      {kind === "fx" && <><Select label="両替の方向" value={values.from} set={v => setValues(old => ({ ...old, from: v, to: v === "JPY" ? "USD" : "JPY" }))}><option value="JPY">JPY → USD</option><option value="USD">USD → JPY</option></Select>{field("paid", `実際の支払額（手数料込み・${values.from}）`)}{field("received", `実際の受取額（手数料差引後・${values.to}）`)}</>}
      {(kind === "buy" || kind === "sell" || kind === "split") && <Select label="銘柄" value={values.symbol} set={set("symbol")}>{symbols.map(s => <option key={s}>{s}</option>)}</Select>}
      {(kind === "buy" || kind === "sell") && <>{field("quantity", "数量（株）")}{field("grossUsd", "約定総額（手数料を除く・USD）")}{field("feeUsd", "手数料（USD）")}</>}
      {kind === "split" && <>{field("numerator", "分割後の株数（分子）", true)}{field("denominator", "分割前の株数（分母）", true)}</>}
    </div>
    {kind === "split" && <p className="portfolio-help">例：1株が2株になる分割は、分子2・分母1。併合も記録できます。</p>}
    <label className="portfolio-field">メモ（任意）<input value={note} onChange={e => setNote(e.target.value)} maxLength={1000} autoComplete="off" /></label>
    <div className="portfolio-actions"><button className="primary" type="submit">{entry ? "訂正を保存" : "取引を保存"}</button>{entry && <button type="button" onClick={cancel}>訂正をやめる</button>}</div>
  </form>;
}
function PlanForm({ plan, save }: { plan: string; save: (value: string) => void }) {
  const [value, setValue] = useState(plan);
  return <form onSubmit={e => { e.preventDefault(); save(value || "0"); }}><h3>毎月の入金予定</h3><p className="portfolio-help">予定額は現金残高に自動加算されません。実際の入金は取引として記録してください。</p><Field label="毎月の入金予定（JPY）" value={value} set={setValue} optional /><button type="submit" className="primary">予定額を保存</button></form>;
}
function entryText(e: Entry) {
  switch (e.kind) {
    case "deposit": case "withdraw": return `${e.amount} ${e.currency}`;
    case "fx": return `${e.paid} ${e.from} → ${e.received} ${e.to}`;
    case "buy": case "sell": return `${e.symbol} · ${e.quantity}株 · 約定 ${e.grossUsd} USD · 手数料 ${e.feeUsd} USD`;
    case "split": return `${e.symbol} · ${e.denominator}株 → ${e.numerator}株`;
  }
}

export function PortfolioPanel({ api, onAuthError }: Props) {
  const headingId = useId();
  const services = useRef({ api, onAuthError });
  services.current = { api, onAuthError };
  const alive = useRef(false);
  const locked = useRef(false);
  const pending = useRef<{ envelope: Envelope; done: () => void } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(false);
  const [stale, setStale] = useState(false);
  const [authLost, setAuthLost] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"add" | "history" | "settings">("add");
  const [editing, setEditing] = useState<Entry | undefined>();
  const [confirmVoid, setConfirmVoid] = useState<string | null>(null);
  const [limit, setLimit] = useState(20);
  const [formVersion, setFormVersion] = useState(0);
  function auth(error: unknown) {
    if (statusOf(error) !== 401) return false;
    pending.current = null;
    setView(null); setEditing(undefined); setRetry(false); setAuthLost(true);
    services.current.onAuthError(error);
    return true;
  }
  async function get() {
    const next = await services.current.api<View>("portfolio");
    if (alive.current) { setView(next); setStale(false); }
    return next;
  }
  async function refresh(resetForms = false) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      await get();
      if (alive.current && resetForms) {
        setEditing(undefined); setConfirmVoid(null); setFormVersion(n => n + 1);
        setMessage("最新の記録を読み込み、入力欄を更新しました。未保存の入力はリセットしました。");
      }
    }
    catch (e) { if (alive.current && !auth(e)) { setStale(true); setError("残高を取得できませんでした。通信環境を確認して再読み込みしてください。"); } }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, []);
  async function write(change?: Change, done: () => void = () => {}) {
    if (locked.current || (!pending.current && (!view || stale))) return;
    locked.current = true; setBusy(true); setError(""); setMessage("");
    try {
      if (!pending.current) {
        if (!change || !view) return;
        pending.current = { envelope: { requestId: crypto.randomUUID(), revision: view.revision, change }, done };
      }
      const request = pending.current;
      try {
        await services.current.api<{ ok: true; revision: number }>("portfolio", "POST", request.envelope);
      } catch (e) {
        if (!alive.current || auth(e)) return;
        const status = statusOf(e);
        if (!status || status >= 500 || status === 408) {
          setRetry(true);
          setError("保存結果を確認できません。同じリクエストを再試行してください。確認できるまで新しい保存はできません。この画面を閉じたり、ブラウザを再読み込みしたりせず、ここで再試行してください。すでに閉じたり再読み込みした場合は、履歴を確認してから再記録してください。");
        } else {
          pending.current = null; setRetry(false);
          if (status === 409) {
            setStale(true);
            setError(`${e instanceof Error && e.message ? e.message : "現在の台帳に保存できませんでした。"} 最新状態は「再読み込み」で確認してください。再読み込み時に未保存の入力はリセットします。更新上限の場合はJSONを書き出して移行してください。`);
          }
          else setError(status === 400 && e instanceof Error && e.message
            ? e.message
            : "保存できませんでした。日付・金額・数量・残高と取引の順序を確認してください。");
        }
        return;
      }
      pending.current = null;
      if (!alive.current) return;
      setRetry(false); setStale(true);
      request.done();
      setMessage("保存しました。");
      try { await get(); }
      catch (e) { if (alive.current && !auth(e)) setError("保存は完了しましたが、最新の残高を取得できません。再読み込みしてください。"); }
    } catch (e) {
      if (alive.current && !auth(e)) setError("処理を開始できませんでした。接続環境を確認してください。");
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function download() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const data = await get();
      if (!alive.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `portfolio-private-${today()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("JSON書き出しを開始しました。");
    } catch (e) { if (alive.current && !auth(e)) setError("JSON書き出し用のデータを取得できませんでした。再試行してください。"); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  if (authLost) return null;
  const atCapacity = !!view && view.revision >= 10_000;
  const disabled = busy || retry || stale || atCapacity;
  const entries = view ? [...view.entries].sort((a, b) => b.date.localeCompare(a.date) || view.entries.indexOf(b) - view.entries.indexOf(a)).slice(0, Math.min(limit, 500)) : [];
  return <section className="portfolio-panel panel" aria-labelledby={headingId} aria-busy={busy}>
    <div className="section-heading"><h2 id={headingId}>資産台帳</h2><button type="button" disabled={busy || retry} onClick={() => void refresh(true)}>再読み込み</button></div>
    <p className="portfolio-help">手入力の現金・保有数量・取得原価を記録します。実現損益は開始時点以降のUSD建て集計です。税務申告用の計算ではありません。</p>
    <div role="status" aria-live="polite">{busy ? "処理中…" : message}</div>
    {error && <p className="message error" role="alert">{error}</p>}
    {retry && <button className="secondary" disabled={busy} onClick={() => void write()}>同じリクエストで保存を再試行</button>}
    {stale && <p className="portfolio-help">最新データの確認が必要です。「再読み込み」を押してください。</p>}
    {view && !view.initialized && <fieldset disabled={disabled}><OpeningForm key={formVersion} opening={null} plan="0" save={(opening, monthlyPlanJpy) => void write({ type: "initialize", opening, monthlyPlanJpy })} /></fieldset>}
    {atCapacity && <p className="message error" role="alert">台帳の更新上限（10,000回）に達しました。追加・訂正・取消・復元はできません。設定からJSONを書き出して管理者に移行を依頼してください。</p>}
    {view?.initialized && <>
      <p className="portfolio-help">記録 {view.entries.length} / 500件（取消済みも件数に含みます）。上限500件に達すると新規取引は追加できません。残高・損益は日付順、同じ日付では登録順に計算します。訂正しても同日内の登録順は変わりません。</p>
      <div className="portfolio-balances">{(["JPY", "USD"] as const).map(c => <div key={c}><span>現金 · {c}</span><strong>{view.cash[c]}</strong></div>)}<div><span>毎月の入金予定 · JPY</span><strong>{view.monthlyPlanJpy}</strong></div></div>
      <div className="portfolio-positions">{view.positions.map(p => <article key={p.symbol}><h3>{p.symbol}</h3><dl><div><dt>数量</dt><dd>{p.quantity} 株</dd></div><div><dt>取得総額</dt><dd>{p.costUsd} USD</dd></div><div><dt>平均取得単価</dt><dd>{p.averageCostUsd === null ? "—" : `${p.averageCostUsd} USD`}</dd></div><div><dt>実現損益（開始以降）</dt><dd>{p.realizedPnlUsd} USD</dd></div></dl></article>)}</div>
      <nav className="portfolio-tabs" aria-label="資産台帳の操作">{([["add", "取引入力"], ["history", "履歴"], ["settings", "設定・JSON書き出し"]] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={tab === key} disabled={busy || retry} onClick={() => setTab(key)}>{label}</button>)}</nav>
      <fieldset disabled={disabled} hidden={tab !== "add"}><EntryForm key={`${editing?.id ?? "new"}-${formVersion}`} entry={editing} cancel={() => setEditing(undefined)} save={entry => void write(editing ? { type: "edit", id: editing.id, entry } : { type: "add", entry }, () => { setEditing(undefined); setFormVersion(n => n + 1); })} /></fieldset>
      <div hidden={tab !== "history"}><h3>取引履歴</h3><p className="portfolio-help">日付の新しい順（同日は登録の新しい順）・取消済みを含む {entries.length} / {view.entries.length}件</p>
        {!entries.length && <p>取引はまだありません。</p>}
        <ol className="portfolio-history">{entries.map(e => <li key={e.id} className={e.voided ? "portfolio-voided" : ""}><div><time dateTime={e.date}>{e.date}</time> · <b>{kinds[e.kind]}</b> {e.voided && <span className="badge">取消済み</span>}</div><p>{entryText(e)}</p>{e.note && <p className="portfolio-help">{e.note}</p>}<div className="portfolio-actions">
          {!e.voided && <button disabled={disabled} onClick={() => { setEditing(e); setTab("add"); }}>訂正</button>}
          <button disabled={disabled} onClick={() => e.voided ? void write({ type: "restore", id: e.id }) : setConfirmVoid(e.id)}>{e.voided ? "復元" : "取消"}</button>
        </div>{confirmVoid === e.id && !e.voided && <div className="portfolio-confirm"><p>この取引を計算から除外し、残高と損益を再計算します。</p><div className="portfolio-actions"><button disabled={disabled} onClick={() => void write({ type: "void", id: e.id }, () => setConfirmVoid(null))}>この取引の取消を確定</button><button disabled={disabled} onClick={() => setConfirmVoid(null)}>やめる</button></div></div>}</li>)}</ol>
        {entries.length < Math.min(view.entries.length, 500) && <button disabled={busy} onClick={() => setLimit(n => Math.min(n + 20, 500))}>さらに20件表示</button>}
        {view.entries.length > 500 && limit >= 500 && <p className="portfolio-help">表示は直近500件までです。全件はJSON書き出しで確認できます。</p>}
      </div>
      <div hidden={tab !== "settings"}><fieldset key={`settings-${view.revision}-${formVersion}`} disabled={disabled}><PlanForm plan={view.monthlyPlanJpy} save={monthlyPlanJpy => void write({ type: "plan", monthlyPlanJpy })} /><details><summary>開始時点を訂正</summary><OpeningForm opening={view.opening} plan={view.monthlyPlanJpy} save={opening => void write({ type: "opening", opening })} /></details></fieldset>
        <h3>JSON書き出し（非公開の資産データ）</h3><p className="portfolio-help">開始時点と取消済みを含む全取引をJSONで保存します。資産情報を含むため、ダウンロード先を適切に管理してください。復元用アップロードは未対応です。</p><button disabled={busy || retry} onClick={() => void download()}>JSONを書き出す</button>
      </div>
    </>}
  </section>;
}
export default PortfolioPanel;
