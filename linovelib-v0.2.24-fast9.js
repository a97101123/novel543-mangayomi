const mangayomiSources = [{
  name: "嗶哩輕小說（繁體）",
  lang: "zh",
  baseUrl: "https://tw.linovelib.com",
  apiUrl: "",
  iconUrl: "https://tw.linovelib.com/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.2.24",
  dateFormat: "",
  dateFormatLocale: "",
  isNsfw: false,
  hasCloudflare: true
}];

class DefaultExtension extends MProvider {
  getHeaders(url) {
    const searchHost = /^https?:\/\/www\.bilinovel\.com\//i.test(String(url || ""));
    return {
      "Referer": searchHost ? "https://www.bilinovel.com/" : "https://tw.linovelib.com/",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7"
    };
  }

  // The source runs in QuickJS, which does not provide a reliable sleep API.
  // Wait INSIDE the page's actual WebView before acknowledging the captured
  // content, so the next chapter-page navigation is paced without busy-waiting.
  // A smaller delay reduces waiting time but may trigger the site's rate limit.
  async chapterPaceRange() {
    let choice = "5000";
    try {
      if (typeof SharedPreferences !== "undefined") {
        const v = await new SharedPreferences().get("linovelib_chapter_pace");
        if (v !== null && v !== undefined) choice = String(v);
      }
    } catch (_) {}
    if (choice === "8000") return {min:8000, jitter:3000};
    if (choice === "2000") return {min:2000, jitter:2000};
    // Fast-window mode stays below the observed page-11 rate-limit boundary:
    // read nine parts without an artificial pause, then keep the ninth WebView
    // open for a 45-60s cooldown before the next navigation. The old batch5
    // preference is mapped here so an upgrade cannot retain its unsafe pause.
    if (choice === "sprint9" || choice === "batch5")
      return {mode:"sprint9", min:45000, jitter:15000};
    return {min:5000, jitter:2000};
  }

  chapterPaceAfterPage(pace, pageNumber) {
    if (pace && pace.mode === "sprint9" && pageNumber % 9 !== 0)
      return {mode:"sprint9", min:0, jitter:0};
    return {min:pace.min, jitter:pace.jitter};
  }

  // Rate-limit protection for this source. Mangayomi's embedded JS runtime
  // does not expose a guaranteed non-blocking sleep API. Therefore we persist
  // a next-allowed time and reject requests *before* network I/O rather than
  // spin/sleep inside the reader. A Retry-After from the server always wins.
  rateGateKey() { return "linovelib_rate_gate_v020"; }

  async readRateGate() {
    let state = this._rateGateMemory || null;
    try {
      if (typeof SharedPreferences !== "undefined") {
        const raw = await new SharedPreferences().getString(this.rateGateKey(), "");
        if (raw) {
          const saved = JSON.parse(String(raw));
          if (saved && saved.version === 1 && Number.isFinite(saved.until) &&
              Number.isFinite(saved.last429At) && Number.isInteger(saved.count) &&
              saved.count >= 0 && saved.count <= 100 &&
              (!state || saved.last429At > state.last429At ||
               (saved.last429At === state.last429At && saved.until > state.until))) {
            state = saved;
          }
        }
      }
    } catch (_) { /* Keep the in-memory protection when storage is unavailable. */ }
    return state;
  }

  async ensureRateAllowed() {
    const state = await this.readRateGate();
    if (state && state.until > Date.now()) {
      const seconds = Math.max(1, Math.ceil((state.until - Date.now()) / 1000));
      throw new Error("Linovelib：HTTP 429 冷卻中，約 " + seconds +
        " 秒後才能再次向網站請求。已阻止連線，請勿連續按 Retry。");
    }
  }

  // Retry-After is either delta-seconds or an RFC-style HTTP date, and is
  // optional. Never assume a particular CDN always sends it.
  parseRetryAfterMs(response, now = Date.now()) {
    const headers = response?.headers || {};
    let value = "";
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== "retry-after") continue;
      const raw = headers[key];
      value = String(Array.isArray(raw) ? raw[0] : raw || "").trim();
      break;
    }
    if (!value) return null;
    if (/^\d+(?:\.\d+)?$/.test(value)) {
      const ms = Math.ceil(Number(value) * 1000);
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) ? Math.max(0, time - now) : null;
  }

  async recordRateLimit(response = null) {
    const now = Date.now();
    const previous = await this.readRateGate();
    const count = previous && now - previous.last429At < 6 * 3600000
      ? Math.min(10, previous.count + 1) : 1;
    const announced = this.parseRetryAfterMs(response, now);
    // Missing Retry-After: conservatively back off across *separate user
    // attempts*: 60s, 120s, 240s, ... capped at 15 min, with 0-10s jitter.
    // A server-provided Retry-After is not shortened or overridden by jitter.
    const fallback = Math.min(15 * 60000, 60000 * Math.pow(2, count - 1)) +
      Math.floor(Math.random() * 10000);
    const ms = announced === null ? fallback : Math.max(1000, announced);
    const state = {version:1, count, last429At:now, until:now + ms};
    this._rateGateMemory = state;
    try {
      if (typeof SharedPreferences !== "undefined")
        await new SharedPreferences().setString(this.rateGateKey(), JSON.stringify(state));
    } catch (_) { /* In-memory cooldown still applies to this runtime. */ }
    const seconds = Math.ceil(ms / 1000);
    throw new Error("Linovelib：HTTP 429，" +
      (announced !== null ? "依網站 Retry-After" : "依指數退避與隨機抖動") +
      "進入冷卻，約 " + seconds + " 秒後再試；已停止後續請求。");
  }

  // Adapted reliability pattern: retry one transient network/server error,
  // never retry a 403 challenge or a 429 rate-limit response automatically.
  async load(url) {
    await this.ensureRateAllowed();
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await new Client().get(url, this.getHeaders(url));
      } catch (error) {
        lastError = error;
        if (attempt === 0) continue;
        throw new Error("Linovelib：連線失敗（" + String(error) + "）");
      }
      const status = Number(response?.statusCode ?? response?.status ?? 200);
      if ([502, 503, 504].includes(status) && attempt === 0) continue;
      if (status === 429) await this.recordRateLimit(response);
      if ([401, 403].includes(status)) throw new Error("Linovelib：網站要求驗證或拒絕存取（HTTP " + status + "）");
      if (status >= 400) throw new Error("Linovelib：網站回應 HTTP " + status);
      const html = String(response?.body || "");
      if (!html.trim()) {
        if (attempt === 0) continue;
        throw new Error("Linovelib：網頁沒有回傳 HTML");
      }
      // A successful HTTP status does not guarantee a readable document.
      if (/cf-challenge|challenge-platform|<title[^>]*>\s*(?:Just a moment|Checking your browser)/i.test(html.slice(0,4000))) {
        throw new Error("Linovelib：取得網站驗證頁，而非所需的小說資料");
      }
      return new Document(html);
    }
    throw new Error("Linovelib：請求暫時失敗（" + String(lastError || "no_response") + "）");
  }

  absolute(href, context) {
    const value = String(href || "").trim().replace(/&amp;/g, "&");
    if (!value || /^javascript:|^#|^data:/i.test(value)) return "";
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("//")) return "https:" + value;
    if (value.startsWith("/")) return this.source.baseUrl + value;
    const path = String(context || this.source.baseUrl + "/").split(/[?#]/)[0];
    const folder = path.slice(0, path.lastIndexOf("/") + 1);
    return folder + value;
  }

  first(doc, selectors) {
    for (const selector of selectors) {
      const el = doc.selectFirst(selector);
      if (el) return el;
    }
    return null;
  }

  txt(el) { return el ? String(el.text || "").trim() : ""; }
  attr(el, key) { return el ? (el.attr(key) || "") : ""; }
  blank() { return { list: [], hasNextPage: false }; }

  // Prefer the website's direct cover URL over a lazy-load placeholder or
  // an image host that needs a special Referer.
  canonicalCover(bookLink) {
    const id = this.novelId(bookLink);
    if (!id) return "";
    return this.source.baseUrl + "/files/article/image/" + Math.floor(Number(id) / 1000) + "/" + id + "/" + id + "s.jpg";
  }

  meaningfulImage(src) {
    const value = String(src || "").trim();
    if (!value || /^(?:data:|blob:|javascript:|#)/i.test(value)) return false;
    if (/\b(?:blank|placeholder|loading|default[-_]?(?:cover|img)|no[-_]?image)\b/i.test(value)) return false;
    return true;
  }

  getImageAttribute(el) {
    if (!el) return "";
    const keys = ["data-src", "data-original", "data-lazy-src", "data-echo", "data-url", "src"];
    for (const key of keys) {
      const candidate = this.attr(el, key);
      if (this.meaningfulImage(candidate)) return candidate;
    }
    return "";
  }

  // The site has /novel/NNNN.html book URLs.
  bookPath(href) {
    return /\/novel\/\d+\.html(?:[?#].*)?$/i.test(href);
  }

  listFromPage(doc, pageUrl, allowLoose) {
    const results = [];
    const seen = new Set();
    let cards = doc.select("ol.book-ol > li, .book-ol > li, li.book-li, li.book-li, .book-item");
    if (!cards.length) cards = doc.select(".book-ol li, .book-list li");
    if (!cards.length && allowLoose) cards = doc.select("a[href]");

    for (const card of cards) {
      const links = card.select("a[href]");
      let anchor = null;
      for (const a of links) {
        const href = this.absolute(this.attr(a, "href"), pageUrl);
        if (this.bookPath(href)) {
          anchor = a;
          break;
        }
      }
      if (!anchor && this.attr(card, "href")) {
        const href = this.absolute(this.attr(card, "href"), pageUrl);
        if (this.bookPath(href)) anchor = card;
      }
      if (!anchor) continue;
      const link = this.absolute(this.attr(anchor, "href"), pageUrl);
      if (seen.has(link)) continue;
      const titleEl = this.first(card, [
        ".book-title", ".book-title-x", "h2", "h3", "h4"
      ]);
      let name = this.txt(titleEl) || this.txt(anchor);
      name = name.replace(/^\d+(?:\.\d+)?\s+/, "").trim();
      if (!name) continue;
      const cover = this.first(card, ["img[data-src]", "img[data-original]", "img"]);
      const observedImage = this.absolute(this.getImageAttribute(cover), pageUrl);
      const canonicalImage = this.canonicalCover(link);
      // Images inside listing cards may be JavaScript placeholders or
      // protected third-party CDN URLs. Prefer the direct book cover path.
      const imageUrl = observedImage || canonicalImage;
      results.push({ name, link, imageUrl });
      seen.add(link);
    }
    return results;
  }

  async getPopular(page) {
    if (page < 1) return this.blank();
    const url = this.source.baseUrl + "/wenku/allvisit_0_0_0_0_0_0_0_" + page + "_0.html";
    const doc = await this.load(url);
    const list = this.listFromPage(doc, url, false);
    return { list, hasNextPage: list.length >= 20 };
  }

  async getLatestUpdates(page) {
    if (page < 1) return this.blank();
    const url = this.source.baseUrl + "/wenku/lastupdate_0_0_0_0_0_0_0_" + page + "_0.html";
    const doc = await this.load(url);
    const list = this.listFromPage(doc, url, false);
    return { list, hasNextPage: list.length >= 20 };
  }

  // The site's guarded search sometimes makes the native HTTP client fail
  // before HTML is returned (including "127.0.0.1:80 connection refused").
  // Use an ordinary browser-rendered search page first, not fabricated cookies.
  async searchViaBrowser(searchUrl, word) {
    await this.ensureRateAllowed();
    if (typeof evaluateJavascriptViaWebview !== "function") {
      throw new Error("Linovelib：此 Mangayomi 版本沒有背景瀏覽器搜尋功能");
    }
    const script = String.raw`(function () {
      if (window.__linovelibSearch028) return;
      window.__linovelibSearch028 = true;
      var sent = false, started = Date.now(), timer = null, last = "", stable = 0;
      function send(data) {
        if (sent) return;
        sent = true;
        if (timer) clearInterval(timer);
        window.flutter_inappwebview.callHandler("setResponse", JSON.stringify(data));
      }
      function poll() {
        var path = String(location.pathname || "");
        var title = String(document.title || "");
        var guarded = /Just a moment|Checking your browser|安全驗證|請稍候/i.test(title) ||
          !!document.querySelector("#challenge-form, .cf-challenge, #cf-challenge-running");
        if (!guarded) {
          var direct = path.match(/^\/novel\/(\d+)\.html$/);
          if (direct) {
            var bookName = (document.querySelector('meta[property="og:novel:book_name"]') || {}).content ||
              (document.querySelector("h1, .book-title") || {}).textContent || "";
            var cover = (document.querySelector('meta[property="og:image"]') || {}).content || "";
            send({list: [{name: String(bookName).trim(), link: location.href, imageUrl: cover}], error:"", direct:true});
            return;
          }
          var entries = [], seen = {};
          var anchors = document.querySelectorAll("ol.book-ol .book-li a.book-layout[href], ol.book-ol a.book-layout[href], .book-ol a.book-layout[href], .book-list a[href*='/novel/'], .book-layout[href*='/novel/']");
          for (var i = 0; i < anchors.length; i++) {
            var a = anchors[i];
            var href = a.getAttribute("href") || "";
            try { href = new URL(href, location.href).href; } catch (_) { continue; }
            if (!/\/novel\/\d+\.html(?:[?#].*)?$/i.test(href) || seen[href]) continue;
            var card = a.closest("li") || a;
            var label = card.querySelector(".book-title, .book-title-x, .module-slide-caption, h2, h3, h4") || a;
            var img = card.querySelector("img");
            var image = img ? (img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src") || "") : "";
            try { if (image) image = new URL(image, location.href).href; } catch (_) { image = ""; }
            var name = String(label.textContent || img?.alt || "").trim();
            if (!name) continue;
            seen[href] = true;
            entries.push({name:name, link:href, imageUrl:image});
          }
          var signature = entries.length + ":" + (entries[0] ? entries[0].link : "");
          if (entries.length && signature === last) stable++;
          else {last = signature; stable = 0;}
          if (entries.length && stable >= 2) { send({list:entries, error:""}); return; }
          // Empty results may be a blocked/partially rendered page. Never
          // mistake an unrelated homepage listing for search results.
          if (Date.now() - started > 11000) {
            send({list:[], error:"search_page_empty_or_guarded"}); return;
          }
        }
        if (Date.now() - started > 13500) send({list:[], error:"verification_timeout"});
      }
      timer = setInterval(poll, 500);
      poll();
    })();`;
    const value = await evaluateJavascriptViaWebview(searchUrl, this.getHeaders(searchUrl), [script], 17);
    let data;
    try { data = JSON.parse(String(value || "")); }
    catch (_) { throw new Error("Linovelib：背景搜尋沒有回傳有效資料"); }
    if (!data || !Array.isArray(data.list) || data.error) {
      throw new Error("Linovelib：背景搜尋尚未取得結果（" + String(data?.error || "empty") + "）");
    }
    const list = [], seen = new Set();
    for (const item of data.list) {
      const link = this.absolute(item?.link, searchUrl)
        .replace(/^https?:\/\/www\.bilinovel\.com/i, this.source.baseUrl);
      if (!this.bookPath(link) || seen.has(link)) continue;
      const name = String(item.name || "").trim();
      if (!name) continue;
      seen.add(link);
      list.push({name, link, imageUrl: this.absolute(item.imageUrl, searchUrl) || this.canonicalCover(link)});
    }
    return list;
  }

  // Search and book-detail pages use different hosts. Numeric IDs should
  // never be sent to the site's guarded keyword-search endpoint.
  searchBookId(word) {
    const m = String(word || "").trim().match(/^(?:https?:\/\/(?:tw\.linovelib\.com|www\.bilinovel\.com))?(?:\/novel\/)?(\d+)(?:\.html)?(?:[?#].*)?$/i);
    return m ? m[1] : "";
  }

  // The HTTP lookup is the cheap path; the headless browser is a fallback.
  // If both fail, a clearly labelled direct navigation result is returned
  // rather than silently reporting that a user-supplied book ID does not exist.
  async searchByBookId(bookId) {
    await this.ensureRateAllowed();
    const bookUrl = this.source.baseUrl + "/novel/" + bookId + ".html";
    let firstError = null;
    try {
      const response = await new Client().get(bookUrl, this.getHeaders(bookUrl));
      const status = Number(response?.statusCode ?? response?.status ?? 200);
      if (status === 429) await this.recordRateLimit(response);
      if (status >= 400 || !response?.body) throw new Error("HTTP " + status);
      const doc = new Document(response.body);
      const name = this.attr(doc.selectFirst('meta[property="og:novel:book_name"]'), "content") ||
        this.txt(this.first(doc, [".book-detail-info .book-title", ".book-title", "h1"]));
      if (!name || /Just a moment|Checking your browser|安全驗證/i.test(name)) throw new Error("非書籍詳情頁");
      const imageUrl = this.absolute(this.attr(doc.selectFirst('meta[property="og:image"]'), "content"), bookUrl) ||
        this.canonicalCover(bookUrl);
      return [{ name, link: bookUrl, imageUrl }];
    } catch (error) {
      if (this.isRateLimitFailure(error)) throw error;
      firstError = error;
    }
    try {
      const list = await this.searchViaBrowser(bookUrl, bookId);
      if (list.length) return list.map(book => ({ ...book, link: bookUrl }));
    } catch (_) { /* No browser support is required for the last fallback. */ }
    // A URL shortcut, NOT an assertion that a page exists. The user explicitly
    // supplied an ID; opening the card delegates validation to getDetail().
    return [{
      name: "書籍 ID " + bookId + "（點擊開啟詳情；尚未驗證）",
      link: bookUrl,
      imageUrl: this.canonicalCover(bookUrl)
    }];
  }

  // Only parse cookies that the site has issued. We do not invent tokens,
  // silently ignore verification failures, or attempt to solve a CAPTCHA.
  searchCookieFromHeader(response, cookieName) {
    const headers = response?.headers || {};
    let raw = "";
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "set-cookie") {
        const value = headers[key];
        raw += " " + (Array.isArray(value) ? value.join("; ") : String(value || ""));
      }
    }
    const m = raw.match(new RegExp("(?:^|[,;\\s])" + cookieName + "=([^;,\\s]+)", "i"));
    return m ? m[1] : "";
  }

  searchGuardHeaders(url, cookies) {
    const headers = this.getHeaders(url);
    headers["User-Agent"] = "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/135.0.0.0 Mobile Safari/537.36";
    headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    headers["Cache-Control"] = "no-cache";
    if (cookies) headers["Cookie"] = cookies;
    return headers;
  }

  // The search host primarily indexes simplified Chinese. A conservative
  // character map helps common Traditional Chinese queries without changing
  // the original query shown to the user. This is not full OpenCC conversion.
  simplifyCommonSearchChars(word) {
    const pairs = {
      "詭":"诡", "謎":"谜", "靈":"灵", "懸":"悬", "驚":"惊", "嚇":"吓", "謊":"谎", "偵":"侦", "諜":"谍", "祕":"秘", "隱":"隐", "歡":"欢", "轉":"转", "實":"实", "來":"来", "級":"级", "輕":"轻", "說":"说",
      "異":"异", "夢":"梦", "劍":"剑", "龍":"龙", "書":"书", "學":"学", "職":"职",
      "國":"国", "為":"为", "開":"开", "覺":"觉", "戀":"恋", "愛":"爱", "貓":"猫",
      "關":"关", "於":"于", "這":"这", "個":"个", "現":"现", "樣":"样", "遊":"游",
      "戲":"戏", "機":"机", "會":"会", "體":"体", "隨":"随", "從":"从", "歲":"岁",
      "對":"对", "戰":"战", "敗":"败", "壞":"坏", "帶":"带", "種":"种", "發":"发",
      "長":"长", "廣":"广", "終":"终", "續":"续", "電":"电", "話":"话", "進":"进"
    };
    return Array.from(String(word || "")).map(ch => pairs[ch] || ch).join("");
  }

  async searchGuarded(word) {
    // Search service protocol observed in the site's public client: acquire
    // server-issued JS/CSS guard cookies, redeem them for a search ticket, and
    // perform the ordinary search. The TW site is the book-data origin.
    const host = "https://www.bilinovel.com";
    const client = new Client();
    const fetch = async (stage, url, cookies) => {
      let response;
      try { response = await client.get(url, this.searchGuardHeaders(url, cookies)); }
      catch (e) { throw new Error(stage + "：" + String(e)); }
      const code = Number(response?.statusCode ?? response?.status ?? 0);
      if (!response || code >= 400) throw new Error(stage + "：HTTP " + code);
      return response;
    };
    const js = await fetch("JS guard", host + "/search.html?search_guard=js", "");
    const jsMatch = String(js.body || "").match(/(?:^|["'])jieqiSearchJs=([^;"']+)/);
    if (!jsMatch) throw new Error("JS guard：沒有收到網站核發的搜尋權杖");
    const css = await fetch("CSS guard", host + "/search.html?search_guard=css", "");
    const cssToken = this.searchCookieFromHeader(css, "jieqiSearchCss");
    if (!cssToken) throw new Error("CSS guard：沒有收到網站 Cookie");
    const requestCookies = "night=0; jieqiSearchJs=" + jsMatch[1] + "; jieqiSearchCss=" + cssToken;
    const redeem = await fetch("Ticket", host + "/search.html?search_guard=redeem&r=" + Date.now(), requestCookies);
    const ticket = this.searchCookieFromHeader(redeem, "jieqiSearchTicket");
    if (!ticket) throw new Error("Ticket：網站未核發搜尋票證");
    const url = host + "/search.html?searchkey=" + encodeURIComponent(this.simplifyCommonSearchChars(word));
    const response = await fetch("Search", url, "jieqiSearchTicket=" + ticket);
    const html = String(response.body || "");
    if (!html || /cf-challenge|challenge-platform|search_guard=|jieqiSearchTicket/i.test(html.slice(0,3000))) {
      throw new Error("Search：網站回傳驗證頁而非搜尋結果");
    }
    const doc = new Document(html);
    const directUrl = this.attr(doc.selectFirst('meta[property="og:url"]'), "content");
    const redirectedBook = this.novelId(directUrl);
    if (redirectedBook && /og:novel:book_name/.test(html)) {
      const bookUrl = this.source.baseUrl + "/novel/" + redirectedBook + ".html";
      const name = this.attr(doc.selectFirst('meta[property="og:novel:book_name"]'), "content");
      if (name) return [{ name, link: bookUrl, imageUrl: this.absolute(this.attr(doc.selectFirst('meta[property="og:image"]'), "content"), bookUrl) || this.canonicalCover(bookUrl) }];
    }
    const list = this.listFromPage(doc, url, true).list;
    // Translate search host links back to the established TW site so that
    // library identities and existing saved chapter URLs remain unchanged.
    return list.map(item => ({
      ...item,
      link: String(item.link).replace(/^https?:\/\/www\.bilinovel\.com/i, this.source.baseUrl)
    }));
  }

  // Public catalogue by verified tag. This is a category browse, not the
  // site's protected full-text search, so it does not claim to find every
  // title/author matching the supplied word.
  async searchPublicCategory(word, page) {
    const tag = String(word || "").trim();
    const genreId = /^(轉生|转生)$/.test(tag) ? 26 : 0;
    if (!genreId || page < 1) return null;
    const url = this.source.baseUrl + "/wenku/lastupdate_" + genreId + "_0_0_0_0_0_0_" + page + "_0.html";
    const doc = await this.load(url);
    const list = this.listFromPage(doc, url, false);
    if (!list.length) throw new Error("Linovelib：公開分類頁未回傳作品");
    return { list, hasNextPage: list.length >= 20 };
  }

  // Limited fallback: only match titles visible on public popularity/update
  // pages. Never imply that an absent result means the entire site lacks it.
  async searchPublicListings(word) {
    const base = this.source.baseUrl;
    const paths = [
      "/wenku/lastupdate_0_0_0_0_0_0_0_1_0.html",
      "/wenku/lastupdate_0_0_0_0_0_0_0_2_0.html",
      "/wenku/allvisit_0_0_0_0_0_0_0_1_0.html"
    ];
    const found = [], seen = new Set();
    const normalized = String(word || "").toLowerCase().replace(/\s+/g, "");
    const pages = await Promise.allSettled(paths.map(async p => {
      const url = base + p;
      return this.listFromPage(await this.load(url), url, false);
    }));
    for (const page of pages) {
      if (page.status !== "fulfilled") continue;
      for (const item of page.value.list) {
        const label = String(item.name || "").toLowerCase().replace(/\s+/g, "");
        if (!label.includes(normalized) || seen.has(item.link)) continue;
        seen.add(item.link);
        found.push(item);
      }
    }
    return found;
  }

  // Matches book TITLES only. A category tag is not the same as the title
  // containing that word. Normalise a limited set of T/S variants for matching.
  titleMatchesQuery(title, keyword) {
    const normalized = value => this.simplifyCommonSearchChars(String(value || ""))
      .toLowerCase().replace(/[\s　·・,，.。:：'’"“”\-—_()（）\[\]【】「」！？!?|｜]+/g, "");
    const needle = normalized(keyword);
    return !!needle && normalized(title).includes(needle);
  }

  // Independent, public Google Programmable Search Engine (CSE) configured in
  // the user's previously supplied Legado source. No protected site-search
  // tickets are forged. A result must point to a Linovelib BOOK page.
  async searchViaCse(keyword) {
    if (typeof evaluateJavascriptViaWebview !== "function") {
      throw new Error("Mangayomi 不支援背景 CSE 搜尋");
    }
    const url = "https://cse.google.com.hk/cse?cx=649de34f5e63448cb" +
      "#gsc.tab=0&gsc.q=" + encodeURIComponent(keyword) + "&gsc.page=1";
    const script = String.raw`(function () {
      if (window.__linovelibCse211) return;
      window.__linovelibCse211 = true;
      var sent = false, timer, start = Date.now(), prior = "", stable = 0;
      function done(value) {
        if (sent) return;
        sent = true;
        clearInterval(timer);
        window.flutter_inappwebview.callHandler("setResponse", JSON.stringify(value));
      }
      function poll() {
        if (document.querySelector("#recaptcha, .g-recaptcha, #captcha-form")) {
          done({list:[], error:"verification_required"}); return;
        }
        var links = document.querySelectorAll(
          ".gsc-webResult a.gs-title[href], .gsc-webResult .gs-title a[href], " +
          ".gsc-result a.gs-title[href], .gsc-result .gs-title a[href]"
        );
        var list = [], seen = {};
        for (var i=0; i<links.length; i++) {
          var a=links[i], raw=a.href || a.getAttribute("href") || "";
          var matched = raw.match(/(?:https?:\/\/)?(?:tw\.linovelib\.com|www\.linovelib\.com|www\.bilinovel\.com)\/novel\/(\d+)\.html/i);
          if (!matched) {
            try {
              var target=new URL(raw, location.href);
              var candidate=target.searchParams.get("q") || target.searchParams.get("url") || "";
              matched=candidate.match(/(?:tw\.linovelib\.com|www\.linovelib\.com|www\.bilinovel\.com)\/novel\/(\d+)\.html/i);
            } catch(_) {}
          }
          if (!matched || seen[matched[1]]) continue;
          var name=(a.textContent || "").trim();
          if (!name) continue;
          seen[matched[1]]=true;
          list.push({id:matched[1], name:name});
        }
        var sig=list.map(function(x){return x.id;}).join("|");
        if (sig && sig===prior) stable++;
        else { prior=sig; stable=0; }
        if (list.length && stable>=2) {done({list:list,error:""});return;}
        if (document.querySelector(".gs-no-results-result, .gsc-result-info-container .gs-no-results-result")) {
          done({list:[],error:""}); return;
        }
        if (Date.now()-start>10500) done({list:list,error:list.length?"":"cse_unavailable_or_empty"});
      }
      timer=setInterval(poll,500);
      poll();
    })();`;
    const raw = await evaluateJavascriptViaWebview(url, {}, [script], 14);
    let value;
    try { value=JSON.parse(String(raw || "")); }
    catch (_) { throw new Error("CSE 回傳格式無法解析"); }
    if (!value || !Array.isArray(value.list) || value.error) {
      throw new Error("CSE 未取得結果（" + String(value?.error || "invalid_response") + "）");
    }
    const results=[], seen=new Set();
    for(const item of value.list) {
      if (!/^\d+$/.test(String(item.id || ""))) continue;
      const link=this.source.baseUrl + "/novel/" + item.id + ".html";
      const name=String(item.name || "")
        .replace(/\s*[_|｜-]\s*(?:嗶哩輕小說|哔哩轻小说)[\s\S]*$/i, "")
        .replace(/\s*(?:線上看|在线阅读|epub,?txt下載)[\s\S]*$/i, "").trim();
      if (!this.titleMatchesQuery(name, keyword) || seen.has(link)) continue;
      seen.add(link);
      results.push({name,link,imageUrl:this.canonicalCover(link)});
    }
    return results;
  }

  // Keep title lookup bounded and SERIAL: no second catalogue request is
  // already in flight when the first returns a server rate limit.
  // This is a LIMITED public-title match, not full-site search.
  async searchPublicTitles(keyword) {
    const base = this.source.baseUrl;
    const latest = n => base + "/wenku/lastupdate_0_0_0_0_0_0_0_" + n + "_0.html";
    const popular = n => base + "/wenku/allvisit_0_0_0_0_0_0_0_" + n + "_0.html";
    const urls = [latest(1), popular(1), latest(2), popular(2), latest(3), latest(4)];
    if (/^(轉生|转生)$/.test(keyword)) {
      const category = n => base + "/wenku/lastupdate_26_0_0_0_0_0_0_" + n + "_0.html";
      // Query the published category early, without treating unrelated
      // category entries as matches for the user's book-title query.
      urls.splice(2, 0, category(1), category(2));
    }
    const out = [], seen = new Set();
    let reachablePages = 0, checkedTitles = 0, rateLimited = false;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const batch = await Promise.allSettled([(async () => {
        const doc = await this.load(url);
        return this.listFromPage(doc, url, false).list;
      })()]);
      for (const entry of batch) {
        if (entry.status !== "fulfilled") {
          if (/\b429\b|限制請求頻率|Too Many Requests/i.test(String(entry.reason))) rateLimited = true;
          continue;
        }
        if (!Array.isArray(entry.value) || !entry.value.length) continue;
        reachablePages++;
        checkedTitles += entry.value.length;
        for (const item of entry.value) {
          if (!this.titleMatchesQuery(item.name, keyword) || seen.has(item.link)) continue;
          seen.add(item.link);
          out.push(item);
        }
      }
      // Stop issuing extra catalogue requests once enough matches exist,
      // or as soon as the server requests fewer connections.
      if (rateLimited || out.length >= 6) break;
    }
    if (rateLimited && !out.length) {
      throw new Error("Linovelib：公開書庫回傳 HTTP 429，停止搜尋請求，請稍後再試");
    }
    return {list: out, reachablePages, checkedTitles};
  }

  async search(query, page, filters) {
    const word=String(query ?? "").trim();
    if(!word || page<1) return this.blank();
    const id=this.searchBookId(word);
    if(id) return page>1 ? this.blank() : {list:await this.searchByBookId(id),hasNextPage:false};
    if(page>1) return this.blank();
    const [publicResult,cseResult]=await Promise.allSettled([
      this.searchPublicTitles(word),this.searchViaCse(word)
    ]);
    const combined=[], seen=new Set();
    const append=(items)=>{
      for(const item of items || []) {
        if(!this.titleMatchesQuery(item.name,word) || seen.has(item.link)) continue;
        seen.add(item.link);
        combined.push(item);
      }
    };
    if(cseResult.status==="fulfilled") append(cseResult.value);
    if(publicResult.status==="fulfilled") append(publicResult.value.list);
    if(combined.length) return {list:combined.slice(0,45),hasNextPage:false};
    // If the public catalogue was accessible, this is a genuine NO MATCH
    // in the sampled pages. Show normal 'No result' instead of a scary error.
    // The extension notes explain that coverage is not all-site search.
    if(publicResult.status==="fulfilled" && publicResult.value.reachablePages>0) return this.blank();
    // No search source worked: do NOT falsely report that the book is absent.
    throw new Error("Linovelib v0.2.17：搜尋來源無法存取，無法判定書名是否存在。" +
      "可改用書籍 ID 查詢；網站完整搜尋須有正常核發的搜尋票證。" +
      (publicResult.status==="rejected" ? " 公開書庫："+String(publicResult.reason) : "") +
      (cseResult.status==="rejected" ? " CSE："+String(cseResult.reason) : ""));
  }

  novelId(url) {
    const m = String(url).match(/\/novel\/(\d+)(?:\.html|\/catalog|\/)/);
    return m ? m[1] : "";
  }

  async getDetail(url) {
    const id = this.novelId(url);
    if (!id) throw new Error("Linovelib：書籍網址無效");
    const bookUrl = this.source.baseUrl + "/novel/" + id + ".html";
    const doc = await this.load(bookUrl);
    const name = this.attr(doc.selectFirst('meta[property="og:novel:book_name"]'), "content") ||
      this.txt(this.first(doc, ["h1", ".book-title"]));
    const author = this.attr(doc.selectFirst('meta[property="og:novel:author"]'), "content") ||
      this.txt(this.first(doc, [".book-author", ".author"]));
    const description = this.txt(this.first(doc, [
      "#bookSummary", ".book-desc", ".book-intro", ".intro"
    ]));
    const cover = this.first(doc, [".book-img img", ".book-cover img", "img"]);
    const imageUrl = this.absolute(
      this.attr(doc.selectFirst('meta[property="og:image"]'), "content") ||
      this.attr(cover, "data-src") || this.attr(cover, "src"), bookUrl
    );
    const genres = [];
    for (const el of doc.select(".tag-small, .book-tag a, .tag-small-group a")) {
      const t = this.txt(el);
      if (t && !genres.includes(t)) genres.push(t);
    }

    const catalogUrl = this.source.baseUrl + "/novel/" + id + "/catalog";
    const catalog = await this.load(catalogUrl);
    const entries = this.readCatalogEntries(catalog, id, catalogUrl);
    if (!entries.length) throw new Error("Linovelib：目錄沒有有效章節");
    await this.resolveVirtualChapters(entries, id);
    // Mangayomi derives its reading order and "missing chapters" count
    // from the FIRST number in each displayed title. Linovelib titles such as
    // "插圖", "〇99%" and "5.25 ..." are not a sequential chapter series.
    // Add a consecutive DISPLAY-ORDER prefix, while retaining the complete
    // original title and URL. These numbers are catalog positions, NOT the
    // publisher's real chapter numbering.
    const chapters = [];
    const seen = new Set();
    for (const entry of entries) {
      if (!entry.url || seen.has(entry.url)) continue;
      seen.add(entry.url);
      const order = chapters.length + 1;
      chapters.push({
        name: this.mangayomiOrderedTitle(order, entry.name),
        url: entry.url,
        dateUpload: null,
        scanlator: null
      });
    }
    if (!chapters.length) throw new Error("Linovelib：沒有可閱讀的章節網址");
    return {
      name, link: bookUrl, author, artist: "", imageUrl, description,
      genre: genres, status: 5, chapters
    };
  }

  // Display-order key only; preserve the complete site chapter title.
  // Four digits keep chapter ordering consistent for books with many entries.
  mangayomiOrderedTitle(position, originalName) {
    const number = String(position).padStart(4, "0");
    return number + "｜" + String(originalName || "").trim();
  }

  validChapterUrl(url, bookId) {
    const value = String(url || "").split(/[?#]/)[0];
    const re = new RegExp("^https?://[^/]+/novel/" + bookId + "/[0-9]+(?:_[0-9]+)?\\.html$", "i");
    return re.test(value);
  }

  chapterStart(url) {
    return String(url || "").split(/[?#]/)[0].replace(/_\d+\.html$/i, ".html");
  }

  // Choose chapter elements, not the page navigation/related-book links.
  readCatalogEntries(doc, bookId, catalogUrl) {
    const selectors = [
      "#catelogX .chapter-li:not(.volume-cover)",
      "#volumes .catalog-volume .jsChapter a",
      ".catalog-volume .jsChapter a",
      "a[href]"
    ];
    let best = [];
    for (const selector of selectors) {
      const entries = [];
      for (const node of doc.select(selector)) {
        const a = this.attr(node, "href") ? node : node.selectFirst("a[href]");
        if (!a) continue;
        const raw = this.attr(a, "href").trim();
        const name = this.txt(a);
        const url = this.absolute(raw, catalogUrl);
        const virtual = /^javascript:\s*cid\s*\(/i.test(raw);
        if (!name || (!virtual && !this.validChapterUrl(url, bookId))) continue;
        entries.push({name, url: virtual ? "" : url, virtual});
      }
      if (entries.length > best.length) best = entries;
    }
    return best;
  }

  readNavigationParam(doc, param, pageUrl) {
    const snippets = [];
    for (const el of doc.select("script")) snippets.push(String(el.innerHtml || el.text || ""));
    const body = doc.selectFirst("body");
    if (body) snippets.push(String(body.innerHtml || ""));
    const re = new RegExp("\\b" + param + "\\s*:\\s*['\"]([^'\"]+?\\.html(?:[?#][^'\"]*)?)['\"]", "i");
    for (const snippet of snippets) {
      const found = snippet.match(re);
      if (found) return this.absolute(found[1], pageUrl);
    }
    return "";
  }

  chapterTitleKey(text) {
    return String(text || "").replace(/&nbsp;/gi, " ")
      .replace(/^[〇○◯●•·\s]+/, "").replace(/[\uFE0E\uFE0F]/g, "")
      .replace(/[\s　·・,，.。:：'’"“”\-—_()（）\[\]【】「」！？!?]+/g, "")
      .toLowerCase();
  }

  // Follow site's previous-chapter navigation from the next real link.
  // Verify the candidate's #atitle before accepting a formerly virtual entry.
  async resolveVirtualChapters(entries, bookId) {
    const virtualCount = entries.filter(x => x.virtual).length;
    if (!virtualCount || virtualCount > 12) return;
    const cached = new Map();
    const loadOnce = async url => {
      if (!cached.has(url)) cached.set(url, this.load(url).catch(() => null));
      return cached.get(url);
    };
    const used = new Set(entries.filter(x => x.url).map(x => x.url));
    let budget = 24;
    for (let i = 0; i < entries.length && budget > 1;) {
      if (!entries[i].virtual) { i++; continue; }
      const start = i;
      while (i < entries.length && entries[i].virtual) i++;
      const end = i;
      if (end >= entries.length || !entries[end].url) continue;
      let rightUrl = entries[end].url;
      for (let k = end - 1; k >= start && budget > 1; k--) {
        budget--;
        const rightDoc = await loadOnce(rightUrl);
        if (!rightDoc) break;
        const previous = this.readNavigationParam(rightDoc, "url_previous", rightUrl);
        const candidate = this.chapterStart(previous);
        if (!this.validChapterUrl(candidate, bookId) || used.has(candidate) || candidate === rightUrl) break;
        budget--;
        const targetDoc = await loadOnce(candidate);
        if (!targetDoc) break;
        const title = this.txt(this.first(targetDoc, ["#atitle", "h1"]));
        if (!this.chapterTitleKey(entries[k].name) ||
            this.chapterTitleKey(entries[k].name) !== this.chapterTitleKey(title)) break;
        entries[k].url = candidate;
        entries[k].virtual = false;
        used.add(candidate);
        rightUrl = candidate;
      }
    }
  }

  // Preserve HTML image nodes and their metadata; only repair URL-bearing
  // attributes. Mangayomi currently hides <img> in online novels, but these
  // real URLs remain ready for a reader update. Do not turn novels into manga.
  readerImageUrl(value, pageUrl) {
    const raw = String(value || "").trim().replace(/&amp;/gi, "&");
    if (!raw || /^(?:javascript:|blob:|#)/i.test(raw)) return "";
    if (/^data:image\//i.test(raw)) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("//")) return "https:" + raw;
    const baseUrl = String(pageUrl || this.source.baseUrl + "/");
    const origin = (baseUrl.match(/^https?:\/\/[^/]+/i) || [this.source.baseUrl])[0];
    const basePath = baseUrl.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
    const cut = raw.search(/[?#]/);
    const pathname = cut < 0 ? raw : raw.slice(0, cut);
    const suffix = cut < 0 ? "" : raw.slice(cut);
    const rawPath = pathname.startsWith("/") ? pathname
      : basePath.slice(0, basePath.lastIndexOf("/") + 1) + pathname;
    const segments = [];
    for (const segment of rawPath.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    return origin + "/" + segments.join("/") + suffix;
  }

  readerImageAttr(tag, key) {
    const re = new RegExp("(?:^|\\s)" + key + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
    const m = String(tag).match(re);
    return m ? (m[1] || m[2] || m[3] || "") : "";
  }

  readerImageSetAttr(tag, key, value) {
    const safe = String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const re = new RegExp("\\s+" + key + "\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)", "i");
    if (re.test(tag)) return tag.replace(re, ' ' + key + '="' + safe + '"');
    return tag.replace(/\s*\/?>$/, end => ' ' + key + '="' + safe + '"' + (end.includes("/") ? ' />' : '>'));
  }

  readerImageSrcset(raw, pageUrl) {
    return String(raw || "").split(",").map(entry => {
      const p = entry.trim().match(/^(\S+)(\s+.*)?$/);
      if (!p) return entry;
      const url = this.readerImageUrl(p[1], pageUrl);
      return url ? url + (p[2] || "") : entry;
    }).join(", ");
  }

  preserveReaderImages(html, pageUrl) {
    let output = String(html || "");
    // Images in noscript are legitimate fallbacks on some novel sites.
    output = output.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi,
      (all, inner) => /<(?:img|picture|figure)\b/i.test(inner) ? inner : "");
    output = output.replace(/<(?:img|source)\b[^>]*>/gi, tag => {
      // Preserve alt, captions, width, height, class, figure/picture layout,
      // existing links and data-* attributes. Eliminate executable handlers.
      let repaired = tag.replace(/\s+on(?:load|error|click)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
      const isImg = /^<img\b/i.test(tag);
      const originalSet = this.readerImageAttr(repaired, "data-srcset") ||
        this.readerImageAttr(repaired, "srcset");
      if (originalSet) {
        const set = this.readerImageSrcset(originalSet, pageUrl);
        if (set && !/^data:/i.test(set)) repaired = this.readerImageSetAttr(repaired, "srcset", set);
      }
      if (!isImg) return repaired;
      let src = "";
      for (const key of ["data-src", "data-original", "data-lazy-src", "data-echo",
                         "data-url", "data-lazyload", "data-img", "src"]) {
        const value = this.readerImageAttr(repaired, key).trim();
        if (!value || /^(?:about:blank|#|javascript:|blob:)/i.test(value)) continue;
        if (/^data:image\/(?:gif|png);base64,/i.test(value) && value.length < 180) continue;
        if (/placeholder|loading(?:\.gif|\.png)|blank\.gif|no[-_]?image/i.test(value)) continue;
        src = value; break;
      }
      if (!src && originalSet) src = originalSet.split(",")[0].trim().split(/\s+/)[0];
      const resolved = this.readerImageUrl(src, pageUrl);
      if (resolved) repaired = this.readerImageSetAttr(repaired, "src", resolved);
      // If the source supplied only a placeholder, retain its original tag so
      // evidence of an unresolved image is not silently deleted.
      return repaired;
    });
    return output;
  }

  // Render-only optimization. Does not change the original chapter URLs,
  // chapter listing, WebView request pace, image nodes, or purchase state.
  // The official Mangayomi paginator measures every HTML block with a
  // TextPainter. Very long plain <p> nodes can trigger expensive splitting.
  // Keep the source's exact characters and preserve inline markup where it
  // matters (especially custom fonts, ruby text, images and linked notes).
  async readCompactReaderPreference() {
    let enabled = "on";
    try {
      if (typeof SharedPreferences !== "undefined") {
        const setting = await new SharedPreferences().get("linovelib_reader_compact");
        if (setting !== undefined && setting !== null) enabled = String(setting);
      }
    } catch (_) {}
    this._compactReaderEnabled = enabled !== "off";
  }

  compactReaderHtml(html) {
    let original = String(html || "");
    if (this._compactReaderEnabled === false) return original;
    // Never strip custom-font wrappers: the Linovelib website sometimes
    // renders private-use characters using a downloadable font. Likewise,
    // leave annotated (ruby) text intact.
    const unsafeToUnwrap = /[\uE000-\uF8FF]|<ruby\b|<math\b|<svg\b/i.test(original);
    let compact = original.replace(/<!--[\s\S]*?-->/g, "");
    if (!unsafeToUnwrap) {
      // Remove decorative span/font containers, NOT their content. All image,
      // picture, a[href], ruby, emphasis and heading tags stay in place.
      compact = compact.replace(/<\/?(?:span|font)\b[^>]*>/gi, "");
    }
    // Split only unusually long *plain text* paragraphs. For paragraphs
    // with inline tags/images, leave their tree untouched to prevent damage.
    // Preserve code points, entities and original punctuation byte for byte.
    compact = compact.replace(/<p\b([^>]*)>([^<>]{850,})<\/p>/gi, (whole, attributes, text) => {
      if (/[\uE000-\uF8FF]/.test(text)) return whole;
      const pieces = [];
      let rest = text;
      while (rest.length > 660 && pieces.length < 80) {
        let cut = 520;
        // Prefer splitting AFTER existing full stops/sentence endings,
        // retaining punctuation, indentation and spaces exactly.
        for (let pos = Math.min(rest.length - 1, 640); pos >= 380; pos--) {
          if (/[。！？!?；;…]/.test(rest[pos])) { cut = pos + 1; break; }
        }
        // Do not bisect a surrogate pair or an HTML character reference.
        const previous = rest.charCodeAt(cut - 1);
        if (previous >= 0xD800 && previous <= 0xDBFF) cut++;
        const amp = rest.lastIndexOf("&", cut - 1);
        const semi = rest.lastIndexOf(";", cut - 1);
        if (amp > semi && cut - amp <= 32) {
          const closing = rest.indexOf(";", cut);
          if (closing >= 0 && closing - cut <= 32) cut = closing + 1;
        }
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (!pieces.length) return whole;
      pieces.push(rest);
      return pieces.map(chunk => "<p" + attributes + ">" + chunk + "</p>").join("");
    });
    return compact;
  }

  normalizeImageTags(html, chapterUrl) {
    // Preserve original image HTML, including picture/source, lazy attributes,
    // title/alt/size and surrounding figure captions.
    return this.preserveReaderImages(html, chapterUrl);
  }

  cleanContent(html, chapterUrl, chapterTitle = "") {
    let s = String(html || "");
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
    s = s.replace(/<ins\b[^>]*>[\s\S]*?<\/ins>/gi, "");
    s = s.replace(/<a\b[^>]*>\s*(?:上一章|下一章|目錄|書頁)\s*<\/a>/gi, "");
    // Whole-block notices only. Keep all legitimate story paragraphs intact.
    s = s.replace(/<(p|div|center|small|span)\b[^>]*>([\s\S]*?)<\/\1>/gi, (all, tag, inner) => {
      if (/<(?:p|div|section|img)\b/i.test(inner)) return all;
      const text = inner.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/gi, " ")
        .replace(/\s+/g, "").trim();
      if (/^下載後請在?24小時內刪除[，,。]?TSDM不負擔任何責任[。！!]*$/i.test(text)) return "";
      if (/^[〖【]?手機版頁面由於相容性問題暫不支持電腦端閱讀[，,]?請使用手機閱讀[。！!]?[〗】]?$/.test(text)) return "";
      return all;
    });
    // A site obfuscation layer can duplicate entire long paragraphs. Remove
    // *exact* second occurrences only (not similar text or short refrains).
    // Never deduplicate image-containing paragraphs.
    if (!/(?:插圖|插画|彩圖|彩图|彩頁|彩页)/.test(chapterTitle)) {
      const repeated = new Set();
      s = s.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, p => {
        if (/<img\b/i.test(p)) return p;
        const key = p.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/gi, " ")
          .replace(/\s+/g, "").trim();
        if (key.length < 65) return p;
        if (repeated.has(key)) return "";
        repeated.add(key);
        return p;
      });
    }
    // Some illustration pages repeat long publishing-credit paragraphs.
    // Limit this to illustration chapters to avoid deleting repeated prose.
    if (/(?:插圖|插画|彩圖|彩图|彩頁|彩页)/.test(chapterTitle)) {
      const seen = new Set();
      s = s.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, p => {
        if (/<img\b/i.test(p)) return p;
        const key = p.replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim();
        if (key.length < 90) return p;
        if (seen.has(key)) return "";
        seen.add(key);
        return p;
      });
    }
    return this.compactReaderHtml(this.normalizeImageTags(s, chapterUrl).trim());
  }

  pageBase(path) {
    return String(path).replace(/_\d+\.html(?:[?#].*)?$/, ".html").replace(/[?#].*$/, "");
  }

  nextSubPage(doc, currentUrl) {
    // An official ReadParams link may point to the next part or the next chapter.
    let html = "";
    const scripts = doc.select("script");
    for (const script of scripts) html += "\n" + (script.innerHtml || script.text || "");
    let match = html.match(/\burl_next\s*:\s*['"]([^'"]+\.html)['"]/i);
    if (!match) {
      const body = doc.selectFirst("body");
      html = body ? String(body.innerHtml || "") : "";
      match = html.match(/\burl_next\s*:\s*['"]([^'"]+\.html)['"]/i);
    }
    if (!match) {
      // PC/alternate mobile layouts may expose the immediate continuation
      // as an HTML pagination anchor rather than ReadParams.url_next.
      for (const link of doc.select(".mlfy_page a[href], .read-page a[href], .pager a[href], .page-next a[href]")) {
        const candidate = this.absolute(this.attr(link, "href"), currentUrl);
        if (this.isChapterContinuation(currentUrl, candidate)) return candidate;
      }
      return "";
    }
    const next = this.absolute(match[1], currentUrl);
    const current = currentUrl.split(/[?#]/)[0];
    // Valid continuation: 263394.html -> 263394_2.html -> 263394_3.html
    const path = current.replace(/\.html$/, "").replace(/_\d+$/, "");
    if (!next.startsWith(path + "_")) return "";
    if (!/_\d+\.html(?:[?#].*)?$/.test(next)) return "";
    return next;
  }

  // HTTP-first path: an HTTP response is fast only if it really contains the
  // complete chapter rather than a loading placeholder. Do not silently
  // accept challenge text, font-obfuscated glyphs, or a partial article.
  declaredContentId(doc) {
    try {
      for (const script of doc.select("script")) {
        const text = String(script.innerHtml || script.text || "");
        const found = text.match(/\bcontentid\s*:\s*['"]([A-Za-z][\w:-]{0,70})['"]/i);
        if (found) return found[1];
      }
    } catch (_) {}
    return "";
  }

  // Mirror the previous WebView paragraph-permutation algorithm without
  // evaluating any site JS. Preserve every non-paragraph node (especially
  // illustration markup) in its original location. Reject ambiguous nested
  // paragraph layouts rather than risking a damaged chapter.
  restoreHttpParagraphOrder(html, container, chapterUrl) {
    const text = String(html || "");
    const pattern = /<p\b[^>]*>[\s\S]*?<\/p\s*>/gi;
    const matches = Array.from(text.matchAll(pattern));
    const usable = matches.filter(m => m[0].replace(/<[^>]*>/g, "").replace(/\s/g, "") || /<img\b/i.test(m[0]));
    if (usable.length <= 20) return text;
    if (usable.length > 600) throw new Error("Linovelib：HTTP 段落過多，改用瀏覽器驗證");
    // Document.children excludes text nodes; that is deliberate. The previous
    // WebView restoration also permutes *direct* nonempty <p> children only.
    const direct = (container.children || []).filter(node =>
      String(node.localName || "").toLowerCase() === "p" &&
      String(node.innerHtml || "").replace(/\s/g, "").length > 0);
    if (direct.length !== usable.length) {
      throw new Error("Linovelib：HTTP 段落層級不明，改用瀏覽器驗證");
    }
    for (let i = 0; i < direct.length; i++) {
      if (String(direct[i].outerHtml || "") !== usable[i][0]) {
        throw new Error("Linovelib：HTTP 段落標記不一致，改用瀏覽器驗證");
      }
    }
    const match = String(chapterUrl || "").match(/\/novel\/\d+\/(\d+)(?:_\d+)?\.html(?:[?#]|$)/i);
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      throw new Error("Linovelib：章節編號無法驗證，改用瀏覽器");
    }
    const permutation = usable.map((_, i) => i);
    let seed = Number(match[1]) * 126 + 232;
    for (let i = permutation.length - 1; i > 20; i--) {
      seed = (seed * 9302 + 49397) % 233280;
      const j = 20 + Math.floor(seed / 233280 * (i - 20 + 1));
      const temp = permutation[i]; permutation[i] = permutation[j]; permutation[j] = temp;
    }
    const sorted = usable.map(m => m[0]);
    for (let raw = 0; raw < usable.length; raw++) sorted[permutation[raw]] = usable[raw][0];
    let cursor = 0, j = 0, output = "";
    for (const m of matches) {
      output += text.slice(cursor, m.index);
      const included = !!(m[0].replace(/<[^>]*>/g, "").replace(/\s/g, "") || /<img\b/i.test(m[0]));
      output += included ? sorted[j++] : m[0];
      cursor = m.index + m[0].length;
    }
    return output + text.slice(cursor);
  }

  readHttpChapter(doc, chapterUrl) {
    const declared = this.declaredContentId(doc);
    const selectors = [];
    if (declared) selectors.push("#" + declared);
    selectors.push("#acontent1", "#acontentz", "#acontent", "#TextContent", ".chapter-content", "#ccacontent");
    let best = null;
    const seen = new Set();
    for (const selector of selectors) {
      if (seen.has(selector)) continue;
      seen.add(selector);
      const container = doc.selectFirst(selector);
      const raw = String(container?.innerHtml || "").trim();
      if (!raw) continue;
      const plain = String(container?.text || "").replace(/\s+/g, "");
      const images = (raw.match(/<img\b/gi) || []).length;
      // Very long merged chapters may show a long valid-looking prefix and
      // then a site failure marker at the END. Reject it rather than treating
      // truncated text as a complete page.
      if (/內容加載失敗|内容加载失败|請重載或更換瀏覽器|本章內容正在載入|章节内容不支持该浏览器显示|正在加載|正在加载/i.test(plain.slice(0,160) + " " + plain.slice(-450))) continue;
      if ((plain.length < 120 && !images) || (plain.length < 35 && images < 1)) continue;
      // These fonts substitute characters at paint time; plain HTTP cannot
      // reconstruct them reliably. A rendered browser remains necessary.
      if ((plain.match(/[\uE000-\uF8FF]/g) || []).length >= 3 ||
          /font-family\s*:\s*['"]?read(?:[;'",\s]|$)/i.test(raw)) continue;
      const paragraphCount = (raw.match(/<p\b/gi) || []).length;
      if (images === 0 && paragraphCount < 2 && plain.length < 500) continue;
      const score = plain.length + images * 80 + paragraphCount * 5;
      if (!best || score > best.score) best = {container, raw, score};
    }
    if (!best) throw new Error("Linovelib：HTTP 正文尚未完整載入（content_missing），改用背景 WebView");
    const reordered = this.restoreHttpParagraphOrder(best.raw, best.container, chapterUrl);
    const html = this.cleanContent(reordered, chapterUrl,
      this.txt(doc.selectFirst("#atitle")));
    const meaningful = html.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "")
      .replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|\s/gi, "").trim();
    if ((!meaningful && !/<img\b/i.test(html)) ||
        (meaningful.length < 120 && !/<img\b/i.test(html))) {
      throw new Error("Linovelib：HTTP 回應僅有佔位內容，改用背景 WebView");
    }
    return {html, next: this.nextSubPage(doc, chapterUrl)};
  }

  // Chapter HTTP requests get one short attempt. 429 is terminal for this
  // reading action: repeatedly opening more connections makes limits worse.
  async loadChapterOnce(url) {
    await this.ensureRateAllowed();
    const response = await new Client({timeout: 6}).get(url, this.getHeaders(url));
    const status = Number(response?.statusCode ?? response?.status ?? 0);
    if (status === 429) await this.recordRateLimit(response);
    if (status === 403 || status === 401) throw new Error("Linovelib：網站要求驗證（HTTP " + status + "）");
    if (status >= 400 || !response?.body) throw new Error("Linovelib：HTTP " + status + " 或空白回應");
    const body = String(response.body);
    if (/cf-challenge|challenge-platform|<title[^>]*>\s*(?:Just a moment|Checking your browser)/i.test(body.slice(0,5000))) {
      throw new Error("Linovelib：網站要求驗證，HTTP 取得的是驗證頁");
    }
    return new Document(body);
  }

  // Fallback only: render JavaScript-created or font-obfuscated chapter text
  // when static HTML cannot be verified. This is a headless WebView, not the
  // manual WebView button. Keep the v0.2.15 stable-content capture behavior.
  async readRenderedChapter(chapterUrl, pace = {min:5000, jitter:2000}) {
    await this.ensureRateAllowed();
    if (typeof evaluateJavascriptViaWebview !== "function") {
      throw new Error("Linovelib：此 Mangayomi 版本不支援背景 WebView");
    }
    const paceMin = Math.max(0, Math.min(60000,
      Number.isFinite(Number(pace.min)) ? Number(pace.min) : 5000));
    const paceJitter = Math.max(0, Math.min(15000,
      Number.isFinite(Number(pace.jitter)) ? Number(pace.jitter) : 2000));
    // Allow the WebView to return after a deliberate long cooldown.
    const webviewTimeout = Math.max(30,
      Math.ceil((paceMin + paceJitter + 15000) / 1000));
    const script = String.raw`(function () {
      if (window.__linovelibPaced221) return;
      window.__linovelibPaced221 = true;
      var finished = false;
      var start = Date.now();
      var signature = "";
      var stableCount = 0;
      var timer = null;
      function report(value) {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        // Rate-limit and verification errors report immediately, with no
        // automatic retry. For a verified page that has a next page, spacing
        // the success acknowledgement spaces the NEXT network navigation.
        // This timer is a WebView timer, not a QuickJS busy-wait.
        var delay = (value && value.html && value.next)
          ? ${paceMin} + Math.floor(Math.random() * ${paceJitter + 1})
          : 0;
        var send = function () {
          window.flutter_inappwebview.callHandler("setResponse", JSON.stringify(value));
        };
        if (delay > 0) setTimeout(send, delay);
        else send();
      }
      function validSrc(value) {
        return !!value && !/^(?:data:|blob:|javascript:|#)/i.test(value) &&
          !/placeholder|loading|blank|no[-_]?image/i.test(value);
      }
      function restoreParagraphOrder(root) {
        var match = location.pathname.match(/\/novel\/\d+\/(\d+)(?:_\d+)?\.html$/);
        if (!match) return;
        var chapterId = Number(match[1]);
        if (!Number.isSafeInteger(chapterId)) return;
        var children = Array.prototype.slice.call(root.children);
        var paragraphs = children.filter(function(node) {
          return node.tagName && node.tagName.toLowerCase() === "p" &&
            String(node.innerHTML || "").replace(/\s+/g, "").length > 0;
        });
        if (paragraphs.length <= 20) return;
        var perm = paragraphs.map(function(_, i) { return i; });
        var seed = chapterId * 126 + 232;
        for (var i = perm.length - 1; i > 20; i--) {
          seed = (seed * 9302 + 49397) % 233280;
          var j = 20 + Math.floor(seed / 233280 * (i - 20 + 1));
          var tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
        }
        var restored = paragraphs.slice();
        for (var raw = 0; raw < paragraphs.length; raw++) {
          restored[perm[raw]] = paragraphs[raw];
        }
        // Clone replacement nodes before DOM mutation, avoiding accidental
        // movement of a paragraph needed by a subsequent replacement.
        var copies = restored.map(function(node) { return node.cloneNode(true); });
        for (var k = 0; k < paragraphs.length; k++) {
          paragraphs[k].parentNode.replaceChild(copies[k], paragraphs[k]);
        }
      }
      // Copy browser-resolved lazy image URLs into real src attributes.
      function snapshot(el) {
        var clone = el.cloneNode(true);
        // Remove explicitly hidden site-injected decoys before counting and
        // reordering paragraphs. Do not delete generic center/image nodes.
        var junk = clone.querySelectorAll(".cgo, script, style, ins");
        for (var z = junk.length - 1; z >= 0; z--) junk[z].remove();
        restoreParagraphOrder(clone);
        var copiedImgs = clone.querySelectorAll("img");
        for (var k = 0; k < copiedImgs.length; k++) {
          var copied = copiedImgs[k];
          var original = copied;
          if (!copied) continue;
          var src = "";
          var candidates = ["data-src", "data-original", "data-lazy-src", "data-echo", "data-url", "src"];
          for (var m = 0; m < candidates.length; m++) {
            var candidate = original.getAttribute(candidates[m]) || "";
            if (validSrc(candidate)) { src = candidate; break; }
          }
          if (!src && validSrc(original.currentSrc)) src = original.currentSrc;
          if (!src) {
            var srcset = original.getAttribute("data-srcset") || original.getAttribute("srcset") || "";
            var first = srcset.split(",")[0].trim().split(/\s+/)[0];
            if (validSrc(first)) src = first;
          }
          if (src) {
            try { copied.setAttribute("src", new URL(src, location.href).href); }
            catch (_) { copied.setAttribute("src", src); }
          }
        }
        return clone.innerHTML;
      }
      function detectGuard() {
        var title = String(document.title || "");
        var text = String((document.body && (document.body.innerText || document.body.textContent)) || "").slice(0,1400);
        if (/429|Too Many Requests|請求過於頻繁|请求过于频繁|訪問過於頻繁|访问过于频繁/i.test(title)) return "rate_limited";
        if (/^\s*(?:429|Too Many Requests|Rate Limit Exceeded)/i.test(text)) return "rate_limited";
        if (/Just a moment|Checking your browser|安全驗證|安全验证/i.test(title) ||
            document.querySelector("#challenge-form, #cf-challenge-running, .cf-challenge")) return "verification_required";
        return "";
      }
      function candidateElements() {
        var nodes = [], seen = [];
        function add(node) { if (node && seen.indexOf(node)<0) { seen.push(node); nodes.push(node); } }
        // Linovelib's own reading script may change the content id; don't
        // assume it is always #acontent or #acontentz.
        try {
          var id = window.ReadTools && window.ReadTools.contentid;
          if (id && /^[A-Za-z][\w:-]{0,70}$/.test(id)) add(document.getElementById(id));
        } catch (_) {}
        ["acontent1", "acontentz", "acontent", "TextContent", "ccacontent"].forEach(function(id) {
          add(document.getElementById(id));
        });
        var extra = document.querySelectorAll("[id^='acontent'], .chapter-content");
        for (var x=0; x<extra.length && x<15; x++) add(extra[x]);
        return nodes;
      }
      function getNext() {
        var next = (window.ReadParams && window.ReadParams.url_next) || "";
        if (!next) {
          var scripts = document.querySelectorAll("script");
          for (var n=0; n<scripts.length; n++) {
            var found = String(scripts[n].textContent || "").match(/\burl_next\s*:\s*['"]([^'"]+\.html)['"]/i);
            if (found) {next = found[1]; break;}
          }
        }
        return next;
      }
      function poll() {
        try {
          var elapsed = Date.now() - start;
          var guard = detectGuard();
          if (guard) {report({html:"",error:guard,next:""}); return;}
          var best = null;
          var nodes = candidateElements();
          for (var i=0; i<nodes.length; i++) {
            var el = nodes[i];
            if (!el) continue;
            var plain = String(el.innerText || el.textContent || "").trim();
            var count = el.querySelectorAll("img").length;
            var len = plain.replace(/\s+/g, "").length;
            if (/內容加載失敗|内容加载失败|請重載或更換瀏覽器|本章內容正在載入|章节内容不支持该浏览器显示/i.test(plain.slice(0,140) + " " + plain.slice(-450))) continue;
            // Don't accept a loading placeholder, menu, or empty chapter.
            if ((len < 75 && count===0) || !String(el.innerHTML||"").trim()) continue;
            var para = el.querySelectorAll("p").length;
            var score = len + count * 70 + para * 4;
            if (!best || score > best.score) best = {el:el,len:len,count:count,para:para,score:score};
          }
          if (best) {
            // Avoid expensive cloning/reordering during every readiness poll.
            var raw = String(best.el.innerHTML||"");
            var current = [best.len, best.count, best.para, raw.length, raw.slice(-50)].join(":");
            if (current === signature) stableCount++;
            else { signature=current; stableCount=0; }
            // Two stable polls (~600ms) after the browser's onLoadStop.
            // An illustration-only page can still succeed with count>0.
            if (stableCount>=2 && elapsed>=650) {
              report({html:snapshot(best.el),next:getNext(),title:(document.querySelector("#atitle")||{}).textContent||"",error:""});
              return;
            }
          }
          if (elapsed >= 9500) {
            report({html:"",next:"",error:best?"content_unstable":"content_missing"});
          }
        } catch (err) {
          report({html:"",next:"",error:"capture_error:"+String(err)});
        }
      }
      timer = setInterval(poll, 300);
      poll();
    })();`;

    let result;
    try {
      result = await evaluateJavascriptViaWebview(
        chapterUrl, this.getHeaders(chapterUrl), [script], webviewTimeout
      );
    } catch (error) {
      throw new Error("Linovelib：背景載入失敗：" + String(error));
    }
    let payload;
    try { payload = JSON.parse(String(result || "")); }
    catch (_) { throw new Error("Linovelib：背景 WebView 沒有回傳有效 JSON"); }
    if (!payload || !payload.html) {
      const reason = String(payload?.error || "no_result");
      if (reason === "rate_limited") await this.recordRateLimit(null);
      if (reason === "verification_required") throw new Error("Linovelib：網站要求驗證，請在 WebView 完成驗證");
      throw new Error("Linovelib：背景載入沒有取得完整正文（" + reason + "）");
    }
    const html = this.cleanContent(payload.html, chapterUrl, payload.title || "");
    if (!html) throw new Error("Linovelib：背景載入後正文仍為空");
    return {html, next: this.absolute(payload.next || "", chapterUrl)};
  }

  isChapterContinuation(currentUrl, nextUrl) {
    const current = String(currentUrl || "").split(/[?#]/)[0];
    const next = String(nextUrl || "").split(/[?#]/)[0];
    // Require the immediate next subpage, never another chapter or a skipped
    // part; this prevents silently returning incomplete text.
    const prev = current.match(/^(https?:\/\/[^/]+\/novel\/\d+\/\d+)(?:_(\d+))?\.html$/i);
    const after = next.match(/^(https?:\/\/[^/]+\/novel\/\d+\/\d+)_(\d+)\.html$/i);
    return !!prev && !!after && prev[1] === after[1] &&
      Number(after[2]) === (prev[2] ? Number(prev[2]) : 1) + 1;
  }

  // A pointer to a later page of the *same* chapter must not silently
  // terminate the chapter if a part is skipped or duplicated.
  checkedContinuation(currentUrl, candidateUrl) {
    if (!candidateUrl) return "";
    if (this.isChapterContinuation(currentUrl, candidateUrl)) return candidateUrl;
    const base = String(currentUrl || "").split(/[?#]/)[0]
      .replace(/_\d+\.html$/i, ".html").replace(/\.html$/i, "");
    const path = String(candidateUrl || "").split(/[?#]/)[0];
    if (path.startsWith(base + "_") && /_\d+\.html$/i.test(path)) {
      throw new Error("Linovelib：網站分頁不連續，為避免漏頁已停止（" + path + "）");
    }
    return "";
  }

  // A catalog item may group 6-8 original chapters (e.g. book 5298).
  // Follow only the site's verified immediate next-page links; never guess a
  // URL merely because the title says "Chapter 1-6".
  // 128 is a failsafe, not a claim that a book has 128 pages.
  maxPagesPerChapter(url) { return 128; }

  isRateLimitFailure(error) {
    return /(?:HTTP\s*429|rate_limited|限制請求頻率|請求過於頻繁|Too Many Requests)/i.test(String(error || ""));
  }

  isLocalWebViewBridgeFailure(error) {
    const message = String(error || "");
    return /不支援背景 WebView/i.test(message) ||
      /(?:localhost|127\.0\.0\.1)[\s\S]{0,180}Connection refused/i.test(message) ||
      /Connection refused[\s\S]{0,180}(?:localhost|127\.0\.0\.1)/i.test(message);
  }

  // A 429 at page 12 should not force a new attempt to re-download pages
  // 1–11. Store verified pages only AFTER an interrupted read. This is
  // ordinary source preference storage, not a server-side cache or an auth
  // token. The record expires after 48 hours and is bounded to 1 MB.
  resumeKey(url) {
    const m = String(url || "").match(/\/novel\/(\d+)\/(\d+)(?:_\d+)?\.html(?:[?#]|$)/i);
    return m ? "linovelib_verified_resume_v019_" + m[1] + "_" + m[2] : "";
  }

  async readResume(url) {
    const key = this.resumeKey(url);
    if (!key) return null;
    let raw = "";
    try {
      if (typeof SharedPreferences !== "undefined") {
        raw = await new SharedPreferences().getString(key, "");
      }
      if (!raw && this._ephemeralResume && this._ephemeralResume.key === key)
        raw = this._ephemeralResume.raw;
      if (!raw) return null;
      const value = JSON.parse(String(raw));
      if (!value || value.version !== 1 || value.start !== url ||
          Date.now() - value.savedAt > 48 * 60 * 60 * 1000 ||
          !Array.isArray(value.parts) || !Array.isArray(value.urls) ||
          value.parts.length !== value.urls.length ||
          value.parts.length < 1 || value.parts.length >= this.maxPagesPerChapter(url) ||
          value.urls[0] !== url || typeof value.next !== "string") return null;
      if (!value.parts.every(p => typeof p === "string" && p.length > 20)) return null;
      for (let i=1; i<value.urls.length; i++) {
        if (!this.isChapterContinuation(value.urls[i-1], value.urls[i])) return null;
      }
      if (!this.isChapterContinuation(value.urls[value.urls.length-1], value.next)) return null;
      return value;
    } catch (_) { return null; }
  }

  async saveResume(url, parts, urls, next, preferred) {
    const key = this.resumeKey(url);
    if (!key || !parts.length || !next || !this.isChapterContinuation(urls[urls.length-1], next)) return false;
    const data = {
      version:1, start:url, savedAt:Date.now(), parts:parts.slice(),
      urls:urls.slice(), next, preferred
    };
    const raw = JSON.stringify(data);
    if (raw.length > 1000000) return false;
    this._ephemeralResume = {key, raw};
    try {
      if (typeof SharedPreferences !== "undefined") {
        await new SharedPreferences().setString(key, raw);
      }
    } catch (_) { return true; } // The in-memory copy remains usable.
    return true;
  }

  async clearResume(url) {
    const key = this.resumeKey(url);
    if (this._ephemeralResume?.key === key) this._ephemeralResume = null;
    if (!key) return;
    try {
      if (typeof SharedPreferences !== "undefined")
        await new SharedPreferences().setString(key, "");
    } catch (_) {}
  }

  async getHtmlContent(name, url) {
    await this.readCompactReaderPreference();
    const limit = this.maxPagesPerChapter(url);
    const resume = await this.readResume(url);
    let currentUrl = resume?.next || url;
    const parts = resume ? resume.parts.slice() : [];
    const pageUrls = resume ? resume.urls.slice() : [];
    const visited = new Set(pageUrls);
    // Prefer one paced WebView navigation per part over an HTTP probe plus
    // a WebView fallback for the same page. Resume records stay compatible.
    let preferred = "browser";
    const chapterPace = await this.chapterPaceRange();
    for (let page = parts.length + 1; page <= limit; page++) {
      if (visited.has(currentUrl))
        throw new Error("Linovelib：章節分頁循環，第 " + page + " 頁（" + currentUrl + "）");
      visited.add(currentUrl);
      let html = "", next = "", httpError = null, browserError = null;
      const tryHttp = async () => {
        try {
          const doc = await this.loadChapterOnce(currentUrl);
          const parsed = this.readHttpChapter(doc, currentUrl);
          next = this.checkedContinuation(currentUrl, parsed.next);
          html = parsed.html;
          preferred = "http";
        } catch (e) {
          if (/分頁不連續/.test(String(e)) || this.isRateLimitFailure(e)) throw e;
          httpError = e;
        }
      };
      const tryBrowser = async () => {
        try {
          const rendered = await this.readRenderedChapter(
            currentUrl, this.chapterPaceAfterPage(chapterPace, page));
          next = this.checkedContinuation(currentUrl, rendered.next);
          html = rendered.html;
          preferred = "browser";
        } catch (e) {
          if (/分頁不連續/.test(String(e)) || this.isRateLimitFailure(e)) throw e;
          browserError = e;
        }
      };
      try {
        if (preferred === "browser") {
          await tryBrowser();
          // Do not double-request a WebView page that failed or was blocked.
          // HTTP is an emergency fallback ONLY when the host app offers no
          // embedded WebView support at all.
          if (!html && this.isLocalWebViewBridgeFailure(browserError))
            await tryHttp();
        } else {
          await tryHttp();
          if (!html) await tryBrowser();
        }
      } catch (error) {
        if (this.isRateLimitFailure(error)) {
          const saved = await this.saveResume(url, parts, pageUrls, currentUrl, preferred);
          throw new Error("Linovelib：第 " + page + " 頁遇到限流或冷卻保護（HTTP 429）。已停止請求" +
            (saved ? "；已暫存前 " + parts.length + " 頁，下次將優先從此頁接續" : "；暫存不可用") +
            "。請等待網站解除限流，不要連續按 Retry。");
        }
        throw new Error("Linovelib：第 " + page + " 頁驗證失敗：" + String(error));
      }
      if (!html) {
        const saved = await this.saveResume(url, parts, pageUrls, currentUrl, preferred);
        throw new Error("Linovelib：第 " + page + " 頁未取得完整內容。HTTP：" +
          String(httpError || "未執行") + "；WebView：" + String(browserError || "未執行") +
          (saved ? "。先前讀取的分頁已暫存，可在問題解除後接續" : "。未返回不完整章節"));
      }
      parts.push(html);
      pageUrls.push(currentUrl);
      // Commit the verified part immediately: app termination or a later
      // 429 should not force the next run to fetch already-read pages.
      if (next) await this.saveResume(url, parts, pageUrls, next, preferred);
      if (!next) {
        await this.clearResume(url);
        return parts.join("\n<hr/>\n");
      }
      if (page === limit) {
        await this.saveResume(url, parts, pageUrls, next, preferred);
        throw new Error("Linovelib：章節已讀取 " + limit +
          " 頁，網站仍有下一頁；暫存進度，但本版安全上限仍為 " + limit + " 頁。");
      }
      currentUrl = next;
    }
    throw new Error("Linovelib：章節分頁超過安全上限，未返回截斷內容");
  }

  getFilterList() { return []; }
  getSourcePreferences() {
    return [{
      key: "linovelib_reader_compact",
      listPreference: {
        title: "小說 HTML 輕量排版",
        summary: "預設啟用：保留文字、插圖和重點標籤，精簡裝飾容器及過長的純文字段落，降低極長章節排版負擔。若字體或排版異常可關閉。",
        valueIndex: 0,
        entries: ["輕量排版（預設）", "保留原始 HTML"],
        entryValues: ["on", "off"]
      }
    }, {
      key: "linovelib_chapter_pace",
      listPreference: {
        title: "章節分頁抓取間隔（WebView）",
        summary: "預設逐頁等待；快速測試模式連讀 9 頁，再冷卻 45～60 秒，以避開觀察到的第 11 頁限流。仍不保證免於 429。",
        valueIndex: 0,
        entries: ["標準慢速：5～7 秒（預設）", "保守慢速：8～11 秒", "較快：2～4 秒", "快速測試：連續 9 頁，冷卻 45～60 秒"],
        entryValues: ["5000", "8000", "2000", "sprint9"]
      }
    }];
  }
}
