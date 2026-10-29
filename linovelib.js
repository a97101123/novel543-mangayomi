const mangayomiSources = [{
  name: "嗶哩輕小說（繁體）",
  lang: "zh",
  baseUrl: "https://tw.linovelib.com",
  apiUrl: "",
  iconUrl: "https://tw.linovelib.com/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.2.1",
  dateFormat: "",
  dateFormatLocale: "",
  isNsfw: false,
  hasCloudflare: true
}];

class DefaultExtension extends MProvider {
  getHeaders(url) {
    return { "Referer": "https://tw.linovelib.com/" };
  }

  async load(url) {
    const response = await new Client().get(url);
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
      const cover = this.first(card, ["img[data-original]", "img[data-src]", "img"]);
      const imageUrl = this.absolute(
        this.attr(cover, "data-original") || this.attr(cover, "data-src") || this.attr(cover, "src"),
        pageUrl
      );
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

  async search(query, page, filters) {
    const word = String(query || "").trim();
    if (!word) return this.blank();
    const keyword = encodeURIComponent(word);
    const url = page <= 1
      ? this.source.baseUrl + "/search.html?searchkey=" + keyword + "&searchtype=all"
      : this.source.baseUrl + "/search/" + keyword + "_" + page + ".html";
    const doc = await this.load(url);
    const list = this.listFromPage(doc, url, true);
    return { list, hasNextPage: list.length >= 20 };
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
    const chapters = [];
    const seen = new Set();
    // Some entries are volume headings without valid chapter URLs.
    for (const a of catalog.select("a[href]")) {
      const href = this.absolute(this.attr(a, "href"), catalogUrl);
      const pat = new RegExp("/novel/" + id + "/[0-9]+(?:_[0-9]+)?\\.html(?:[?#].*)?$");
      if (!pat.test(href) || seen.has(href)) continue;
      const chapterName = this.txt(a);
      if (!chapterName) continue;
      seen.add(href);
      chapters.push({ name: chapterName, url: href, dateUpload: null, scanlator: null });
    }
    if (!chapters.length) throw new Error("Linovelib：無法取得完整目錄（可能需要登入或網站結構已改變）");
    // Site catalogs normally list reading order; do not invent missing chapter numbers.
    return {
      name, link: bookUrl, author, artist: "", imageUrl, description,
      genre: genres, status: 5, chapters
    };
  }

  cleanContent(html, chapterUrl) {
    let s = String(html || "");
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
    s = s.replace(/<ins\b[^>]*>[\s\S]*?<\/ins>/gi, "");
    s = s.replace(/<a\b[^>]*>\s*(?:上一章|下一章|目錄|書頁)\s*<\/a>/gi, "");
    // Keep illustrations if exposed in the chapter HTML.
    s = s.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (all, pre, src, end) =>
      pre + this.absolute(src, chapterUrl) + end
    );
    return s.trim();
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
      const html = this.cleanContent(raw, chapterUrl);
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

  async getHtmlContent(name, url) {
    let currentUrl = url;
    const visited = new Set();
    const parts = [];
    for (let page = 0; page < 12; page++) {
      if (visited.has(currentUrl)) throw new Error("Linovelib：偵測到重複的章節分頁");
      visited.add(currentUrl);
      const doc = await this.load(currentUrl);
      parts.push(this.readChapterBody(doc, currentUrl));
      const next = this.nextSubPage(doc, currentUrl);
      if (!next) return parts.join("\n<hr/>\n");
      currentUrl = next;
    }
    throw new Error("Linovelib：章節超過 12 頁，為避免截斷請檢查分頁");
  }

  getFilterList() { return []; }
  getSourcePreferences() { return []; }
}
