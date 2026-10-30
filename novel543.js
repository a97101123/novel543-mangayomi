const mangayomiSources = [{
  name: "稷下書院 Novel543",
  lang: "zh",
  baseUrl: "https://www.novel543.com",
  apiUrl: "",
  iconUrl: "https://www.novel543.com/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.3.2",
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
      const code = Number(response?.statusCode || response?.status || 200);
      if (response?.body && !this.isVerificationPage(response.body, code)) {
        return new Document(response.body);
      }
    } catch (err) {
      failure = err;
    }
    // A single fallback only. Opening the page in a real browser still may
    // require user interaction; no synthetic challenge tokens are generated.
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
  getPageInfo(doc) {
    const titleEl = this.first(doc, ["h1", ".chapter-title", "title"]);
    const title = titleEl?.text || "";
    const match = title.match(/[（(]\s*(\d+)\s*\/\s*(\d+)\s*[)）]/);
    return match ? {current: Number(match[1]), total: Number(match[2])} : {current:1,total:1};
  }
  getContent(doc, pageUrl) {
    const content = this.first(doc, [".chapter-content", ".content", "#chapter-content", "#content", ".read-content"]);
    if (!content) throw new Error("Novel543：找不到正文元素");
    const html = this.cleanHtml(content.innerHtml || "", pageUrl);
    if (!html) throw new Error("Novel543：正文為空");
    return html;
  }
  getSubPageUrl(url, page) {
    const clean = url.split("?")[0];
    const match = clean.match(/^(.*\/\d+_[^/]+?)(?:_(\d+))?\.html$/);
    return match ? match[1] + "_" + page + ".html" : "";
  }
  async getHtmlContent(name, url) {
    const doc = await this.load(url);
    const pageInfo = this.getPageInfo(doc);
    let html = this.getContent(doc, url);
    if (pageInfo.total <= 1) return html;
    if (pageInfo.total > 10) throw new Error("Novel543：章節分頁數量異常");
    if (pageInfo.current !== 1) return html;
    for (let page = 2; page <= pageInfo.total; page++) {
      const nextUrl = this.getSubPageUrl(url, page);
      if (!nextUrl) throw new Error("Novel543：無法建立分頁網址");
      const nextDoc = await this.load(nextUrl);
      const nextInfo = this.getPageInfo(nextDoc);
      if (nextInfo.current !== page || nextInfo.total !== pageInfo.total) throw new Error("Novel543：分頁內容不符合預期");
      html += "<hr/>" + this.getContent(nextDoc, nextUrl);
    }
    return html;
  }
  getFilterList() { return []; }
  getSourcePreferences() { return []; }
}
