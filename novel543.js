const mangayomiSources = [{
  name: "稷下書院 Novel543",
  lang: "zh",
  baseUrl: "https://www.novel543.com",
  apiUrl: "",
  iconUrl: "https://www.novel543.com/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.3.0",
  dateFormat: "",
  dateFormatLocale: "",
  isNsfw: false,
  hasCloudflare: true
}];

class DefaultExtension extends MProvider {
  getHeaders(url) {
    return { "Referer": "https://www.novel543.com/" };
  }
  async load(url) {
    const response = await new Client().get(url);
    return new Document(response.body);
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
  cleanHtml(html) {
    let result = String(html || "");
    result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    result = result.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
    result = result.replace(/溫馨提示[：:][\s\S]*$/i, "");
    result = result.replace(/<a\b[^>]*>\s*(上一章|下一章|目錄|回到頂部)\s*<\/a>/gi, "");
    return result.trim();
  }
  getPageInfo(doc) {
    const titleEl = this.first(doc, ["h1", ".chapter-title", "title"]);
    const title = titleEl?.text || "";
    const match = title.match(/[（(]\s*(\d+)\s*\/\s*(\d+)\s*[)）]/);
    return match ? {current: Number(match[1]), total: Number(match[2])} : {current:1,total:1};
  }
  getContent(doc) {
    const content = this.first(doc, [".chapter-content", ".content", "#chapter-content", "#content", ".read-content"]);
    if (!content) throw new Error("Novel543：找不到正文元素");
    const html = this.cleanHtml(content.innerHtml || "");
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
    let html = this.getContent(doc);
    if (pageInfo.total <= 1) return html;
    if (pageInfo.total > 10) throw new Error("Novel543：章節分頁數量異常");
    if (pageInfo.current !== 1) return html;
    for (let page = 2; page <= pageInfo.total; page++) {
      const nextUrl = this.getSubPageUrl(url, page);
      if (!nextUrl) throw new Error("Novel543：無法建立分頁網址");
      const nextDoc = await this.load(nextUrl);
      const nextInfo = this.getPageInfo(nextDoc);
      if (nextInfo.current !== page || nextInfo.total !== pageInfo.total) throw new Error("Novel543：分頁內容不符合預期");
      html += "<hr/>" + this.getContent(nextDoc);
    }
    return html;
  }
  getFilterList() { return []; }
  getSourcePreferences() { return []; }
}
