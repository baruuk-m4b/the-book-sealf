import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

const APP_VERSION = 5;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- Firebase ---------- */
const configured = !Object.values(firebaseConfig).some(v => String(v).includes("PASTE_HERE"));
let auth, db, uid = null, unsub = null;

const CATS = { reading: "Currently reading", kobo: "In Kobo", library: "Library", queue: "Queue", interested: "Interested" };

const loadSorts = () => { try { return JSON.parse(localStorage.getItem("shelf.sorts") || "{}"); } catch { return {}; } };
const saveSorts = () => { try { localStorage.setItem("shelf.sorts", JSON.stringify(S.sorts)); } catch { /* storage unavailable */ } };
const sortFor = t => S.sorts[t] || (t === "queue" ? "custom" : "recent");

const S = { books: [], tab: "reading", type: "all", sorts: loadSorts(), reorder: false, dragging: false, q: "", searchKind: "book", results: null, searching: false, onlineQ: "", page: 0, more: false, loadingMore: false, pool: new Map(), pq: null };

// Books carry a list of categories. Older saves had one category (or status + kobo flag): convert them.
const STATUS_CATS = ["reading", "queue", "interested"];
const defaultCats = () => [S.tab];
const migrate = b => {
  if (Array.isArray(b.cats)) return b;
  const { category, status, kobo, ...rest } = b;
  const c = category || (status === "reading" ? "reading" : status === "want" ? "queue" : status === "interested" ? "interested" : "");
  const cats = new Set(c ? [c] : []);
  if (kobo) cats.add("kobo");
  if (!cats.size) cats.add("library");
  return { ...rest, cats: [...cats] };
};

if (!configured) {
  $("#auth").hidden = false;
  $(".auth-card").innerHTML = `<h1>Shelf</h1><p>Almost there: open <b>firebase-config.js</b> and paste in your Firebase settings (README, step 2).</p>`;
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

  onAuthStateChanged(auth, user => {
    if (unsub) { unsub(); unsub = null; }
    if (!user) { uid = null; S.books = []; $("#app").hidden = true; $("#auth").hidden = false; return; }
    uid = user.uid;
    $("#auth").hidden = true; $("#app").hidden = false;
    unsub = onSnapshot(collection(db, "users", uid, "books"), { includeMetadataChanges: true }, snap => {
      S.books = snap.docs.map(d => migrate(d.data()));
      const el = $("#sync");
      el.className = "sync " + (snap.metadata.fromCache && !navigator.onLine ? "off" : "ok");
      el.title = el.classList.contains("ok") ? "Synced" : "Offline: changes will sync when you reconnect";
      if (!S.dragging) render();
    }, err => toast("Sync error: " + err.code));
    render();
  });

  const authErr = e => { $("#authErr").textContent = (e.code || e.message || "").replace("auth/", "").replace(/-/g, " "); };
  $("#googleBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(authErr);
  $("#signInBtn").onclick = () => signInWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value).catch(authErr);
  $("#signUpBtn").onclick = () => createUserWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value).catch(authErr);
}

const saveBook = b => setDoc(doc(db, "users", uid, "books", b.id), b);
const removeBook = id => deleteDoc(doc(db, "users", uid, "books", id));

/* ---------- Helpers ---------- */
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400);
}
function stripHtml(h) {
  if (!h) return "";
  const withBreaks = String(h).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  return (new DOMParser().parseFromString(withBreaks, "text/html").body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Best-effort series detection from titles like "Berserk, Vol. 3" or "Dune (Dune, #1)".
function parseSeries(title = "", subtitle = "") {
  let m;
  if ((m = title.match(/\(([^()]+?)[,\s]+(?:#|book\s*|vol(?:ume)?\.?\s*)(\d+(?:\.\d+)?)\)\s*$/i))) return { series: m[1].trim(), number: m[2] };
  if ((m = subtitle.match(/(?:book|volume|vol\.?)\s*(\d+(?:\.\d+)?)\s+(?:of|in)\s+(?:the\s+)?(.+)/i))) return { series: m[2].replace(/\s*series$/i, "").trim(), number: m[1] };
  if ((m = title.match(/^(.+?)[,:]?\s+(?:vol(?:ume)?\.?|book|#)\s*(\d+(?:\.\d+)?)\b/i))) return { series: m[1].trim(), number: m[2] };
  if ((m = subtitle.match(/^(.+?)[,:]?\s+(?:#|book\s*|vol(?:ume)?\.?\s*)(\d+(?:\.\d+)?)$/i))) return { series: m[1].trim(), number: m[2] };
  return { series: "", number: "" };
}

function findExisting(d) {
  return S.books.find(b => (d.source && b.source === d.source && b.sid === d.sid) ||
    (norm(b.title) === norm(d.title) && norm((b.authors || [])[0]) === norm((d.authors || [])[0])));
}

/* ---------- Search providers ---------- */
const lev = (a, b) => {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};
const sim = (a, b) => (a || b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0);

// "ruin by john gwynne" -> { title: "ruin", author: "john gwynne" }
function parseQuery(q) {
  const m = q.trim().match(/^(.+)\s+by\s+(.+)$/i);
  return m ? { title: m[1].trim(), author: m[2].trim() } : { title: q.trim(), author: "" };
}
// How closely a result's authors match the author typed (0 to 1), forgiving of small typos.
function authorSim(r, pq) {
  const aq = norm(pq.author).split(" ").filter(Boolean);
  if (!aq.length) return 0;
  return Math.max(0, ...(r.authors || []).map(n => {
    const nt = norm(n).split(" ");
    return aq.reduce((s, tok) => s + Math.max(0, ...nt.map(x => sim(tok, x))), 0) / aq.length;
  }));
}
function score(r, pq) {
  const t = norm(pq.title), rt = norm(r.title);
  let ts = rt === t ? 3 : rt.startsWith(t) ? 2.2 : rt.includes(t) ? 1.5 : 0;
  if (!ts) { const qt = t.split(" ").filter(Boolean), set = new Set(rt.split(" ")); ts = qt.length ? qt.filter(x => set.has(x)).length / qt.length : 0; }
  return ts * 2 + (pq.author ? authorSim(r, pq) * 2.5 : 0) + (r.synopsis ? 0.2 : 0) + (r.cover ? 0.1 : 0);
}

function mapGoogle(it) {
  const v = it.volumeInfo || {};
  const s = parseSeries(v.title, v.subtitle);
  const cover = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "").replace("http://", "https://");
  const num = s.number || v.seriesInfo?.bookDisplayNumber || "";
  return {
    source: "gb", sid: it.id, type: "book", title: v.title || "Untitled",
    authors: v.authors || [], synopsis: stripHtml(v.description), cover,
    series: s.series, number: num, meta: v.publishedDate ? v.publishedDate.slice(0, 4) : ""
  };
}
async function googleQuery(q, start) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&startIndex=${start}&printType=books`);
  if (!r.ok) throw new Error("google " + r.status);
  return ((await r.json()).items || []).map(mapGoogle);
}
async function olQuery(params, offset) {
  const r = await fetch(`https://openlibrary.org/search.json?${params}&limit=20&offset=${offset}&fields=key,title,subtitle,author_name,cover_i,first_publish_year`);
  if (!r.ok) throw new Error("ol " + r.status);
  return ((await r.json()).docs || []).map(d => {
    const s = parseSeries(d.title, d.subtitle);
    return {
      source: "ol", sid: d.key, type: "book", title: d.title, authors: d.author_name || [], synopsis: "",
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "",
      series: s.series, number: s.number, meta: d.first_publish_year ? String(d.first_publish_year) : ""
    };
  });
}
// Runs several searches at once (exact title+author, title only, loose) across both services.
async function searchBooks(q, page) {
  const pq = parseQuery(q), enc = encodeURIComponent, off = page * 20;
  const g = pq.author ? [`intitle:${pq.title} inauthor:${pq.author}`, pq.title, `${pq.title} ${pq.author}`] : [q];
  const o = pq.author ? [`title=${enc(pq.title)}&author=${enc(pq.author)}`, `q=${enc(pq.title)}`] : [`q=${enc(q)}`];
  const jobs = [...g.map(x => googleQuery(x, off)), ...o.map(x => olQuery(x, off))];
  const done = (await Promise.allSettled(jobs)).filter(s => s.status === "fulfilled");
  if (!done.length) throw new Error("all searches failed");
  const items = done.flatMap(s => s.value);
  return { items, more: items.length > 0 && page < 4, pq };
}
async function searchManga(q, page) {
  const query = `query($q:String,$p:Int){Page(page:$p,perPage:20){pageInfo{hasNextPage} media(search:$q,type:MANGA,sort:SEARCH_MATCH){id format status volumes chapters title{romaji english} description(asHtml:false) coverImage{large} staff(perPage:4,sort:RELEVANCE){edges{role node{name{full}}}}}}}`;
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { q, p: page + 1 } })
  });
  if (!r.ok) throw new Error("anilist " + r.status);
  const j = await r.json();
  const items = (j.data?.Page?.media || []).map(m => {
    const edges = m.staff?.edges || [];
    let names = edges.filter(e => /story|art/i.test(e.role)).map(e => e.node.name.full);
    if (!names.length) names = edges.slice(0, 1).map(e => e.node.name.full);
    const title = m.title.english || m.title.romaji;
    const bits = [m.format?.replace(/_/g, " ").toLowerCase(), m.volumes ? `${m.volumes} vols` : (m.chapters ? `${m.chapters} ch` : ""), m.status?.replace(/_/g, " ").toLowerCase()].filter(Boolean);
    return {
      source: "al", sid: String(m.id), type: "manga", title, authors: [...new Set(names)],
      synopsis: stripHtml(m.description), cover: m.coverImage?.large || "", series: title, number: "", meta: bits.join(" · ")
    };
  });
  return { items, more: !!j.data?.Page?.pageInfo?.hasNextPage, pq: parseQuery(q) };
}

// Merge new results into the pool; duplicates (same title + author) are combined so the richest data wins.
function addToPool(items) {
  for (const r of items) {
    const key = norm(r.title) + "|" + norm(r.authors[0]);
    const cur = S.pool.get(key);
    if (!cur) { S.pool.set(key, r); continue; }
    for (const f of ["synopsis", "cover", "series", "number", "meta"]) if (!cur[f] && r[f]) cur[f] = r[f];
    if (cur.source === "ol" && r.source === "gb") { cur.source = r.source; cur.sid = r.sid; }
  }
}

/* ---------- Rendering ---------- */
function visibleBooks() {
  let list = S.books.filter(b => b.cats.includes(S.tab));
  if (S.type !== "all") list = list.filter(b => b.type === S.type);
  const by = {
    recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.authors?.[0] || "").localeCompare(b.authors?.[0] || ""),
    series: (a, b) => (a.series || "\uffff").localeCompare(b.series || "\uffff") || (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0) || a.title.localeCompare(b.title),
    custom: (a, b) => {
      const pa = a.pos?.[S.tab], pb = b.pos?.[S.tab];
      if (pa != null && pb != null) return pa - pb;
      if (pa != null) return -1;
      if (pb != null) return 1;
      return (a.addedAt || 0) - (b.addedAt || 0); // unplaced books go to the end, oldest first
    }
  }[sortFor(S.tab)];
  return list.sort(by);
}

function card(b, showCat) {
  const initial = esc((b.title || "?").trim()[0] || "?");
  const cover = b.cover ? `<img class="cover" src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="cover">${initial}</div>`;
  const seriesLine = b.series ? `${esc(b.series)}${b.number ? " #" + esc(b.number) : ""}` : "";
  const chips = [];
  if (showCat) (b.cats || []).forEach(c => chips.push(`<span class="chip hl">${CATS[c]}</span>`));
  if (b.type === "manga") chips.push(`<span class="chip">Manga</span>`);
  if (b.meta) chips.push(`<span class="chip">${esc(b.meta)}</span>`);
  return `${cover}<div class="info"><p class="t">${esc(b.title)}</p><p class="a">${esc((b.authors || []).join(", ") || "Unknown author")}</p>${seriesLine ? `<p class="s">${seriesLine}</p>` : ""}<div class="chips">${chips.join("")}</div></div>`;
}

function render() {
  if (!uid) return;
  const searching = S.q.trim().length > 0;
  if (searching) S.reorder = false;
  $("#title").textContent = searching ? "Search" : CATS[S.tab];
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", !searching && b.dataset.tab === S.tab));
  searching ? renderSearch() : renderLibrary();
}

const GRIP = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>`;

function renderLibrary() {
  const view = $("#view");
  const list = visibleBooks();
  const sort = sortFor(S.tab);
  const typed = (k, l) => `<button data-type="${k}" class="${S.type === k ? "on" : ""}">${l}</button>`;
  const hasAny = S.books.some(b => b.cats.includes(S.tab));
  const bar = S.reorder
    ? `<div class="reorder-bar"><span>Drag the handle on the right to move a book. It saves when you let go.</span><button class="btn primary" id="done">Done</button></div>`
    : hasAny ? `<div class="toolbar">
      <div class="seg">${typed("all", "All")}${typed("book", "Books")}${typed("manga", "Manga")}</div>
      <select id="sort" aria-label="Sort">
        ${[["recent", "Recently added"], ["custom", "My order"], ["title", "Title"], ["author", "Author"], ["series", "Series"]].map(([v, l]) => `<option value="${v}" ${sort === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button class="btn" id="reorder">Reorder</button>
    </div>` : "";
  const items = list.map(b => S.reorder
    ? `<div class="book reord" data-id="${esc(b.id)}">${card(b, false)}<span class="handle" aria-label="Drag to reorder">${GRIP}</span></div>`
    : `<button class="book" data-id="${esc(b.id)}">${card(b, false)}</button>`).join("");
  view.innerHTML = `${bar}
    <div class="list">${items}</div>
    ${!list.length ? `<div class="empty"><b>${hasAny ? "Nothing matches" : "Nothing here yet"}</b>${hasAny ? "Try a different filter." : (S.tab === "library" ? "Every book you have read will be listed here. Find one with the search bar, or tick Library on a book." : "Use the search bar to find a book or manga and add it here.")}</div>` : ""}`;

  if (S.reorder) { $("#done").onclick = () => { S.reorder = false; renderLibrary(); }; setupDrag(); return; }

  view.querySelectorAll("[data-type]").forEach(b => (b.onclick = () => { S.type = b.dataset.type; renderLibrary(); }));
  const sel = $("#sort"); if (sel) sel.onchange = e => { S.sorts[S.tab] = e.target.value; saveSorts(); renderLibrary(); };
  const rb = $("#reorder"); if (rb) rb.onclick = enterReorder;

  // Tap opens a book; press and hold starts reorder mode.
  view.querySelectorAll(".book").forEach(b => {
    let timer, fired = false, sx = 0, sy = 0;
    b.onpointerdown = e => { fired = false; sx = e.clientX; sy = e.clientY; timer = setTimeout(() => { fired = true; navigator.vibrate?.(25); enterReorder(); }, 550); };
    b.onpointermove = e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(timer); };
    b.onpointerup = b.onpointercancel = b.onpointerleave = () => clearTimeout(timer);
    b.oncontextmenu = e => e.preventDefault();
    b.onclick = () => { if (fired) { fired = false; return; } openSheet(S.books.find(x => x.id === b.dataset.id)); };
  });
}

// Save a new order for the current tab (optimistic locally, then to Firestore).
async function writeOrder(ids) {
  const tab = S.tab;
  ids.forEach((id, i) => { const b = S.books.find(x => x.id === id); if (b) b.pos = { ...(b.pos || {}), [tab]: i }; });
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach((id, j) => batch.set(doc(db, "users", uid, "books", id), { pos: { [tab]: i + j } }, { merge: true }));
      await batch.commit();
    }
  } catch { toast("Couldn't save the order"); }
}

function enterReorder() {
  if (S.reorder) return;
  S.type = "all"; // reorder the whole list, not a filtered slice
  const ids = visibleBooks().map(b => b.id); // the order you can see right now
  const unplaced = ids.some(id => S.books.find(b => b.id === id).pos?.[S.tab] == null);
  if (sortFor(S.tab) !== "custom" || unplaced) { S.sorts[S.tab] = "custom"; saveSorts(); writeOrder(ids); }
  S.reorder = true; renderLibrary();
}

function setupDrag() {
  const list = $(".list"); if (!list) return;
  list.querySelectorAll(".handle").forEach(h => {
    h.onpointerdown = e => {
      e.preventDefault();
      const item = h.closest(".book");
      item.classList.add("drag"); S.dragging = true;
      h.setPointerCapture(e.pointerId);
      let y = e.clientY, raf;
      const place = () => {
        const next = [...list.children].filter(c => c !== item).find(c => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
        if (next) { if (item.nextElementSibling !== next) list.insertBefore(item, next); }
        else if (item !== list.lastElementChild) list.appendChild(item);
      };
      const tick = () => {
        if (y < 140) window.scrollBy(0, -14); else if (y > innerHeight - 110) window.scrollBy(0, 14);
        place(); raf = requestAnimationFrame(tick);
      };
      h.onpointermove = ev => { y = ev.clientY; };
      const end = () => {
        cancelAnimationFrame(raf); item.classList.remove("drag");
        h.onpointermove = h.onpointerup = h.onpointercancel = null;
        writeOrder([...list.children].map(c => c.dataset.id));
        S.dragging = false;
      };
      h.onpointerup = h.onpointercancel = end;
      raf = requestAnimationFrame(tick);
    };
  });
}

function renderSearch() {
  const view = $("#view");
  const q = norm(S.q);
  const local = S.books.filter(b => norm(b.title + " " + (b.authors || []).join(" ") + " " + (b.series || "")).includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
  const kind = (k, l) => `<button data-kind="${k}" class="${S.searchKind === k ? "on" : ""}">${l}</button>`;
  view.innerHTML = `
    ${local.length ? `<h2 class="sec">In your shelf</h2><div class="list">${local.map(b => `<button class="book" data-id="${esc(b.id)}">${card(b, true)}</button>`).join("")}</div>` : ""}
    <h2 class="sec">Find online</h2>
    <div class="toolbar">
      <div class="seg">${kind("book", "Books")}${kind("manga", "Manga")}</div>
      <button class="btn primary" id="online" style="margin-left:auto">Search online</button>
    </div>
    <div id="results"></div>
    <button class="btn block" id="manual" style="margin-top:6px">Add manually (for sideloaded files)</button>`;
  view.querySelectorAll("[data-kind]").forEach(b => (b.onclick = () => { S.searchKind = b.dataset.kind; S.results = null; S.onlineQ = ""; S.more = false; renderSearch(); }));
  view.querySelectorAll(".book[data-id]").forEach(b => (b.onclick = () => openSheet(S.books.find(x => x.id === b.dataset.id))));
  $("#online").onclick = () => runOnline(false);
  $("#manual").onclick = () => openSheet({ ...blank(), title: S.q.trim() });
  paintResults();
}

async function runOnline(more = false) {
  const q = S.q.trim(); if (!q) return;
  if (more) { if (S.loadingMore || !S.more) return; S.loadingMore = true; }
  else { S.onlineQ = q; S.page = 0; S.pool = new Map(); S.more = false; S.searching = true; S.results = null; }
  render();
  try {
    const out = await (S.searchKind === "manga" ? searchManga(q, S.page) : searchBooks(q, S.page));
    if (S.onlineQ !== q) return; // a newer search replaced this one
    S.page++; S.more = out.more; S.pq = out.pq;
    addToPool(out.items);
    let list = [...S.pool.values()];
    if (S.searchKind === "book") list = list.map(r => [score(r, out.pq), r]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    S.results = list;
  } catch { if (more) toast("Couldn't load more"); else S.results = "error"; }
  S.searching = false; S.loadingMore = false; render();
}

function paintResults() {
  const box = $("#results"); if (!box) return;
  if (S.searching) { box.innerHTML = `<p class="hint">Searching…</p>`; return; }
  if (S.results === "error") { box.innerHTML = `<p class="hint">Search failed. Check your connection and try again, or add it manually.</p>`; return; }
  if (!S.results) { box.innerHTML = `<p class="hint">Press Enter or tap Search online. Tip: type the title and author together, like “Ruin by John Gwynne”.</p>`; return; }
  if (!S.results.length) { box.innerHTML = `<p class="hint">No results. Try fewer words, or add it manually.</p>`; return; }
  const weak = S.searchKind === "book" && S.pq?.author && Math.max(...S.results.map(r => authorSim(r, S.pq))) < 0.7;
  box.innerHTML = `
    ${weak ? `<p class="hint">No close match for the author “${esc(S.pq.author)}”. Showing the closest titles; check the spelling, or tap Show more results.</p>` : ""}
    <div class="list">${S.results.map((r, i) => {
      const ex = findExisting(r);
      return `<button class="book" data-i="${i}">${card(ex || r, !!ex)}</button>`;
    }).join("")}</div>
    ${S.more ? `<button class="btn block" id="more" style="margin-top:10px" ${S.loadingMore ? "disabled" : ""}>${S.loadingMore ? "Loading…" : "Show more results"}</button>` : ""}
    <div style="height:14px"></div>`;
  box.querySelectorAll(".book").forEach(b => (b.onclick = () => {
    const r = S.results[+b.dataset.i];
    openSheet(findExisting(r) || { ...r, id: newId(), cats: defaultCats(), addedAt: 0 });
  }));
  const more = $("#more"); if (more) more.onclick = () => runOnline(true);
}

// Search bar (lives in the header, so typing never loses focus)
$("#sform").onsubmit = e => { e.preventDefault(); $("#q").blur(); runOnline(false); };
$("#q").oninput = e => {
  S.q = e.target.value;
  if (S.q.trim() !== S.onlineQ) { S.results = null; S.searching = false; }
  render();
};

/* ---------- Book page (add / edit) ---------- */
const blank = () => ({
  id: newId(), source: "", sid: "", type: S.searchKind === "manga" ? "manga" : "book", title: "", authors: [], synopsis: "", cover: "",
  series: "", number: "", meta: "", cats: defaultCats(), addedAt: 0
});

function openSheet(b) {
  const exists = S.books.some(x => x.id === b.id);
  const d = { ...b }; delete d.category; delete d.kobo; delete d.status;
  d.cats = [...(d.cats || defaultCats())];
  const sheet = $("#sheet");
  sheet.innerHTML = `
    <div class="sheet-head">
      ${d.cover ? `<img class="cover" src="${esc(d.cover)}" alt="" referrerpolicy="no-referrer">` : `<div class="cover">${esc((d.title || "+").trim()[0] || "+")}</div>`}
      <div class="info" style="flex:1">
        <label class="f"><span>Title</span><input type="text" id="f-title" value="${esc(d.title)}"></label>
      </div>
    </div>
    <div class="row">
      <label class="f"><span>Series</span><input type="text" id="f-series" value="${esc(d.series)}" placeholder="Not part of a series"></label>
      <label class="f narrow"><span>No.</span><input type="text" id="f-number" value="${esc(d.number)}" inputmode="decimal" placeholder="#"></label>
    </div>
    <label class="f"><span>Author(s), comma separated</span><input type="text" id="f-authors" value="${esc((d.authors || []).join(", "))}"></label>
    <div class="f"><span>Category (Library = books you have read)</span>
      <div class="seg wrap" id="cats">${Object.entries(CATS).map(([v, l]) => `<button type="button" data-c="${v}">${l}</button>`).join("")}</div>
    </div>
    <div class="f"><span>Type</span>
      <div class="seg wide" data-seg="type">${[["book", "Book"], ["manga", "Manga"]].map(([v, l]) => `<button type="button" data-v="${v}" class="${d.type === v ? "on" : ""}">${l}</button>`).join("")}</div>
    </div>
    <label class="f"><span>Synopsis</span><textarea id="f-syn">${esc(d.synopsis)}</textarea></label>
    <div class="actions">
      ${exists ? `<button class="btn danger" id="del">Remove</button>` : ""}
      <button class="btn primary" id="save">${exists ? "Save changes" : "Add to shelf"}</button>
    </div>`;
  $("#scrim").hidden = false; sheet.hidden = false; sheet.scrollTop = 0;
  history.pushState({ sheet: 1 }, "");

  const paintCats = () => sheet.querySelectorAll("#cats button").forEach(x => x.classList.toggle("on", d.cats.includes(x.dataset.c)));
  paintCats();
  sheet.querySelectorAll("#cats button").forEach(btn => (btn.onclick = () => {
    const c = btn.dataset.c;
    if (d.cats.includes(c)) {
      d.cats = d.cats.filter(x => x !== c);
    } else {
      if (STATUS_CATS.includes(c)) d.cats = d.cats.filter(x => !STATUS_CATS.includes(x)); // reading / queue / interested: one at a time
      d.cats.push(c);
    }
    paintCats();
  }));

  sheet.querySelectorAll("[data-seg]").forEach(g => g.querySelectorAll("button").forEach(btn => (btn.onclick = () => {
    d[g.dataset.seg] = btn.dataset.v;
    g.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === btn));
  })));

  // Open Library search results carry no description: fetch it when the page opens.
  if (d.source === "ol" && !d.synopsis) {
    fetch(`https://openlibrary.org${d.sid}.json`).then(r => r.json()).then(w => {
      const t = typeof w.description === "string" ? w.description : w.description?.value;
      if (t && !$("#f-syn").value) $("#f-syn").value = stripHtml(t);
    }).catch(() => {});
  }

  $("#save").onclick = async () => {
    const title = $("#f-title").value.trim();
    if (!title) { toast("Add a title first"); return; }
    d.title = title;
    d.authors = $("#f-authors").value.split(",").map(s => s.trim()).filter(Boolean);
    d.series = $("#f-series").value.trim();
    d.number = $("#f-number").value.trim();
    d.synopsis = $("#f-syn").value.trim();
    if (!d.cats.length) { toast("Pick at least one category"); return; }
    d.addedAt = d.addedAt || Date.now();
    try { await saveBook(d); toast(exists ? "Saved" : "Added to your shelf"); } catch { toast("Couldn't save"); }
    closeSheet(true);
  };
  const del = $("#del");
  if (del) del.onclick = async () => {
    if (!confirm(`Remove "${d.title}" from your shelf?`)) return;
    await removeBook(d.id); toast("Removed"); closeSheet(true);
  };
}

function closeSheet(pop) {
  if ($("#sheet").hidden) return;
  $("#sheet").hidden = true; $("#scrim").hidden = true;
  if (pop && history.state?.sheet) history.back();
}
$("#scrim").onclick = () => closeSheet(true);
window.addEventListener("popstate", () => closeSheet(false));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(true); });

/* ---------- Menu: backup / restore / sign out ---------- */
$("#menuBtn").onclick = () => {
  const sheet = $("#sheet");
  sheet.innerHTML = `
    <label class="f"><span>Signed in as ${esc(auth?.currentUser?.email || "")}</span></label>
    <p class="hint">${S.books.length} items on your shelf. App version ${APP_VERSION}.</p>
    <div class="actions" style="margin-bottom:14px">
      <button class="btn" id="exp">Copy backup</button>
      <button class="btn" id="imp">Restore backup</button>
    </div>
    <label class="f"><span>Backup text (paste here to restore)</span><textarea id="bk" placeholder="Paste a backup here, then press Restore backup"></textarea></label>
    <button class="btn block danger" id="out">Sign out</button>`;
  $("#scrim").hidden = false; sheet.hidden = false;
  history.pushState({ sheet: 1 }, "");
  $("#exp").onclick = async () => {
    const text = JSON.stringify(S.books);
    $("#bk").value = text;
    try { await navigator.clipboard.writeText(text); toast("Backup copied"); } catch { $("#bk").select(); toast("Select and copy the text"); }
  };
  $("#imp").onclick = async () => {
    let arr; try { arr = JSON.parse($("#bk").value); if (!Array.isArray(arr)) throw 0; arr = arr.map(migrate); } catch { toast("That doesn't look like a backup"); return; }
    for (let i = 0; i < arr.length; i += 400) {
      const batch = writeBatch(db);
      arr.slice(i, i + 400).filter(b => b && b.title).forEach(b => { b.id = b.id || newId(); batch.set(doc(db, "users", uid, "books", b.id), b); });
      await batch.commit();
    }
    toast(`Restored ${arr.length} items`); closeSheet(true);
  };
  $("#out").onclick = () => { closeSheet(true); signOut(auth); };
};

/* ---------- Tabs ---------- */
$("#tabs").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  S.reorder = false; S.tab = b.dataset.tab; S.q = ""; $("#q").value = ""; S.results = null; S.onlineQ = ""; render(); window.scrollTo(0, 0);
};
