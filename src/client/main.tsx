import type {NewsReview} from '../domain/news-review';
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import NewsPanel from "./NewsPanel";
import PriceRulesPanel from "./PriceRulesPanel";
import PortfolioPanel from "./PortfolioPanel";
import ResearchPanel, { type ResearchPayload } from "./ResearchPanel";

type Status = {
  phase: "validation";
  research?: ResearchPayload;
  scheduledChecksEnabled?: boolean;
  configured: { alpaca: boolean; push: boolean };
  latestRun: { status: string; createdAt: string; detail: string } | null;
  bars: {
    symbol: string;
    close: number;
    volume: number;
    timestamp: string;
    feed: string;
  }[];
  push: { subscribed: boolean; publicKey: string | null };
  notificationTime: string;
  dataState?: "available" | "stale" | "unavailable";
  latestNotification?: { status: string; detail: string | null; dueAt: number } | null;
};
type Result = { ok: boolean; detail: string; jobId?: string };
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch(`/api/${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const data: unknown = await response.json().catch(() => null);
    const detail =
      data &&
      typeof data === "object" &&
      "detail" in data &&
      typeof data.detail === "string"
        ? data.detail
        : data &&
            typeof data === "object" &&
            "error" in data &&
            typeof data.error === "string"
          ? data.error
          : null;
    if (response.status === 503 && (path === "session" || path === "status"))
      throw new ApiError(
        "初期設定がまだ完了していません。管理者がご自身で作成した所有者キーをセットアップ手順に沿って設定してから、もう一度接続してください。",
        503,
      );
    if (!response.ok)
      throw new ApiError(
        response.status === 401
          ? "セッションの有効期限が切れました。所有者キーで接続してください。"
          : detail ||
              "処理を完了できませんでした。設定や接続を確認して、もう一度お試しください。",
        response.status,
      );
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error(
      "サーバーに接続できません。通信環境を確認して、もう一度お試しください。",
    );
  } finally {
    window.clearTimeout(timeout);
  }
}
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "日時を確認できません"
    : new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(parsed) + " JST";
};
const number = new Intl.NumberFormat("ja-JP");
function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
function App() {
  const [newsRefresh,setNewsRefresh]=useState(0);
  const [newsReview,setNewsReview]=useState<NewsReview[]|null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [auth, setAuth] = useState<
    "loading" | "required" | "ready" | "unavailable"
  >("loading");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(() => ("Notification" in window ? Notification.permission : "unsupported"));
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [swError, setSwError] = useState("");
  const [localSubscribed, setLocalSubscribed] = useState(false);
  const locked = useRef(false);
  const supported =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const fail = (reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) {
      setStatus(null);
      setAuth("required");
    }
    setError(
      reason instanceof Error
        ? reason.message
        : "処理を完了できませんでした。もう一度お試しください。",
    );
  };
  const refresh = async () => {
    try {
      const next = await api<Status>("status");
      if (
        !next ||
        next.phase !== "validation" ||
        !Array.isArray(next.bars) ||
        !next.configured ||
        !next.push
      )
        throw new Error(
          "接続状態の応答を読み取れませんでした。サーバーの設定を確認してください。",
        );
      setStatus(next);
      setAuth("ready");
    } catch (reason) {
      if (!(reason instanceof ApiError && reason.status === 401))
        setAuth((current) => (current === "ready" ? current : "unavailable"));
      throw reason;
    }
  };
  useEffect(() => {
    void refresh().catch((reason) => {
      if (reason instanceof ApiError && reason.status === 401)
        setAuth("required");
      else fail(reason);
    });
    const sync = () => {
      setOnline(navigator.onLine);
      if ("Notification" in window) setPermission(Notification.permission);
    };
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    window.addEventListener("focus", sync);
    let mounted = true;
    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker
        .register("/sw.js")
        .then(() => navigator.serviceWorker.ready)
        .then(async (reg) => {
          if (mounted) setRegistration(reg);
          if ("PushManager" in window) {
            const subscription = await reg.pushManager.getSubscription();
            if (mounted) setLocalSubscribed(Boolean(subscription));
          }
        })
        .catch(() => {
          if (mounted)
            setSwError(
              "通知の準備に失敗しました。ページを再読み込みしてください。",
            );
        });
    }
    return () => {
      mounted = false;
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      window.removeEventListener("focus", sync);
    };
  }, []);
  async function action(name: string, work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (reason) {
      fail(reason);
    } finally {
      locked.current = false;
      setBusy(null);
    }
  }
  async function enablePush() {
    if (!registration || !status?.push.publicKey) return;
    // The permission request occurs directly in the user's button gesture.
    const granted = await Notification.requestPermission();
    setPermission(granted);
    if (granted !== "granted") {
      setNotice(
        granted === "denied"
          ? "通知がブロックされています。ブラウザのサイト設定から許可してください。"
          : "通知の許可はまだ選択されていません。必要なときにもう一度お試しください。",
      );
      return;
    }
    let subscription = await registration.pushManager.getSubscription();
    const created = !subscription;
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidBytes(status.push.publicKey),
    });
    try {
      const serialized = subscription.toJSON();
      if (!serialized.keys?.p256dh || !serialized.keys?.auth)
        throw new Error("通知の購読情報を取得できませんでした。");
      await api("push/subscribe", "POST", {
        endpoint: subscription.endpoint,
        keys: serialized.keys,
      });
    } catch (reason) {
      if (created) await subscription.unsubscribe().catch(() => false);
      throw reason;
    }
    setLocalSubscribed(true);
    setNotice(
      "このブラウザの通知を有効にしました。テスト通知で到着を確かめてください。",
    );
    await refresh();
  }
  async function syncCurrentDevice() {
    const subscription = await registration?.pushManager.getSubscription();
    const serialized = subscription?.toJSON();
    if (!subscription || !serialized?.keys?.p256dh || !serialized.keys.auth) {
      setLocalSubscribed(false);
      throw new Error(
        "この端末の購読が見つかりません。通知をもう一度有効にしてください。",
      );
    }
    // The server has one global subscription: retarget it to this device before sending.
    await api("push/subscribe", "POST", {
      endpoint: subscription.endpoint,
      keys: serialized.keys,
    });
  }
  const disabled = Boolean(busy) || !online;
  const pushReady = status?.configured.push && status.push.publicKey;
  const activePush = Boolean(
    status?.push.subscribed && localSubscribed && permission === "granted",
  );
  const pushHint = !supported
    ? "このブラウザではプッシュ通知を利用できません。HTTPS 接続の Android Chrome などで開いてください。"
    : permission === "denied"
      ? "通知がブロックされています。ブラウザのサイト設定で通知を許可してから、画面に戻ってください。"
      : swError ||
        (!pushReady
          ? "通知用の VAPID 設定がまだありません。管理者がサーバーに設定すると有効にできます。"
          : !registration
            ? "通知機能を準備しています…"
            : activePush
              ? "通知先は全体で1端末です。テスト・予約時は、この端末を通知先に設定します。"
              : "ボタンを押すと、ブラウザが通知の許可を確認します。");
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="ETF Monitor ホーム">
          <img src="/icon.svg" alt="" width="34" height="34" />
          <span>
            ETF <b>Monitor</b>
          </span>
        </a>
        <span className="environment">
          <i />
          技術検証
        </span>
      </header>
      <main id="main">
        <section className="intro">
          <p className="eyebrow">MARKET RESEARCH / 02</p>
          <h1>
            値動きを確かめる<span>。</span>
          </h1>
          <p>
            価格の履歴と、判断の土台を。
            <br className="mobile-break" />
            まずは、数値を確かめるところから。
          </p>
          <div className="scope">
            <span aria-hidden="true">◇</span>{" "}
            現在は技術検証フェーズです。売買シグナルは提供していません。
          </div>
        </section>
        <div className="messages" aria-live="polite" aria-atomic="true">
          {!online && (
            <p className="message error">
              オフラインです。表示内容を更新できません。接続を戻してから再試行してください。
            </p>
          )}
          {error && (
            <p className="message error" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="message success">{notice}</p>}
        </div>
        {auth === "loading" ? (
          <section className="panel placeholder" aria-busy="true">
            接続状態を確認しています…
          </section>
        ) : auth === "required" ? (
          <section className="panel login">
            <div className="section-label">SECURE ACCESS</div>
            <h2>所有者キーで接続</h2>
            <p>
              初期設定で作成された所有者キーを入力してください。
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const submitted = token.trim();
                setToken("");
                if (submitted)
                  void action("login", async () => {
                    await api("session", "POST", { token: submitted });
                    await refresh();
                  });
              }}
            >
              <label htmlFor="token">所有者キー</label>
              <input
                id="token"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
                disabled={disabled}
              />
              <button className="primary" disabled={disabled || !token.trim()}>
                {busy === "login" ? "接続しています…" : "安全に接続する"}
                <span aria-hidden="true"> →</span>
              </button>
            </form>
            <p className="fine">
              所有者キーは送信後に入力欄から消去し、ブラウザのストレージには保存しません。
            </p>
          </section>
        ) : auth === "unavailable" ? (
          <section className="panel">
            <h2>接続の準備を確認しましょう</h2>
            <p>
              初回は、ご自身で作成した所有者キーをサーバーに設定してください。設定後は下のボタンから接続できます。
            </p>
            <p className="fine">
              設定済みの場合は、サーバーの起動と通信環境を確認してください。
            </p>
            <button
              className="primary"
              disabled={disabled}
              onClick={() => void action("refresh", refresh)}
            >
              もう一度確認する
            </button>
          </section>
        ) : (
          status && (
            <>
              <div className="section-heading">
                <h2>マーケットデータ</h2>
                <span>Alpaca / 実測値のみ</span>
              </div>
              {status.dataState === "stale" && <p className="message error">保存された価格が古いため表示を停止しています。データを再取得してください。</p>}
              <div className="market-grid">
                {["SOXL", "TQQQ"].map((symbol) => {
                  const bar = status.bars
                    .filter((item) => item.symbol === symbol)
                    .sort(
                      (a, b) =>
                        new Date(b.timestamp).getTime() -
                        new Date(a.timestamp).getTime(),
                    )[0];
                  return (
                    <article className="panel market" key={symbol}>
                      <div className="card-top">
                        <h3>{symbol}</h3>
                        <span className={`badge ${bar ? "good" : ""}`}>
                          {bar ? "取得済み" : "未取得"}
                        </span>
                      </div>
                      <p className="metric-label">
                        終値 <span>USD</span>
                      </p>
                      <div className="price">
                        {bar && Number.isFinite(bar.close)
                          ? bar.close.toLocaleString("en-US", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })
                          : "—"}
                      </div>
                      <div className="market-meta">
                        <span>出来高</span>
                        <b>
                          {bar && Number.isFinite(bar.volume)
                            ? number.format(bar.volume)
                            : "—"}
                        </b>
                      </div>
                      <div className="data-source">
                        {bar ? (
                          <>
                            <span>日足の基準時刻：{date(bar.timestamp)}</span>
                            <span>
                              フィード：{bar.feed || "不明"} ·
                              リアルタイム表示ではありません
                            </span>
                          </>
                        ) : (
                          <span>
                            データ取得の確認後に、実際の値を表示します。
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              <PriceRulesPanel onRefreshNews={()=>setNewsRefresh(n=>n+1)} newsReview={newsReview} api={api} onAuthError={fail} dataKey={JSON.stringify([status.dataState,status.latestRun?.createdAt,status.research?.snapshots.map(s=>s.retrievedAt)])} />
              <NewsPanel refreshKey={newsRefresh} api={api} onAuthError={fail} onReview={setNewsReview} />
              <PortfolioPanel api={api} onAuthError={fail} />
              <ResearchPanel research={status.research ?? null} />
              <p className="fine">価格の定期更新：{status.scheduledChecksEnabled ? "有効（毎日9:15・15:15・21:15 JSTごろ）" : "停止中（手動で更新できます）"}</p>
              <div className="checks-grid">
                <section className="panel check">
                  <div className="step">
                    01 <span>DATA CONNECTION</span>
                  </div>
                  <h2>データの接続</h2>
                  <p>Alpaca から価格データを取得できるか確認します。</p>
                  <div className="config-row">
                    <span>Alpaca API 設定</span>
                    <span
                      className={`badge ${status.configured.alpaca ? "good" : ""}`}
                    >
                      {status.configured.alpaca ? "設定済み" : "未設定"}
                    </span>
                  </div>
                  {!status.configured.alpaca && (
                    <p className="hint">
                      API キーがまだ設定されていません。管理者がサーバーに
                      Alpaca のキーを設定すると確認できます。
                    </p>
                  )}
                  <button
                    className="primary"
                    disabled={disabled || !status.configured.alpaca}
                    onClick={() =>
                      void action("check", async () => {
                        await api<Result>("calendar", "POST");
                        const result = await (async () => {
                          const started = await api<Result>("check", "POST", {stage:"start"});
                          if (!started.jobId) throw new Error("更新処理を開始できませんでした。");
                          await api<Result>("check", "POST", {stage:"continue",jobId:started.jobId});
                          return await api<Result>("check", "POST", {stage:"publish",jobId:started.jobId});
                        })().catch(async (reason) => {
                          await refresh().catch(() => undefined);
                          throw reason;
                        });
                        if (result.ok)
                          setNotice(
                            result.detail || "データの取得を確認しました。",
                          );
                        else
                          setError(
                            result.detail || "データの取得に失敗しました。",
                          );
                        await refresh();
                      })
                    }
                  >
                    {busy === "check"
                      ? "データを確認しています…"
                      : "データ取得を確認"}
                    <span aria-hidden="true"> ↗</span>
                  </button>
                </section>
                <section className="panel check">
                  <div className="step">
                    02 <span>PUSH NOTIFICATION</span>
                  </div>
                  <h2>通知の接続</h2>
                  <p>この端末に、目に見えるテスト通知を届けます。</p>
                  <div className="config-row">
                    <span>通知の準備</span>
                    <span className={`badge ${pushReady ? "good" : ""}`}>
                      {pushReady ? "設定済み" : "未設定"}
                    </span>
                  </div>
                  <div className="config-row">
                    <span>通知の購読（全体で1端末）</span>
                    <span
                      className={`badge ${status.push.subscribed ? "good" : ""}`}
                    >
                      {status.push.subscribed ? "登録あり" : "未登録"}
                    </span>
                  </div>
                  <div className="config-row">
                    <span>このブラウザの通知許可</span>
                    <span
                      className={`badge ${permission === "granted" ? "good" : ""}`}
                    >
                      {!supported
                        ? "非対応"
                        : permission === "denied"
                          ? "ブロック中"
                          : permission === "granted"
                            ? "許可済み"
                            : "未許可"}
                    </span>
                  </div>
                  <p className="hint" id="push-hint">
                    {pushHint}
                  </p>
                  <button
                    className="primary"
                    aria-describedby="push-hint"
                    disabled={
                      disabled ||
                      !supported ||
                      permission === "denied" ||
                      !pushReady ||
                      !registration ||
                      Boolean(swError)
                    }
                    onClick={() =>
                      void action(
                        activePush ? "test" : "enable",
                        activePush
                          ? async () => {
                              await syncCurrentDevice();
                              const result = await api<Result>(
                                "push/test",
                                "POST",
                              );
                              if (!result.ok)
                                throw new Error(
                                  result.detail ||
                                    "テスト通知を送信できませんでした。",
                                );
                              setNotice(
                                `${result.detail || "テスト通知を送信しました。"} 端末に通知が届いたか確認してください。`,
                              );
                            }
                          : enablePush,
                      )
                    }
                  >
                    {busy === "enable"
                      ? "通知を設定しています…"
                      : busy === "test"
                        ? "通知を送っています…"
                        : activePush
                          ? "テスト通知を送る"
                          : "通知を有効にする"}
                    <span aria-hidden="true"> ↗</span>
                  </button>
                  {activePush && (
                    <button
                      className="text-button"
                      disabled={disabled}
                      onClick={() => void action("enable", enablePush)}
                    >
                      この端末で受け取る設定に更新
                    </button>
                  )}
                  <div className="schedule-box">
                    <h3>閉じたあとにも届くか確認</h3>
                    <p>
                      予約後、約5〜10分後に通知します。アプリとPCを閉じて、Android
                      端末で到着を確かめてください。
                    </p>
                    <p className="fine">
                      サーバーが5分ごとに確認し、自動通知は1日1回まで。無料枠で稼働するサーバーの常時実行が前提です。PC上だけでサーバーを動かしている場合は、PCを閉じると送信できません。
                    </p>
                    <button
                      className="secondary"
                      disabled={disabled || !activePush || !pushReady}
                      onClick={() =>
                        void action("schedule", async () => {
                          await syncCurrentDevice();
                          const result = await api<Result>(
                            "push/schedule",
                            "POST",
                            {},
                          );
                          if (!result.ok)
                            throw new Error(
                              result.detail || "通知を予約できませんでした。",
                            );
                          await refresh();
                          setNotice(
                            `${result.detail || "通知を予約しました。"} アプリとPCを閉じて、約5〜10分後に端末で通知を確認してください。自動通知は1日1回までです。`,
                          );
                        })
                      }
                    >
                      {busy === "schedule"
                        ? "通知を予約しています…"
                        : "通知を予約して閉じる"}
                    </button>
                    <p className="fine">
                      予約後はご自身でアプリを閉じてください。月額0円での検証を前提としています。
                    </p>
                  </div>
                  {(localSubscribed || status.push.subscribed) && (
                    <button
                      className="text-button"
                      disabled={disabled}
                      onClick={() =>
                        void action("disable", async () => {
                          await api("push/subscribe", "DELETE");
                          const subscription =
                            await registration?.pushManager.getSubscription();
                          if (
                            subscription &&
                            !(await subscription.unsubscribe())
                          )
                            throw new Error(
                              "サーバーの購読は解除しました。端末側の解除に失敗したため、もう一度お試しください。",
                            );
                          setLocalSubscribed(false);
                          setNotice("全体の通知購読を解除しました。");
                          await refresh();
                        })
                      }
                    >
                      {busy === "disable"
                        ? "解除しています…"
                        : "通知の購読を解除（全体）"}
                    </button>
                  )}
                  <p className="fine schedule">
                    通知時刻の設定 <b>{status.notificationTime}</b>
                    <br />
                    自動配信や売買判断の稼働を示すものではありません。
                  </p>
                </section>
              </div>
              <section className="panel history">
                <div className="card-top">
                  <h2>直近の検証</h2>
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() => void action("refresh", refresh)}
                  >
                    {busy === "refresh" ? "更新中…" : "状態を更新"}
                    <span aria-hidden="true"> ↻</span>
                  </button>
                </div>
                {status.latestRun ? (
                  <>
                    <div className="run-meta">
                      <span className="badge">
                        {(
                          {
                            success: "成功",
                            ok: "成功",
                            error: "エラー",
                            failed: "失敗",
                            running: "実行中",
                            pending: "待機中",
                          } as Record<string, string>
                        )[status.latestRun.status] || status.latestRun.status}
                      </span>
                      <time dateTime={status.latestRun.createdAt}>
                        {date(status.latestRun.createdAt)}
                      </time>
                    </div>
                    <p className="run-detail">{status.latestRun.detail}</p>
                  </>
                ) : (
                  <p className="empty">
                    まだ検証を実行していません。
                    <br />
                    <span>
                      上のボタンから、接続をひとつずつ確認しましょう。
                    </span>
                  </p>
                )}
              </section>
              {status.latestNotification && (
                <section className="panel history">
                  <h2>予約通知の状態</h2>
                  <p>{({ pending: "予約済み", claimed: "送信処理中（結果未確認）", accepted: "通知サービスが受付済み", failed: "送信失敗", skipped: "送信を見送り" } as Record<string, string>)[status.latestNotification.status] || "確認中"}</p>
                  <p className="fine">予約時刻：{date(new Date(status.latestNotification.dueAt).toISOString())}</p>
                  {status.latestNotification.detail && <p>{status.latestNotification.detail}</p>}
                  <p className="fine">通知サービスの受付と、端末への到着は別です。</p>
                </section>
              )}
              <div className="session">
                <span>
                  <i />
                  セッションで接続中
                </span>
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() =>
                    void action("logout", async () => {
                      await api("logout", "POST");
                      setStatus(null);
                      setAuth("required");
                      setToken("");
                      setNotice("ログアウトしました。");
                    })
                  }
                >
                  {busy === "logout" ? "ログアウト中…" : "ログアウト"}
                </button>
              </div>
            </>
          )
        )}
      </main>
      <footer>
        <span>ETF MONITOR</span>
        <p>
          日足から、市場を読み解く。
          <br />
          技術検証専用 · 売買シグナルなし
        </p>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
