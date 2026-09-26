import { useId } from "react";
import "./research.css";

export type ResearchPayload = {
  state: "available" | "stale" | "unavailable";
  detail: string;
  version: string;
  snapshots: Array<{
    symbol: string;
    asOf: string;
    retrievedAt: string;
    start: string;
    count: number;
    feed: string;
    adjustment: "split";
    metrics: {
      sma20: number | null;
      sma50: number | null;
      sma200: number | null;
      rsi14: number | null;
      return20Pct: number | null;
      drawdown63Pct: number | null;
    };
    closes: Array<{ date: string; close: number }>;
  }>;
};

export type ResearchPanelProps = { research: ResearchPayload | null };
type Snapshot = ResearchPayload["snapshots"][number];

const decimal = new Intl.NumberFormat("ja-JP", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const retrievedDate = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const marketDate = (value: string) => value.slice(0, 10) || "—";
const valueText = (value: number | null, percent = false) =>
  value !== null && Number.isFinite(value)
    ? `${decimal.format(value)}${percent ? "%" : ""}`
    : "—";

function Sparkline({ snapshot }: { snapshot: Snapshot }) {
  const titleId = useId();
  const points = [...snapshot.closes]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-63);
  if (points.length < 2 || points.some((point) => !Number.isFinite(point.close)))
    return <p className="research-note">終値の推移：—（データ不足）</p>;

  const min = Math.min(...points.map((point) => point.close));
  const max = Math.max(...points.map((point) => point.close));
  const line = points.map((point, index) => {
    const x = 4 + (index / (points.length - 1)) * 312;
    const y = max === min ? 40 : 76 - ((point.close - min) / (max - min)) * 72;
    return `${x},${y}`;
  }).join(" ");
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <figure className="research-chart">
      <figcaption>終値の推移 · 直近{points.length}取引日</figcaption>
      <svg viewBox="0 0 320 80" role="img" aria-labelledby={titleId}>
        <title id={titleId}>
          {snapshot.symbol}の分割調整済み終値。
          {marketDate(first.date)}：{valueText(first.close)}から
          {marketDate(last.date)}：{valueText(last.close)}。
          期間内の最低値{valueText(min)}、最高値{valueText(max)}。
        </title>
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="research-chart-dates" aria-hidden="true">
        <span>{marketDate(first.date)}</span>
        <span>{marketDate(last.date)}</span>
      </div>
    </figure>
  );
}

function ResearchCard({ snapshot }: { snapshot: Snapshot }) {
  const headingId = useId();
  const retrieved = new Date(snapshot.retrievedAt);
  const metrics: Array<[string, number | null, boolean?]> = [
    ["20日単純移動平均", snapshot.metrics.sma20],
    ["50日単純移動平均", snapshot.metrics.sma50],
    ["200日単純移動平均", snapshot.metrics.sma200],
    ["RSI（14日・0〜100）", snapshot.metrics.rsi14],
    ["20取引日の価格変化率", snapshot.metrics.return20Pct, true],
    ["直近63取引日の最高終値からの下落率", snapshot.metrics.drawdown63Pct, true],
  ];
  return (
    <article className="panel research-card" aria-labelledby={headingId}>
      <div className="card-top">
        <h3 id={headingId}>{snapshot.symbol}</h3>
        <span className="badge">分割調整済み</span>
      </div>
      <p className="research-note">
        価格基準日（市場日付）：<time dateTime={marketDate(snapshot.asOf)}>{marketDate(snapshot.asOf)}</time>
      </p>
      <Sparkline snapshot={snapshot} />
      <dl className="research-metrics">
        {metrics.map(([label, value, percent]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{valueText(value, percent)}</dd>
          </div>
        ))}
      </dl>
      <div className="data-source">
        <span>取得日時：{Number.isNaN(retrieved.getTime()) ? "—" : (
          <time dateTime={snapshot.retrievedAt}>{retrievedDate.format(retrieved)} JST</time>
        )}</span>
        <span>収録：{marketDate(snapshot.start)}〜{marketDate(snapshot.asOf)} · {snapshot.count}本</span>
        <span>フィード：{snapshot.feed || "—"}</span>
      </div>
    </article>
  );
}

export default function ResearchPanel({ research }: ResearchPanelProps) {
  const headingId = useId();
  const available = research?.state === "available";
  const status = research === null ? "未取得"
    : research.state === "stale" ? "更新待ち"
    : research.state === "unavailable" ? "利用不可" : "取得済み";
  return (
    <section className="research-panel" aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId}>価格の参考指標</h2>
        <span className="badge">{status}</span>
      </div>
      <div className="research-status" role="status">
        {!available && <p>{research === null
          ? "参考指標はまだ取得されていません。"
          : research.state === "stale"
            ? "データが古いため、価格の推移と指標の表示を停止しています。"
            : "参考指標を表示できません。"}</p>}
        {research?.detail && <p>{research.detail}</p>}
        {available && research.snapshots.length === 0 && <p>表示できる価格データがありません。</p>}
      </div>
      {available && research.snapshots.length > 0 && (
        <div className="research-grid">
          {research.snapshots.map((snapshot) => <ResearchCard key={snapshot.symbol} snapshot={snapshot} />)}
        </div>
      )}
      <p className="research-note research-explanation">
        株式分割調整済み・配当を含まない価格の指標です。20・50・200日などの日数は取引日（日足の本数）を表します。データ不足は「—」。
        RSIは値動きの強さを示す数値で、上昇確率ではありません。
        下落率は直近63取引日の最高終値から現在の終値までの下落で、期間中の最大ドローダウンではありません。
      </p>
    </section>
  );
}
