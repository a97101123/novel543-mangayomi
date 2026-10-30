const mangayomiSources = [{
  name: "嗶哩輕小說（繁體）",
  lang: "zh",
  baseUrl: "https://tw.linovelib.com",
  apiUrl: "",
  iconUrl: "https://tw.linovelib.com/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.2.9",
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

  async load(url) {
    const response = await new Client().get(url, this.getHeaders(url));
    if (!response || !response.body) {
      throw new Error("Linovelib：網頁沒有回傳 HTML");
    }
    return new Document(response.body);
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
    const bookUrl = this.source.baseUrl + "/novel/" + bookId + ".html";
    let firstError = null;
    try {
      const response = await new Client().get(bookUrl, this.getHeaders(bookUrl));
      const status = Number(response?.statusCode ?? response?.status ?? 200);
      if (status >= 400 || !response?.body) throw new Error("HTTP " + status);
      const doc = new Document(response.body);
      const name = this.attr(doc.selectFirst('meta[property="og:novel:book_name"]'), "content") ||
        this.txt(this.first(doc, [".book-detail-info .book-title", ".book-title", "h1"]));
      if (!name || /Just a moment|Checking your browser|安全驗證/i.test(name)) throw new Error("非書籍詳情頁");
      const imageUrl = this.absolute(this.attr(doc.selectFirst('meta[property="og:image"]'), "content"), bookUrl) ||
        this.canonicalCover(bookUrl);
      return [{ name, link: bookUrl, imageUrl }];
    } catch (error) { firstError = error; }
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
      "轉":"转", "實":"实", "歡":"欢", "來":"来", "級":"级", "輕":"轻", "說":"说",
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

  async search(query, page, filters) {
    const word = String(query ?? "").trim();
    if (!word || page < 1) return this.blank();
    const id = this.searchBookId(word);
    if (id) {
      return page > 1 ? this.blank() : { list: await this.searchByBookId(id), hasNextPage: false };
    }
    // For the first iteration, the guarded search session only guarantees a
    // single page. Returning false avoids a misleading infinite page spinner.
    if (page > 1) return this.blank();
    let httpError;
    try {
      const list = await this.searchGuarded(word);
      if (list.length) return { list, hasNextPage: false };
    } catch (error) { httpError = error; }
    // Browser-mode fallback, with the correct search host; do not reuse the
    // previous TW search route which may redirect to local 127.0.0.1:80.
    try {
      const url = "https://www.bilinovel.com/search.html?searchkey=" + encodeURIComponent(this.simplifyCommonSearchChars(word));
      const list = await this.searchViaBrowser(url, word);
      return { list, hasNextPage: false };
    } catch (error) {
      throw new Error("Linovelib v0.2.9：搜尋未完成。網站搜尋流程：" + String(httpError || "無結果") + "；背景瀏覽器：" + String(error) + "。書籍 ID 可直接搜尋，網站驗證需由使用者正常完成。");
    }
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

  // Mangayomi's novel reader requires a real <img src="...">; it does not
  // necessarily execute the website's lazy-loading JavaScript.
  normalizeImageTags(html, chapterUrl) {
    const self = this;
    return String(html || "").replace(/<img\b[^>]*>/gi, function(tag) {
      function attr(key) {
        const re = new RegExp("(?:\\s|^)" + key + "\\s*=\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)'|([^\\s>]+))", "i");
        const m = tag.match(re);
        return m ? (m[1] || m[2] || m[3] || "") : "";
      }
      let selected = "";
      for (const key of ["data-src", "data-original", "data-lazy-src", "data-echo", "data-url", "src"]) {
        const candidate = attr(key);
        if (self.meaningfulImage(candidate)) { selected = candidate; break; }
      }
      if (!selected) {
        const set = attr("data-srcset") || attr("srcset");
        selected = set ? set.split(",")[0].trim().split(/\s+/)[0] : "";
      }
      if (!self.meaningfulImage(selected)) return "";
      let finalUrl = self.absolute(selected, chapterUrl);
      // Previous Legado rules documented this host migration.
      finalUrl = finalUrl.replace(/^https?:\/\/img1\.readpai\.com\//i, "https://img3.readpai.com/");
      // Keep img markup small; no lazy attributes or placeholder srcset.
      const alt = attr("alt").replace(/&/g, "&amp;").replace(/\"/g, "&quot;").replace(/</g, "&lt;");
      return '<img src="' + finalUrl.replace(/&/g, "&amp;").replace(/\"/g, "&quot;") + '" alt="' + alt + '" />';
    });
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
    return this.normalizeImageTags(s, chapterUrl).trim();
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
    if (!match) return "";
    const next = this.absolute(match[1], currentUrl);
    const current = currentUrl.split(/[?#]/)[0];
    // Valid continuation: 263394.html -> 263394_2.html -> 263394_3.html
    const path = current.replace(/\.html$/, "").replace(/_\d+$/, "");
    if (!next.startsWith(path + "_")) return "";
    if (!/_\d+\.html(?:[?#].*)?$/.test(next)) return "";
    return next;
  }

  // Read the *first non-empty* recognized chapter container.
  // Some pages contain #acontentz but populate #acontent instead.
  readChapterBody(doc, chapterUrl) {
    const selectors = ["#acontent", "#acontentz", "#TextContent", ".chapter-content"];
    let anyContainer = false;
    for (const selector of selectors) {
      const el = doc.selectFirst(selector);
      if (!el) continue;
      anyContainer = true;
      let raw = String(el.innerHtml || "").trim();
      // Some parser versions expose only text, not innerHtml.
      if (!raw && String(el.text || "").trim()) {
        raw = "<p>" + String(el.text).replace(/&/g, "&amp;")
          .replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>";
      }
      const html = this.cleanContent(raw, chapterUrl, this.txt(doc.selectFirst("#atitle")));
      const plain = String(el.text || "").trim();
      // A loading message is not genuine chapter content.
      const failure = /內容加載失敗|内容加载失败|請重載或更換瀏覽器|本章內容正在載入|章节内容不支持该浏览器显示/i;
      if (failure.test(plain + " " + html)) continue;
      // Empty tags or ads must not prevent trying the next selector.
      const hasText = plain.length > 0 || html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "").trim().length > 0;
      const hasImage = /<img\b/i.test(html);
      if (html && (hasText || hasImage)) return html;
    }
    if (!anyContainer) {
      throw new Error("Linovelib：找不到正文容器；請檢查章節網址或在 WebView 開啟");
    }
    throw new Error("Linovelib：正文容器存在但沒有可用文字。網站可能以 JavaScript 動態載入；請先用 WebView 開啟該章");
  }

  // The source chapter HTML often contains a placeholder rather than text.
  // Open a *headless* WebView first, avoiding a normally wasted HTTP request.
  // This is NOT the manual WebView button in the app.
  async readRenderedChapter(chapterUrl) {
    if (typeof evaluateJavascriptViaWebview !== "function") {
      throw new Error("Linovelib：此 Mangayomi 版本不支援背景 WebView");
    }
    const script = String.raw`(function () {
      if (window.__linovelibCaptureV023) return;
      window.__linovelibCaptureV023 = true;
      var finished = false;
      var start = Date.now();
      var signature = "";
      var stableCount = 0;
      var timer = null;

      function report(value) {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        window.flutter_inappwebview.callHandler("setResponse", JSON.stringify(value));
      }
      function validSrc(value) {
        return !!value && !/^(?:data:|blob:|javascript:|#)/i.test(value) &&
          !/placeholder|loading|blank|no[-_]?image/i.test(value);
      }
      // Copy browser-resolved lazy image URLs into real src attributes.
      function snapshot(el) {
        var clone = el.cloneNode(true);
        var originalImgs = el.querySelectorAll("img");
        var copiedImgs = clone.querySelectorAll("img");
        for (var k = 0; k < originalImgs.length; k++) {
          var original = originalImgs[k];
          var copied = copiedImgs[k];
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
          copied.removeAttribute("srcset");
          copied.removeAttribute("loading");
        }
        return clone.innerHTML;
      }
      function poll() {
        var selectors = ["#acontent", "#acontentz", "#TextContent", ".chapter-content"];
        var best = null;
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (!el) continue;
          var plain = (el.innerText || el.textContent || "").trim();
          var html = (el.innerHTML || "").trim();
          var count = el.querySelectorAll("img").length;
          if (/內容加載失敗|内容加载失败|請重載或更換瀏覽器|本章內容正在載入|章节内容不支持该浏览器显示/i.test(plain)) continue;
          var len = plain.replace(/\s+/g, "").length;
          if (!html || (len < 80 && count === 0)) continue;
          var score = len + count * 60;
          if (!best || score > best.score) best = { el: el, score: score, len: len, count: count };
        }
        if (best) {
          var html = snapshot(best.el);
          var fresh = html.length + ":" + best.len + ":" + best.count + ":" + html.slice(-30);
          if (fresh === signature) stableCount++;
          else { signature = fresh; stableCount = 0; }
          // ~1.5s of stable content, not the old ~2.4s plus HTTP fallback.
          if (stableCount >= 3 && Date.now() - start >= 1100) {
            var next = (window.ReadParams && window.ReadParams.url_next) || "";
            report({ html: html, next: next, title: (document.querySelector("#atitle") || {}).textContent || "", error: "" });
            return;
          }
        }
        if (Date.now() - start > 19000) {
          report({ html: "", next: "", error: best ? "content_unstable" : "content_missing" });
        }
      }
      timer = setInterval(poll, 500);
      poll();
    })();`;

    let result;
    try {
      result = await evaluateJavascriptViaWebview(
        chapterUrl, this.getHeaders(chapterUrl), [script], 24
      );
    } catch (error) {
      throw new Error("Linovelib：背景載入失敗：" + String(error));
    }
    let payload;
    try { payload = JSON.parse(String(result || "")); }
    catch (_) { throw new Error("Linovelib：背景 WebView 沒有回傳有效 JSON"); }
    if (!payload || !payload.html) {
      throw new Error("Linovelib：背景載入沒有取得完整正文（" + String(payload?.error || "no_result") + "）");
    }
    const html = this.cleanContent(payload.html, chapterUrl, payload.title || "");
    if (!html) throw new Error("Linovelib：背景載入後正文仍為空");
    return {html, next: this.absolute(payload.next || "", chapterUrl)};
  }

  isChapterContinuation(currentUrl, nextUrl) {
    const current = String(currentUrl || "").split(/[?#]/)[0];
    const next = String(nextUrl || "").split(/[?#]/)[0];
    if (!current || !next) return false;
    const base = current.replace(/_\d+\.html$/, ".html").replace(/\.html$/, "");
    return next.startsWith(base + "_") && /_\d+\.html$/i.test(next);
  }

  async getHtmlContent(name, url) {
    let currentUrl = url;
    const visited = new Set();
    const parts = [];
    for (let page = 0; page < 12; page++) {
      if (visited.has(currentUrl)) throw new Error("Linovelib：偵測到重複的章節分頁");
      visited.add(currentUrl);
      let html = "";
      let next = "";
      let webviewError = null;
      try {
        const rendered = await this.readRenderedChapter(currentUrl);
        html = rendered.html;
        if (this.isChapterContinuation(currentUrl, rendered.next)) next = rendered.next;
      } catch (error) {
        webviewError = error;
      }
      // HTTP is the fallback now; for most dynamic chapters it cannot see the text.
      if (!html) {
        try {
          const doc = await this.load(currentUrl);
          html = this.readChapterBody(doc, currentUrl);
          const candidate = this.nextSubPage(doc, currentUrl);
          if (this.isChapterContinuation(currentUrl, candidate)) next = candidate;
        } catch (err) {
          throw new Error("Linovelib：背景讀取失敗（" + String(webviewError) + "）；HTTP 備援失敗（" + String(err) + "）");
        }
      }
      parts.push(html);
      if (!next) return parts.join("\n<hr/>\n");
      currentUrl = next;
    }
    throw new Error("Linovelib：章節超過 12 頁，為避免截斷請檢查分頁");
  }

  getFilterList() { return []; }
  getSourcePreferences() { return []; }
}
