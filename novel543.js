const mangayomiSources = [{
  name: "稷下書院 Novel543",
  lang: "zh",
  baseUrl: "https://www.novel543.com",
  apiUrl: "",
  iconUrl: "https://www.novel543.com/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.3.4",
  dateFormat: "",
  dateFormatLocale: "",
  isNsfw: false,
  hasCloudflare: true
}];

class DefaultExtension extends MProvider {
  getHeaders(url) {
    return {
      "Referer": "https://www.novel543.com/",
      "User-Agent": "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7"
    };
  }

  // A verification page must never be mistaken for the book list or chapter.
  isVerificationPage(html, statusCode) {
    const s = String(html || "");
    if (/cf-challenge|challenge-platform|cf-turnstile|_cf_chl|cdn-cgi\/challenge-platform/i.test(s)) return true;
    if (/<title[^>]*>[^<]*(?:Just a moment|Checking your browser|Attention Required|請稍候|安全驗證)[^<]*<\/title>/i.test(s)) return true;
    return [403, 429, 503].includes(Number(statusCode));
  }

  async loadViaBrowser(url) {
    if (typeof evaluateJavascriptViaWebview !== "function") {
      throw new Error("Novel543：目前的 Mangayomi 不支援背景瀏覽器；請先在一般瀏覽器完成網站驗證");
    }
    // Ordinary browser navigation; never solve, forge, or skip a verification challenge.
    const script = String.raw`(function(){
      if (window.__novel543Read) return;
      window.__novel543Read = true;
      var done = false, started = Date.now(), interval;
      function send(value) {
        if (done) return;
        done = true;
        if (interval) clearInterval(interval);
        window.flutter_inappwebview.callHandler("setResponse", JSON.stringify(value));
      }
      function poll() {
        var body = document.body;
        if (body) {
          var title = String(document.title || "");
          var markup = document.documentElement.outerHTML || "";
          var guarded = /Just a moment|Checking your browser|Attention Required|安全驗證|請稍候/i.test(title) ||
            /cf-challenge|challenge-platform|cf-turnstile|_cf_chl/i.test(markup);
          if (!guarded && document.querySelector(".media, #detail, .chaplist, .chapter-content, #chapter-content, .read-content, .content")) {
            send({html: markup, error: ""});
            return;
          }
        }
        if (Date.now() - started > 14500) send({html: "", error: "verification_or_page_timeout"});
      }
      interval = setInterval(poll, 500);
      poll();
    })();`;
    let result;
    try {
      result = await evaluateJavascriptViaWebview(url, this.getHeaders(url), [script], 18);
    } catch (err) {
      throw new Error("Novel543：背景瀏覽器載入失敗：" + String(err));
    }
    let data;
    try { data = JSON.parse(String(result || "")); }
    catch (_) { throw new Error("Novel543：背景瀏覽器沒有取得有效網頁；可能需要手動完成驗證"); }
    if (!data || !data.html || this.isVerificationPage(data.html, 200)) {
      throw new Error("Novel543：網站需要互動驗證，背景瀏覽器無法自動完成；請稍後重試，或使用支援手動 WebView 驗證的版本（Chrome 的驗證狀態未必與 Mangayomi 共用）");
    }
    return new Document(data.html);
  }

  async load(url) {
    let response, failure;
    try {
      response = await new Client().get(url, this.getHeaders(url));
    } catch (err) { failure = err; }
    if (response) {
      const code = Number(response?.statusCode ?? response?.status ?? 200);
      if (code === 429) throw new Error("Novel543：網站限制請求頻率（HTTP 429），請稍後重試");
      if (code === 404 || code === 410)
        throw new Error("Novel543：分頁不存在（HTTP " + code + "）：" + url);
      if (code >= 400 && !this.isVerificationPage(response.body, code))
        throw new Error("Novel543：網站回應 HTTP " + code + "：" + url);
      if (response.body && !this.isVerificationPage(response.body, code))
        return new Document(response.body);
    }
    // Only one browser fallback for access verification; not 404 or 429.
    try { return await this.loadViaBrowser(url); }
    catch (err) {
      const cause = failure ? "；原始網路錯誤：" + String(failure) : "";
      throw new Error(String(err) + cause);
    }
  }
  absolute(url) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("//")) return "https:" + url;
    const base = this.source.baseUrl;
    if (url.startsWith("/")) return base + url;
    return base + "/" + url;
  }
  first(doc, selectors) {
    for (const selector of selectors) {
      const element = doc.selectFirst(selector);
      if (element) return element;
    }
    return null;
  }
  emptyList() {
    return { list: [], hasNextPage: false };
  }
  bookListFromPage(doc) {
    const list = [];
    const seen = new Set();
    const elements = doc.select(".media");
    for (const el of elements) {
      const titleEl = el.selectFirst("h3");
      const anchor = el.selectFirst("h3 a");
      if (!anchor) continue;
      const name = (titleEl?.text || anchor.text || "").trim();
      const link = this.absolute(anchor.attr("href") || anchor.getHref || "");
      if (!name || !link || seen.has(link)) continue;
      const img = el.selectFirst("img");
      const imageUrl = this.absolute(img?.attr("data-src") || img?.attr("src") || "");
      seen.add(link);
      list.push({ name, link, imageUrl });
    }
    if (list.length === 0) {
      for (const a of doc.select("a[href]")) {
        const href = a.attr("href") || "";
        const path = href.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
        if (!/^\/\d+\/?$/.test(path)) continue;
        const name = (a.text || "").trim();
        const link = this.absolute(href);
        if (!name || seen.has(link)) continue;
        const img = a.selectFirst("img");
        seen.add(link);
        list.push({ name, link, imageUrl: this.absolute(img?.attr("data-src") || img?.attr("src") || "") });
      }
    }
    return { list, hasNextPage: false };
  }
  async getPopular(page) {
    if (page > 1) return this.emptyList();
    const doc = await this.load(this.source.baseUrl + "/");
    return this.bookListFromPage(doc);
  }
  async getLatestUpdates(page) {
    return this.getPopular(page);
  }
  async search(query, page, filters) {
    if (page > 1) return this.emptyList();
    const url = this.source.baseUrl + "/search/" + encodeURIComponent(query);
    const doc = await this.load(url);
    return this.bookListFromPage(doc);
  }
  chapterNumber(name) {
    const txt = String(name || "");
    const match = txt.match(/(?:第\s*|VIP卷\s*)(\d+)/);
    if (match) return Number(match[1]);
    const simple = txt.match(/^(\d+)\s+/);
    if (simple) return Number(simple[1]);
    return null;
  }
  isExtraPage(url) {
    return /\/\d+\/[^/]+_\d+_([2-9]|[1-9]\d+)\.html(?:$|\?)/.test(url);
  }
  normalizeChapters(chapters) {
    const indexed = chapters.map((chapter, index) => ({chapter, index, number: this.chapterNumber(chapter.name)}));
    const numbered = indexed.filter(x => x.number !== null);
    if (numbered.length < 2 || numbered.length < chapters.length * 0.9) return chapters;
    const descending = numbered[0].number > numbered[numbered.length - 1].number;
    if (numbered.length !== chapters.length) return chapters;
    indexed.sort((a,b) => a.number === b.number ? a.index - b.index : (descending ? b.number - a.number : a.number - b.number));
    return indexed.map(x => x.chapter);
  }
  async getDetail(url) {
    const doc = await this.load(url);
    const titleEl = this.first(doc, ["#detail .title", "h1"]);
    const name = titleEl?.text.trim() || "";
    const authorEl = this.first(doc, ["#detail .author", ".author"]);
    const author = authorEl?.text.trim() || "";
    const cover = this.first(doc, ["#detail .cover img", ".cover img"]);
    const imageUrl = this.absolute(cover?.attr("data-src") || cover?.attr("src") || "");
    const intro = this.first(doc, ["#detail .intro", ".intro"]);
    const description = intro?.text.trim() || "";
    const genre = [];
    for (const el of doc.select("#detail .meta a")) {
      const text = el.text.trim();
      if (text && !genre.includes(text)) genre.push(text);
    }
    const bookUrl = url.replace(/\/$/, "");
    const dirDoc = await this.load(bookUrl + "/dir");
    let elements = dirDoc.select(".chaplist ul a[href]");
    if (elements.length === 0) elements = dirDoc.select("a[href$='.html']");
    const chapters = [];
    const seen = new Set();
    for (const el of elements) {
      const chapterName = (el.text || "").trim();
      const chapterUrl = this.absolute(el.attr("href") || el.getHref || "");
      if (!chapterName || !chapterUrl) continue;
      if (!/\/\d+\/[^/]+\.html(?:$|\?)/.test(chapterUrl)) continue;
      if (this.isExtraPage(chapterUrl) || seen.has(chapterUrl)) continue;
      seen.add(chapterUrl);
      chapters.push({ name: chapterName, url: chapterUrl, dateUpload: null, scanlator: null });
    }
    if (chapters.length === 0) throw new Error("Novel543：找不到章節目錄");
    return { name, link: url, imageUrl, description, author, artist: "", genre, status: 5, chapters: this.normalizeChapters(chapters) };
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

  cleanHtml(html, pageUrl) {
    let result = String(html || "");
    result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    result = result.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
    // Only remove standalone site notices; never discard everything after
    // a warning phrase, since the following paragraphs can contain images.
    result = result.replace(/<(p|div|small)\b[^>]*>\s*溫馨提示[：:][\s\S]{0,160}?<\/\1>/gi, "");
    result = result.replace(/<a\b[^>]*>\s*(上一章|下一章|目錄|回到頂部)\s*<\/a>/gi, "");
    return this.preserveReaderImages(result, pageUrl).trim();
  }
  // Prefer the primary H1 when more than one page counter is rendered.
  // Several Novel543 templates keep an out-of-date "(1/2)" label in a
  // secondary heading even when the actual requested subpage differs.
  getPageInfo(doc) {
    let fallback = null;
    for (const selector of ["h1", ".chapter-title", ".read-title", ".chapter_title", "title"]) {
      for (const el of doc.select(selector)) {
        const heading = String(el?.text || "").trim();
        const pattern = /[（(]\s*(\d+)\s*[/／]\s*(\d+)\s*[)）]/g;
        let match, last = null;
        while ((match = pattern.exec(heading)) !== null) last = match;
        if (!last) continue;
        const current = Number(last[1]), total = Number(last[2]);
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 1 || total < current) continue;
        const titleKey = heading.replace(/[（(]\s*\d+\s*[/／]\s*\d+\s*[)）]/g, "")
          .replace(/\s+/g, "").trim().toLowerCase();
        const candidate = {current, total, titleKey, explicit:true, source:selector};
        if (selector === "h1") return candidate;
        if (!fallback) fallback = candidate;
      }
    }
    return fallback || {current:null, total:null, titleKey:"", explicit:false, source:""};
  }

  getContent(doc, pageUrl) {
    const content = this.first(doc, [".chapter-content", "#chapter-content", "#content", ".read-content", ".content"]);
    if (!content) throw new Error("Novel543：找不到正文元素：" + pageUrl);
    const html = this.cleanHtml(content.innerHtml || "", pageUrl);
    if (!html || (!/<img\b/i.test(html) &&
        !html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "").trim()))
      throw new Error("Novel543：分頁正文為空：" + pageUrl);
    return html;
  }

  getSubPageUrl(url, page) {
    const clean = String(url || "").split(/[?#]/)[0];
    // Standard: /BOOK_ID/8096_CHAPTER_ID.html and ..._2.html.
    const match = clean.match(/^(https?:\/\/[^/]+\/\d+\/\d+_\d+)(?:_(\d+))?\.html$/i);
    return match && page >= 2 ? match[1] + "_" + page + ".html" : "";
  }

  pageSignature(html) {
    // Hash the entire normalised text, rather than the first 1600 characters:
    // adjacent chapter pages may intentionally share an introductory paragraph.
    const plain = String(html || "").replace(/<[^>]+>/g, "")
      .replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, "").trim();
    let hash = 2166136261;
    for (let i = 0; i < plain.length; i++) {
      hash ^= plain.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return plain.length + ":" + (hash >>> 0).toString(16);
  }

  // The requested URL and unique chapter text are more reliable than a stale
  // secondary counter. Accept ONLY a 1/total label on requested page two,
  // with a matching chapter heading and content distinct from page one.
  // Never accept a different chapter title, an empty page, or repeated text.
  canAcceptStaleSecondPage(firstInfo, secondInfo, page, total, url, html, signatures) {
    if (page !== 2 || !firstInfo.explicit || !secondInfo.explicit) return false;
    if (firstInfo.current !== 1 || secondInfo.current !== 1) return false;
    if (secondInfo.total !== total || firstInfo.total !== total) return false;
    if (!firstInfo.titleKey || !secondInfo.titleKey || firstInfo.titleKey !== secondInfo.titleKey) return false;
    if (!/_2\.html(?:[?#].*)?$/i.test(String(url || ""))) return false;
    if (html.replace(/<[^>]*>/g, "").replace(/\s+/g, "").trim().length < 100) return false;
    return !signatures.has(this.pageSignature(html));
  }

  async getHtmlContent(name, url) {
    const firstDoc = await this.load(url);
    const info = this.getPageInfo(firstDoc);
    const firstPage = this.getContent(firstDoc, url);
    if (!info.explicit || info.total <= 1) return firstPage;
    if (info.current !== 1)
      throw new Error("Novel543：目錄入口不是章節第一頁，請重新整理目錄：" + url);

    const MAX_PAGES = 64;
    let total = info.total;
    if (total > MAX_PAGES)
      throw new Error("Novel543：網站顯示 " + total + " 頁，超出 " + MAX_PAGES + " 頁安全上限");
    const parts = [firstPage];
    const signatures = new Set([this.pageSignature(firstPage)]);

    for (let page = 2; page <= total; page++) {
      const nextUrl = this.getSubPageUrl(url, page);
      if (!nextUrl)
        throw new Error("Novel543：無法組成第 " + page + " 頁網址，請回報章節網址");
      let nextDoc;
      try { nextDoc = await this.load(nextUrl); }
      catch (error) {
        throw new Error("Novel543：第 " + page + "/" + total + " 頁讀取失敗（" +
          String(error) + "）。為避免漏頁，不回傳不完整正文");
      }

      const pageInfo = this.getPageInfo(nextDoc);
      const html = this.getContent(nextDoc, nextUrl);
      const signature = this.pageSignature(html);
      if (signature && signatures.has(signature))
        throw new Error("Novel543：第 " + page + " 頁和先前內容重複，網站可能回傳了第一頁或錯誤分頁");
      if (pageInfo.explicit && pageInfo.current !== page &&
          !this.canAcceptStaleSecondPage(info, pageInfo, page, total, nextUrl, html, signatures))
        throw new Error("Novel543：第 " + page + " 頁的標記實際是 " +
          pageInfo.current + "/" + pageInfo.total + "，且無法驗證為正確分頁；已停止避免混入錯誤內容");
      if (pageInfo.explicit && info.titleKey && pageInfo.titleKey &&
          info.titleKey !== pageInfo.titleKey)
        throw new Error("Novel543：第 " + page + " 頁標題與第一頁不同，已停止避免混入其他章節");
      if (signature) signatures.add(signature);
      parts.push(html);

      // An updated page can reveal additional parts. Never silently
      // truncate a previously advertised part when the count changes.
      if (pageInfo.explicit && pageInfo.total > total) {
        total = pageInfo.total;
        if (total > MAX_PAGES)
          throw new Error("Novel543：分頁數已增加至 " + total + "，超出安全上限");
      }
    }
    return parts.join("\n<hr/>\n");
  }
  getFilterList() { return []; }
  getSourcePreferences() { return []; }
}
