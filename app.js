// セカンドブレイン（Web アプリ版）。表示ロジックは claude.ai 版（dashboard/second-brain.html）と同じで、
// データの読み書きを Supabase に置き換え、ログイン・今すぐ同期・締切通知を足したもの。
(() => {
  const C = window.SECOND_BRAIN_CONFIG;
  const sb = supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });

  const AREAS = ["大学", "仕事", "個人"];
  const DOW = "日月火水木金土";
  const CACHE_KEY = "sb.cache";
  const SYNC_STALE_MS = 3 * 60_000; // これ以上「PC待ち」のままならPCが止まっているとみなす
  const state = { sync: null, tasks: [], done: {}, req: null, notes: [], filter: "all", showDone: false, armed: null, ready: false,
    tab: "home", noteEdit: null, noteOpen: false, noteArmed: false, noteQuery: "" };
  try {
    state.filter = localStorage.getItem("sb.filter") || "all"; state.showDone = localStorage.getItem("sb.showDone") === "1";
    state.tab = localStorage.getItem("sb.tab") === "notes" ? "notes" : "home";
  } catch (e) {}

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const hm = (d) => `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // 期限文字列 → {at: Date（比較用）, hasTime}。日付だけなら当日の終わり扱い
  function parseDue(s) {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split("-").map(Number); return { at: new Date(y, m - 1, d, 23, 59, 59), day: new Date(y, m - 1, d), hasTime: false }; }
    const at = new Date(s);
    if (isNaN(at)) return null;
    return { at, day: startOfDay(at), hasTime: true };
  }
  function whenLabel(due, now) {
    const d = due.day, today = startOfDay(now);
    const diff = Math.round((d - today) / 86400000);
    let s = `${d.getMonth() + 1}/${d.getDate()}（${DOW[d.getDay()]}）`;
    if (due.hasTime) s += ` ${pad(due.at.getHours())}:${pad(due.at.getMinutes())}`;
    let rel = "";
    if (due.at < now) rel = diff === 0 ? "時刻を過ぎています" : `${-diff}日超過`;
    else if (diff === 0) rel = "今日";
    else if (diff === 1) rel = "明日";
    else rel = `あと${diff}日`;
    return { text: s, rel, late: due.at < now };
  }

  // 同期分と手入力分を1つの形にそろえる
  function allItems() {
    const synced = (state.sync?.items || []).map((it) => ({ ...it, manual: false, done: !!state.done[it.id] }));
    const manual = state.tasks.map((t) => ({ ...t, kind: "task", source: "手入力", group: t.area, manual: true }));
    return synced.concat(manual).map((it) => ({ ...it, dueP: parseDue(it.due) }));
  }

  function renderSyncReq(now) {
    const r = state.req;
    let text = "", warn = false, busy = false;
    if (r && (r.status === "pending" || r.status === "running")) {
      busy = true;
      const waited = now - new Date(r.status === "running" ? r.started_at : r.requested_at);
      if (r.status === "running") text = "PCで同期中…（数分かかります）";
      else if (waited > SYNC_STALE_MS) { text = "PCが応答しません（スリープ中かもしれません）。起動すると同期されます。"; warn = true; }
      else text = "同期を依頼しました。PCが受け取るのを待っています…";
    } else if (r && r.status === "failed" && now - new Date(r.finished_at) < 3600_000) {
      text = `同期に失敗しました：${r.message || "原因不明"}`; warn = true;
    }
    document.querySelectorAll("[data-sync-btn]").forEach((b) => { b.disabled = busy; });
    document.querySelectorAll("[data-sync-stat]").forEach((st) => { st.textContent = text; st.classList.toggle("warn", warn); });
  }

  // ===== 画面：ホーム・カレンダー・メニュー・追加の4つ。スマホは1つずつ、PC（幅 900px 以上）はホームとカレンダーを並べる =====
  const AREA_KEY = { 大学: "uni", 仕事: "work", 個人: "life" };
  const HOUR_PX = 56, DAY_START = 7; // タイムラインは 7時から
  const hmOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const inFilter = (i) => state.filter === "all" || i.area === state.filter;
  const isReply = (i) => i.kind === "reply"; // 仕事 Slack の @メンション。「返信待ち」にだけ出す
  function dayPill(d, now) {
    const diff = Math.round((d - startOfDay(now)) / 86400000);
    if (diff < 0) return { t: `${-diff}日超過`, c: "late" };
    if (diff === 0) return { t: "今日", c: "today" };
    if (diff === 1) return { t: "明日", c: "" };
    if (diff < 7) return { t: `${DOW[d.getDay()]}曜`, c: "" };
    return { t: `${d.getMonth() + 1}/${d.getDate()}`, c: "" };
  }
  function ringIcon(area) {
    return `<span class="m-ico" data-a="${AREA_KEY[area] || ""}" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" class="tr"/><path d="M12 4a8 8 0 1 1-8 8h8z" class="fg"/></svg></span>`;
  }

  // 分類ごとに、今週（日曜まで）が締切のタスクと直近の期限切れのうち完了した割合を同心円で
  function renderMRings(items, now) {
    const sunday = addDays(startOfDay(now), (7 - now.getDay()) % 7);
    const weekAgo = addDays(startOfDay(now), -7); // 期限切れは直近1週間分だけ数える
    const R = [44, 34, 24];
    const rows = AREAS.map((a, k) => {
      const scope = items.filter((i) => i.area === a && i.kind !== "event" && !isReply(i) && i.dueP && i.dueP.day >= weekAgo && i.dueP.day <= sunday);
      const done = scope.filter((i) => i.done).length;
      return { a, k, total: scope.length, done, pct: scope.length ? Math.round((done / scope.length) * 100) : null };
    });
    const arc = (r, pct) => { const c = 2 * Math.PI * r; return `stroke-dasharray="${(c * (pct ?? 0)) / 100} ${c}"`; };
    $("mRings").innerHTML = `
      <svg class="rings" viewBox="0 0 100 100" role="img" aria-label="${rows.map((x) => `${x.a} ${x.pct ?? "対象なし"}${x.pct == null ? "" : "%"}`).join("、")}">
        ${rows.map((x) => `<circle cx="50" cy="50" r="${R[x.k]}" class="tr"/>${x.pct ? `<circle cx="50" cy="50" r="${R[x.k]}" class="fg" data-a="${AREA_KEY[x.a]}" ${arc(R[x.k], x.pct)} transform="rotate(-90 50 50)"/>` : ""}`).join("")}
      </svg>
      <div class="m-legend">
        <div class="m-cap">今週の完了率</div>
        ${rows.map((x) => `<div class="lg"><span class="dot" data-a="${AREA_KEY[x.a]}"></span><span class="nm">${x.a}</span><span class="v">${x.pct == null ? "—" : x.pct + "%"}</span><span class="n">${x.done}/${x.total}</span></div>`).join("")}
      </div>`;
  }

  // 予定のカード（予定と時刻つきの締切、7日以内）
  function renderMProj(items, now) {
    const end = addDays(startOfDay(now), 7);
    const list = items.filter((i) => i.dueP && !i.done && !isReply(i) && inFilter(i) && (i.kind === "event" || i.dueP.hasTime) && i.dueP.day < end
      && (parseDue(i.end)?.at ?? i.dueP.at) >= now).sort((a, b) => a.dueP.at - b.dueP.at).slice(0, 10);
    $("mProj").innerHTML = list.map((i) => {
      const p = dayPill(i.dueP.day, now);
      const t = i.allDay || !i.dueP.hasTime ? "終日" : hmOf(i.dueP.at);
      return `<article class="m-pc">${ringIcon(i.area)}<div class="cap">${esc(i.area)}・${i.kind === "event" ? "予定" : "締切"}</div>
        <div class="tt">${esc(i.title)}</div><div class="ft"><span class="m-pill ${p.c}">${p.t}</span><span class="tm">${t}</span></div></article>`;
    }).join("") || `<p class="m-empty">7日以内の予定はありません</p>`;
  }

  // やること（期限切れ→期限の近い順→期限なし）
  function renderMTasks(items, now) {
    const ts = items.filter((i) => i.kind !== "event" && !isReply(i) && inFilter(i) && (state.showDone || !i.done))
      .sort((a, b) => (a.done - b.done) || ((a.dueP?.at ?? Infinity) - (b.dueP?.at ?? Infinity)));
    $("mTasks").innerHTML = ts.map((i) => {
      const w = i.dueP ? whenLabel(i.dueP, now) : null;
      const del = i.manual ? `<button class="m-del${state.armed === i.id ? " arm" : ""}" type="button" data-del="${esc(i.id)}" aria-label="削除：${esc(i.title)}">${state.armed === i.id ? "削除" : "×"}</button>` : "";
      return `<li class="m-task${i.done ? " done" : ""}"><label class="m-chk"><input type="checkbox" data-done="${esc(i.id)}" data-manual="${i.manual ? 1 : 0}" ${i.done ? "checked" : ""} aria-label="完了にする：${esc(i.title)}"><span></span></label>
        <div class="bd"><div class="tt">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}</div>
        <div class="sub"><span class="dot" data-a="${AREA_KEY[i.area] || ""}"></span>${esc(i.group || i.area)}${w ? `・<span class="${w.late && !i.done ? "late" : ""}">${esc(w.text)} ${esc(w.rel)}</span>` : ""}</div>${i.note ? `<div class="nt">${esc(i.note)}</div>` : ""}</div>${del}</li>`;
    }).join("") || `<li class="m-empty">${state.ready ? "やることはありません" : "読み込み中…"}</li>`;
    $("mShowDone").textContent = state.showDone ? "完了を隠す" : "完了も表示";
  }

  // 返信待ち：@されてから24時間の残りを数える（1分ごとの再描画で進む）
  function renderMReplies(items, now) {
    const rs = items.filter((i) => isReply(i) && !i.done && i.dueP && inFilter(i)).sort((a, b) => a.dueP.at - b.dueP.at);
    $("mReplyBox").hidden = !rs.length;
    $("mReplies").innerHTML = rs.map((i) => {
      const left = i.dueP.at - now, h = Math.floor(Math.abs(left) / 3600000), m = Math.floor((Math.abs(left) % 3600000) / 60000);
      const lvl = left < 0 ? "late" : left < 3 * 3600000 ? "soon" : left < 12 * 3600000 ? "mid" : "";
      const t = left < 0 ? `${h ? `${h}時間` : `${m}分`}超過` : `残り ${h}:${pad(m)}`;
      const pct = Math.max(0, Math.min(100, (left / 86400000) * 100));
      const at = i.mentioned_at ? new Date(i.mentioned_at) : null;
      return `<li class="m-task m-reply ${lvl}"><label class="m-chk"><input type="checkbox" data-done="${esc(i.id)}" data-manual="0" aria-label="返信済みにする：${esc(i.title)}"><span></span></label>
        <div class="bd"><div class="tt">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}</div>
        <div class="sub">#${esc(i.group)}${at ? `・${hm(at)}` : ""}</div>${i.note ? `<div class="nt">${esc(i.note)}</div>` : ""}
        <div class="m-bar2" aria-hidden="true"><span style="width:${pct}%"></span></div></div>
        <div class="m-left" title="返信の期限 ${esc(hm(i.dueP.at))}">${t}</div></li>`;
    }).join("");
  }

  // カレンダー：日付の帯＋タイムライン
  function renderMCal(items, now) {
    const today = startOfDay(now);
    const sel = addDays(today, state.calDay || 0);
    $("mDays").innerHTML = [...Array(14)].map((_, k) => {
      const d = addDays(today, k);
      return `<button type="button" class="m-dchip${k === (state.calDay || 0) ? " on" : ""}" data-day="${k}" aria-pressed="${k === (state.calDay || 0)}"><b>${d.getDate()}</b><small>${k === 0 ? "今日" : DOW[d.getDay()]}</small></button>`;
    }).join("");
    const day = items.filter((i) => i.dueP && !i.done && !isReply(i) && inFilter(i) && +i.dueP.day === +sel);
    const allDay = day.filter((i) => i.allDay || !i.dueP.hasTime);
    const timed = day.filter((i) => !(i.allDay || !i.dueP.hasTime)).sort((a, b) => a.dueP.at - b.dueP.at);
    // 重なる予定は横に並べる（空いている列に詰める）
    const cols = [];
    const placed = timed.map((i) => {
      const s = i.dueP.at, e = (i.kind === "event" && parseDue(i.end)?.at) || new Date(+s + 30 * 60000);
      let c = cols.findIndex((last) => last <= s); if (c < 0) { c = cols.length; cols.push(e); } else cols[c] = e;
      return { i, s, e, c };
    });
    const startH = Math.min(DAY_START, ...timed.map((i) => i.dueP.at.getHours()));
    const y = (d) => ((d.getHours() + d.getMinutes() / 60) - startH) * HOUR_PX;
    const hours = [...Array(24 - startH)].map((_, k) => `<div class="m-hr" style="top:${k * HOUR_PX}px"><span>${startH + k}:00</span></div>`).join("");
    const n = Math.max(1, cols.length);
    const evs = placed.map(({ i, s, e, c }) => {
      const h = Math.max(46, y(e) - y(s));
      const time = i.kind === "event" ? `${hmOf(s)} – ${hmOf(e)}` : `締切 ${hmOf(s)}`;
      return `<div class="m-ev" data-a="${AREA_KEY[i.area] || ""}" style="top:${y(s)}px;height:${h}px;left:calc(56px + (100% - 56px) * ${c / n});width:calc((100% - 56px) / ${n} - 4px)">
        <div class="cap">${esc(i.area)}・${i.kind === "event" ? "予定" : time}</div><div class="tt">${esc(i.title)}</div>${i.kind === "event" ? `<div class="tm">${time}</div>` : ""}</div>`;
    }).join("");
    const nowLine = +sel === +today && now.getHours() >= startH ? `<div class="m-now" style="top:${y(now)}px"></div>` : "";
    $("mAllDay").innerHTML = allDay.map((i) => `<div class="m-ad" data-a="${AREA_KEY[i.area] || ""}"><span class="cap">終日・${i.kind === "event" ? "予定" : "締切"}</span>${esc(i.title)}</div>`).join("");
    $("mTimeline").style.height = `${(24 - startH) * HOUR_PX}px`;
    $("mTimeline").innerHTML = hours + evs + nowLine;
    $("mCalTitle").textContent = `${sel.getMonth() + 1}月${sel.getDate()}日（${DOW[sel.getDay()]}）`;
  }

  // メニュー：分類の一覧（タップで絞り込み）
  function renderMMenu(items) {
    const open = items.filter((i) => i.kind !== "event" && !isReply(i) && !i.done);
    $("mCats").innerHTML = ["all", ...AREAS].map((a) => `<button type="button" class="m-cat${state.filter === a ? " on" : ""}" data-filter="${a}" data-a="${AREA_KEY[a] || "all"}">
      <span class="bar"></span><span class="nm">${a === "all" ? "すべて" : a}</span><span class="n">${open.filter((i) => a === "all" || i.area === a).length}件</span></button>`).join("");
  }

  // ノートの掲示板：ピン留め→そのほか、どちらも新しく直した順。検索はタイトルと本文
  function noteCard(n) {
    return `<button type="button" class="m-nc" data-n="${esc(n.color)}" data-note="${esc(n.id)}">${n.title ? `<span class="tt">${esc(n.title)}</span>` : ""}${n.body ? `<span class="bd">${esc(n.body)}</span>` : ""}<span class="ft">${esc(hm(new Date(n.updated_at)))}</span></button>`;
  }
  function renderNotes() {
    const q = state.noteQuery.trim().toLowerCase();
    const ns = state.notes.filter((n) => !q || `${n.title}\n${n.body}`.toLowerCase().includes(q)).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const pinned = ns.filter((n) => n.pinned), others = ns.filter((n) => !n.pinned);
    $("mPinnedBox").hidden = !pinned.length;
    $("mOthersHead").hidden = !pinned.length || !others.length;
    $("mPinned").innerHTML = pinned.map(noteCard).join("");
    const empty = state.notesErr ? "ノートを読み込めませんでした" : q ? "見つかりませんでした" : state.ready ? "ノートはまだありません。＋から書けます" : "読み込み中…";
    $("mBoard").innerHTML = others.map(noteCard).join("") || (pinned.length ? "" : `<p class="m-empty">${empty}</p>`);
  }

  function renderMobile(items, now) {
    const s = state.sync;
    $("mSync").textContent = s ? `最終同期 ${hm(new Date(s.synced_at))}${(s.errors || []).length ? `・取得失敗 ${s.errors.length}件` : ""}` : state.ready ? "まだ同期されていません" : "読み込み中…";
    $("mSync").title = (s?.errors || []).join("\n"); // PC ではマウスを乗せると失敗した情報源が見える
    $("mFilterTag").innerHTML = state.filter === "all" ? "" : `<button type="button" class="m-tag" data-filter="all">${esc(state.filter)} ×</button>`;
    renderMRings(items, now);
    renderMReplies(items, now);
    renderMProj(items, now);
    renderMTasks(items, now);
    renderMCal(items, now);
    renderMMenu(items);
    renderNotes();
  }

  // 画面の切り替え（Android の戻る操作で元の画面に戻れるよう履歴に積む）。
  // タブはホームとノートの2つ。PC ではホームとカレンダーを常に出し、メニュー・追加・ノート編集はその上のダイアログにする
  const wideMQ = matchMedia("(min-width: 900px)");
  const OVERLAYS = ["mMenu", "mAdd", "mNote"];
  const baseView = () => (state.tab === "notes" ? "mNotes" : "mHome");
  function mShow(view, push = true) {
    if (view !== "mNote" && state.noteOpen) saveNote(); // ノート編集を閉じるときは書いた分を保存する
    const wide = wideMQ.matches, notes = state.tab === "notes", base = view === baseView();
    for (const v of OVERLAYS) $(v).hidden = v !== view;
    $("mHome").hidden = notes || (!wide && view !== "mHome");
    $("mCal").hidden = notes || (!wide && view !== "mCal");
    $("mNotes").hidden = !notes || (!wide && view !== "mNotes");
    $("mTop").hidden = $("mTabs").hidden = !wide && !base;
    $("mScrim").hidden = !wide || !OVERLAYS.includes(view);
    $("mFab").hidden = !base;
    $("mFab").setAttribute("aria-label", notes ? "ノートを書く" : "タスクを追加");
    $("mCalBtn").hidden = notes;
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === state.tab));
    if (push && !base) history.pushState({ m: view }, "");
    if (!wide) window.scrollTo(0, 0);
    if (view === "mAdd") setTimeout(() => $("mAddTitle").focus(), 50);
    if (view === "mNote" && !state.noteEdit) setTimeout(() => $("mNoteBody").focus(), 50);
  }
  window.addEventListener("popstate", () => mShow(baseView(), false));
  const mBack = () => (history.state?.m ? history.back() : mShow(baseView(), false));
  wideMQ.addEventListener("change", () => mShow(baseView(), false));

  function render() {
    const now = new Date();
    const items = allItems();
    renderSyncReq(now);
    renderMobile(items, now);
  }

  // 時計と日付：文字は切り抜いた紙片。変わった文字だけ古い紙を丸めて落とし、新しい紙を広げる（日付は0時に変わる）
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const WEEK = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]; // 紙片に漢字はないので曜日は英語
  const pieceSrc = (ch) => (/\d/.test(ch) ? `digits/${ch}.webp` : `letters/${ch}.webp`);
  for (const ch of new Set("0123456789" + WEEK.join(""))) new Image().src = pieceSrc(ch); // 切り替えの瞬間に読み込み待ちが出ないように
  function renderPieces(box, text) {
    while (box.children.length < text.length) box.append(Object.assign(document.createElement("span"), { className: "ck-d" }));
    while (box.children.length > text.length) box.lastChild.remove();
    [...box.children].forEach((slot, k) => {
      if (slot.dataset.v === text[k]) return;
      slot.dataset.v = text[k];
      const img = new Image(); img.src = pieceSrc(text[k]); img.alt = "";
      const old = slot.querySelector("img:not(.out)");
      if (old && !reduceMotion.matches) {
        old.classList.add("out"); img.className = "in";
        setTimeout(() => old.remove(), 1200);
      } else if (old) old.remove();
      slot.append(img);
    });
  }
  function renderClock() {
    const now = new Date();
    renderPieces($("ckH"), pad(now.getHours()));
    renderPieces($("ckM"), pad(now.getMinutes()));
    renderPieces($("dtM"), String(now.getMonth() + 1));
    renderPieces($("dtD"), String(now.getDate()));
    renderPieces($("dtW"), WEEK[now.getDay()]);
    $("mClock").setAttribute("aria-label", `${now.getHours()}時${now.getMinutes()}分`);
    $("mDate").setAttribute("aria-label", `${now.getMonth() + 1}月${now.getDate()}日（${DOW[now.getDay()]}）`);
  }
  function tickClock() { renderClock(); setTimeout(tickClock, 60000 - (Date.now() % 60000) + 50); }
  renderClock();
  setTimeout(tickClock, 60000 - (Date.now() % 60000) + 50);

  // データ読み込み
  async function loadSync() { const r = await sb.from("sync_state").select("*").eq("id", 1).maybeSingle(); if (r.error) throw r.error; state.sync = r.data; }
  async function loadTasks() { const r = await sb.from("tasks").select("*").order("created_at"); if (r.error) throw r.error; state.tasks = r.data; }
  async function loadDone() { const r = await sb.from("done").select("id"); if (r.error) throw r.error; state.done = Object.fromEntries(r.data.map((d) => [d.id, true])); }
  async function loadReq() { const r = await sb.from("sync_requests").select("*").order("id", { ascending: false }).limit(1); if (r.error) throw r.error; state.req = r.data[0] || null; }
  // ノートが読めなくても（テーブル未作成など）ホームは出せるよう、失敗はノートの欄にだけ出す
  async function loadNotes() { const r = await sb.from("notes").select("*"); state.notesErr = !!r.error; if (r.error) { console.error(r.error); return; } state.notes = r.data; }
  const LOADERS = { sync_state: loadSync, tasks: loadTasks, done: loadDone, sync_requests: loadReq, notes: loadNotes };

  async function reload(which = Object.keys(LOADERS)) {
    try {
      await Promise.all(which.map((t) => LOADERS[t]()));
      state.ready = true;
      $("nodb").hidden = true;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ sync: state.sync, tasks: state.tasks, done: state.done, notes: state.notes })); } catch (e) {}
    } catch (err) {
      console.error(err);
      if (!state.ready) $("nodb").hidden = false;
    }
    render();
  }

  let channel = null;
  function subscribe() {
    if (channel) return;
    channel = sb.channel("second-brain");
    for (const t of Object.keys(LOADERS)) channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => reload([t]));
    channel.subscribe();
  }

  // 操作
  const onDoneChange = async (e) => {
    const c = e.target.closest("[data-done]"); if (!c) return;
    const id = c.dataset.done, on = c.checked;
    let r;
    if (c.dataset.manual === "1") r = await sb.from("tasks").update({ done: on, done_at: on ? new Date().toISOString() : null }).eq("id", id);
    else if (on) r = await sb.from("done").upsert({ id });
    else r = await sb.from("done").delete().eq("id", id);
    if (r.error) { c.checked = !on; showMsg("保存できませんでした。通信状態を確認してもう一度試してください。"); return; }
    reload([c.dataset.manual === "1" ? "tasks" : "done"]);
  };
  $("mTasks").addEventListener("change", onDoneChange);
  $("mReplies").addEventListener("change", onDoneChange);
  const onDelClick = async (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    const id = b.dataset.del;
    if (state.armed !== id) { state.armed = id; render(); setTimeout(() => { if (state.armed === id) { state.armed = null; render(); } }, 4000); return; }
    state.armed = null;
    const r = await sb.from("tasks").delete().eq("id", id);
    if (r.error) showMsg("削除できませんでした。");
    reload(["tasks"]);
  };
  $("mTasks").addEventListener("click", onDelClick);
  let toastTimer = 0;
  function showMsg(t) {
    const toast = $("mToast"); toast.textContent = t; toast.hidden = !t;
    clearTimeout(toastTimer); if (t) toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }
  document.querySelectorAll("[data-sync-btn]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    const r = await sb.from("sync_requests").insert({});
    if (r.error) { showMsg("同期を依頼できませんでした。"); btn.disabled = false; return; }
    reload(["sync_requests"]);
  }));

  // 画面の操作
  $("mMenuBtn").addEventListener("click", () => mShow("mMenu"));
  $("mCalBtn").addEventListener("click", () => mShow("mCal"));
  $("mFab").addEventListener("click", () => (state.tab === "notes" ? openNote(null) : mShow("mAdd")));
  document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", mBack));
  $("mScrim").addEventListener("click", mBack);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && OVERLAYS.some((v) => !$(v).hidden)) mBack(); });
  $("mTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]"); if (!b || b.dataset.tab === state.tab) return;
    state.tab = b.dataset.tab; try { localStorage.setItem("sb.tab", state.tab); } catch (err) {}
    mShow(baseView(), false);
  });
  $("mShowDone").addEventListener("click", () => { state.showDone = !state.showDone; try { localStorage.setItem("sb.showDone", state.showDone ? "1" : "0"); } catch (err) {} render(); });
  const setFilter = (e) => {
    const b = e.target.closest("[data-filter]"); if (!b) return;
    state.filter = b.dataset.filter; try { localStorage.setItem("sb.filter", state.filter); } catch (err) {}
    render();
    if (!$("mMenu").hidden) mBack();
  };
  $("mCats").addEventListener("click", setFilter);
  $("mFilterTag").addEventListener("click", setFilter);
  $("mDays").addEventListener("click", (e) => { const b = e.target.closest("[data-day]"); if (!b) return; state.calDay = +b.dataset.day; render(); });
  // 追加画面：期限は「今日・明日・日付を選ぶ・なし」のチップ
  $("mDue").addEventListener("change", () => { $("mDateRow").hidden = $("mDue").querySelector("input:checked").value !== "pick"; });
  $("mAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("mAddTitle").value.trim();
    if (!title) { showMsg("内容を入力してください。"); return; }
    const pick = $("mDue").querySelector("input:checked").value, time = $("mAddTime").value;
    const base = pick === "today" ? new Date() : pick === "tomorrow" ? addDays(new Date(), 1) : pick === "pick" && $("mAddDate").value ? new Date(`${$("mAddDate").value}T00:00`) : null;
    const date = base && `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
    const due = date ? (time ? new Date(`${date}T${time}`).toISOString() : date) : null;
    const area = $("mAddForm").querySelector('input[name="marea"]:checked').value;
    $("mAddSave").disabled = true;
    const r = await sb.from("tasks").insert({ title, due, area });
    $("mAddSave").disabled = false;
    if (r.error) { showMsg("追加できませんでした。もう一度試してください。"); return; }
    $("mAddTitle").value = ""; $("mAddTime").value = "";
    reload(["tasks"]);
    mBack();
  });

  // ノート：カードを押すと編集。閉じる（戻る・保存・外側を押す）と変更があれば保存する
  function noteRow() {
    return { title: $("mNoteTitle").value.trim(), body: $("mNoteBody").value.trimEnd(),
      color: $("mNoteForm").querySelector('input[name="ncolor"]:checked').value, pinned: $("mNotePin").checked };
  }
  function openNote(id) {
    const n = id ? state.notes.find((x) => x.id === id) : null;
    Object.assign(state, { noteEdit: n ? n.id : null, noteOpen: true, noteArmed: false });
    $("mNoteHead").textContent = n ? "ノート" : "新しいノート";
    $("mNoteTitle").value = n?.title || ""; $("mNoteBody").value = n?.body || "";
    $("mNoteForm").querySelector(`input[name="ncolor"][value="${n?.color || "none"}"]`).checked = true;
    $("mNoteEd").dataset.n = n?.color || "none";
    $("mNotePin").checked = !!n?.pinned;
    $("mNoteDel").hidden = !n; $("mNoteDel").classList.remove("arm"); $("mNoteDel").textContent = "削除";
    mShow("mNote");
  }
  async function saveNote() {
    state.noteOpen = false;
    const row = noteRow(), n = state.noteEdit && state.notes.find((x) => x.id === state.noteEdit);
    if (n && ["title", "body", "color", "pinned"].every((k) => n[k] === row[k])) return;
    if (!row.title && !row.body.trim()) { if (n) showMsg("空のノートは保存できません。消すときは「削除」を押してください。"); return; }
    const r = n ? await sb.from("notes").update(row).eq("id", n.id) : await sb.from("notes").insert(row);
    // 失敗したら書いた内容が残っている編集画面に戻す
    if (r.error) { showMsg("ノートを保存できませんでした。通信状態を確認してもう一度試してください。"); state.noteOpen = true; mShow("mNote"); return; }
    reload(["notes"]);
  }
  const onNoteClick = (e) => { const b = e.target.closest("[data-note]"); if (b) openNote(b.dataset.note); };
  $("mPinned").addEventListener("click", onNoteClick);
  $("mBoard").addEventListener("click", onNoteClick);
  $("mNoteSearch").addEventListener("input", (e) => { state.noteQuery = e.target.value; renderNotes(); });
  $("mNoteColors").addEventListener("change", (e) => { $("mNoteEd").dataset.n = e.target.value; });
  $("mNoteForm").addEventListener("submit", (e) => { e.preventDefault(); mBack(); });
  $("mNoteBody").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); mBack(); } });
  $("mNoteDel").addEventListener("click", async () => {
    const b = $("mNoteDel"), id = state.noteEdit;
    if (!state.noteArmed) {
      state.noteArmed = true; b.classList.add("arm"); b.textContent = "もう一度押すと削除";
      setTimeout(() => { if (state.noteArmed && state.noteEdit === id) { state.noteArmed = false; b.classList.remove("arm"); b.textContent = "削除"; } }, 4000);
      return;
    }
    const r = await sb.from("notes").delete().eq("id", id);
    if (r.error) { showMsg("削除できませんでした。"); return; }
    state.noteOpen = false; // 消したので閉じるときに保存しない
    reload(["notes"]);
    mBack();
  });

  // 締切通知（Web Push）
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function b64ToBytes(s) {
    const b = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }
  async function savePushSub(sub) {
    const j = sub.toJSON();
    const r = await sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) });
    if (r.error) throw r.error;
  }
  async function setupPush() {
    const btns = [...document.querySelectorAll("[data-push-btn]")], hints = [...document.querySelectorAll("[data-push-hint]")];
    const hint = { set textContent(t) { hints.forEach((h) => { h.textContent = t; }); }, set hidden(v) { hints.forEach((h) => { h.hidden = v; }); } };
    const btn = { set hidden(v) { btns.forEach((b) => { b.hidden = v; }); }, set disabled(v) { btns.forEach((b) => { b.disabled = v; }); }, set onclick(f) { btns.forEach((b) => { b.onclick = f; }); } };
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      if (isIOS && !standalone) { hint.textContent = "締切の通知を受け取るには、共有ボタンから「ホーム画面に追加」して、そこから開いてください。"; hint.hidden = false; }
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === "granted") {
      savePushSub(sub).catch(console.error); // 鍵が変わっていても登録し直す
      btn.hidden = true;
      return;
    }
    if (Notification.permission === "denied") { hint.textContent = "通知がブロックされています。ブラウザのサイト設定で通知を許可すると、締切の24時間前と3時間前に通知します。"; hint.hidden = false; return; }
    btn.hidden = false;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        if ((await Notification.requestPermission()) !== "granted") throw new Error("許可されませんでした");
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(C.vapidPublicKey) });
        await savePushSub(s);
        btn.hidden = true;
        hint.textContent = "通知をオンにしました。締切の24時間前と3時間前に届きます。"; hint.hidden = false;
        setTimeout(() => { hint.hidden = true; }, 6000);
      } catch (err) {
        hint.textContent = `通知をオンにできませんでした（${err.message || err}）`; hint.hidden = false;
      }
      btn.disabled = false;
    };
  }

  // ログイン（パスワード。無料プランの標準メールは文面を変えられずコードを送れないため）
  function loginErr(t) { $("loginErr").textContent = t || ""; }
  $("email").value = C.ownerEmail || "";
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginBtn").disabled = true; loginErr("");
    const r = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("loginBtn").disabled = false;
    if (r.error) loginErr(r.error.status === 429 ? "試行回数の上限です。しばらく待ってから試してください。" : "メールアドレスかパスワードが違います。");
    else $("password").value = "";
  });
  document.querySelectorAll("[data-logout]").forEach((b) => b.addEventListener("click", async () => {
    await sb.auth.signOut();
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    mShow(baseView(), false);
  }));

  function showApp() {
    $("login").hidden = true; $("app").hidden = false;
    // 前回の内容をすぐ出してから最新を取りにいく
    try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if (c && !state.ready) Object.assign(state, c, { ready: true }); } catch (e) {}
    mShow(baseView(), false);
    render();
    reload();
    subscribe();
    setupPush().catch(console.error);
  }
  function showLogin() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    Object.assign(state, { sync: null, tasks: [], done: {}, req: null, notes: [], noteOpen: false, ready: false });
    $("app").hidden = true; $("login").hidden = false;
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED") return;
    // コールバック内で Supabase を await するとデッドロックするので次のタスクに回す
    setTimeout(() => (session ? ($("app").hidden ? showApp() : null) : showLogin()), 0);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("app").hidden) { renderClock(); reload(); } });
  setInterval(render, 60000); // 「あと○日」「今日」の表示を時刻に合わせて更新
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.error);
})();
