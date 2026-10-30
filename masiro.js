// Mangayomi JavaScript novel source — independently implemented for Masiro.
// v0.1.0 beta. Requires the reader's own, authorized Masiro login session.
// Does not purchase chapters, bypass login, or fabricate access tokens.
const mangayomiSources = [{
  name: "真白萌 Masiro（需登入）",
  lang: "zh",
  baseUrl: "https://masiro.me",
  apiUrl: "",
  iconUrl: "https://masiro.me/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.1.0",
  dateFormat: "",
  dateFormatLocale: "",
  isNsfw: false,
  hasCloudflare: true
}];

class DefaultExtension extends MProvider {
  getHeaders(url) {
    return {
      "Referer": "https://masiro.me/",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
      "Accept": "text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8"
    };
  }

  blank() { return { list: [], hasNextPage: false }; }
  txt(el) { return el ? String(el.text || "").trim() : ""; }
  attr(el, key) { return el ? String(el.attr(key) || "").trim() : ""; }
  first(doc, selectors) {
    for (const s of selectors) {
      const found = doc.selectFirst(s);
      if (found) return found;
    }
    return null;
  }
  absolute(value, context) {
    const s = String(value || "").trim().replace(/&amp;/g, "&");
    if (!s || /^(?:javascript:|data:|blob:|#)/i.test(s)) return "";
    if (/^https?:\/\//i.test(s)) return s.replace(/^https?:\/\/www\.masiro\.me\//i, "https://masiro.me/");
    if (s.startsWith("//")) return this.absolute("https:" + s);
    if (s.startsWith("/")) return this.source.baseUrl + s;
    const path = String(context || this.source.baseUrl + "/").split(/[?#]/)[0];
    return path.slice(0, path.lastIndexOf("/") + 1) + s;
  }
  numericId(value) {
    const s = String(value || "").trim();
    const m = s.match(/(?:^\d+$|[?&]novel_id=(\d+)|\/novelView\/(\d+))/i);
    if (/^\d+$/.test(s)) return s;
    return m ? String(m[1] || m[2] || "") : "";
  }
  bookUrl(id) { return this.source.baseUrl + "/admin/novelView?novel_id=" + encodeURIComponent(id); }
  chapterUrl(id) { return this.source.baseUrl + "/admin/novelReading?cid=" + encodeURIComponent(id); }

  isLoginPage(html) {
    const s = String(html || "");
    const hasPassword = /<input\b[^>]*type\s*=\s*["']?password/i.test(s);
    const hasSignIn = /(?:admin\/auth\/login|action\s*=\s*["'][^"']*login|<title[^>]*>[^<]*(?:登入|登录|sign\s*in|log\s*in))/i.test(s);
    return hasPassword && hasSignIn;
  }
  async request(url) {
    let response;
    try { response = await new Client().get(url, this.getHeaders(url)); }
    catch (e) { throw new Error("Masiro：連線失敗（" + String(e) + "）"); }
    const status = Number(response?.statusCode ?? response?.status ?? 200);
    const html = String(response?.body || "");
    if (status === 401 || status === 403 || status === 419 || this.isLoginPage(html)) {
      throw new Error("Masiro：需要登入或通過網站驗證。請在 Mangayomi WebView 登入 https://masiro.me/admin/auth/login 後重試（HTTP " + status + "）");
    }
    if (status === 429) throw new Error("Masiro：網站限制請求頻率，請稍後重試，避免連續大量預下載");
    if (status >= 400) throw new Error("Masiro：網站回應 HTTP " + status);
    if (!html.trim()) throw new Error("Masiro：網站沒有回傳資料");
    return html;
  }
  async getDocument(url) { return new Document(await this.request(url)); }
  async requestJson(url) {
    const text = await this.request(url);
    try { return JSON.parse(text); }
    catch (_) {
      if (/captcha|cf-challenge|challenge-platform|Just a moment|verify/i.test(text.slice(0,2500))) {
        throw new Error("Masiro：搜尋／列表需要網站驗證，請先於網站登入");
      }
      throw new Error("Masiro：列表回傳的不是 JSON，可能是登入頁或網站介面已改版");
    }
  }

  listFromResponse(json) {
    // Known site response field is `novels`; accept a nested data container
    // only if the site provides one, without guessing book URLs.
    const entries = Array.isArray(json?.novels) ? json.novels
      : Array.isArray(json?.data?.novels) ? json.data.novels
      : Array.isArray(json?.data) ? json.data
      : Array.isArray(json) ? json : [];
    const list = [], seen = new Set();
    for (const entry of entries) {
      const id = String(entry?.id ?? "").trim();
      const name = String(entry?.title ?? "").trim();
      if (!/^\d+$/.test(id) || !name || seen.has(id)) continue;
      const imageUrl = this.absolute(entry.cover_img || entry.cover || "");
      list.push({ name, link: this.bookUrl(id), imageUrl });
      seen.add(id);
    }
    return { list, rawCount: entries.length, meta: json };
  }
  hasNextPage(meta, page, size) {
    const root = meta?.data && !Array.isArray(meta.data) ? meta.data : meta;
    if (typeof root?.has_more === "boolean") return root.has_more;
    if (typeof root?.hasNextPage === "boolean") return root.hasNextPage;
    if (typeof root?.next_page_url === "string") return !!root.next_page_url;
    if (Number.isFinite(Number(root?.last_page)) && root?.last_page != null)
      return page < Number(root.last_page);
    // Guard against false positive endless pagination. This is only a
    // heuristic when the site omits pagination metadata.
    return size >= 12 && page < 100;
  }
  async loadList(page, params) {
    if (!Number.isInteger(page) || page < 1 || page > 100) return this.blank();
    const url = this.source.baseUrl + "/admin/loadMoreNovels?page=" + page + "&" + params;
    const json = await this.requestJson(url);
    const {list, rawCount, meta} = this.listFromResponse(json);
    return { list, hasNextPage: this.hasNextPage(meta, page, rawCount) };
  }
  async getPopular(page) { return this.loadList(page, "status=1&order=2"); }
  async getLatestUpdates(page) { return this.loadList(page, "order=1"); }
  async search(query, page, filters) {
    const word = String(query || "").trim();
    if (!word) return this.blank();
    const id = this.numericId(word);
    if (id) {
      if (page !== 1) return this.blank();
      return {list: [{name: "書籍 ID " + id + "（點擊開啟）", link: this.bookUrl(id), imageUrl: ""}], hasNextPage: false};
    }
    return this.loadList(page, "keyword=" + encodeURIComponent(word));
  }

  safeJsonScript(doc, scriptId) {
    const el = doc.selectFirst("script#" + scriptId);
    if (!el) return null;
    const raw = String(el.innerHtml || el.text || "").trim();
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (_) {
      try { return JSON.parse(raw.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, "&")); }
      catch (_) { throw new Error("Masiro：目錄 JSON 格式錯誤（" + scriptId + "）"); }
    }
  }
  orderedChapterName(index, volume, chapter, cost) {
    const prefix = String(index).padStart(4, "0");
    const title = String(chapter || "").trim() || "未命名章節";
    const group = String(volume || "").trim();
    const payLabel = cost > 0 ? "[付費 " + cost + "G] " : "";
    return prefix + "｜" + payLabel + (group ? group + " / " : "") + title;
  }
  chaptersFromJson(volumes, chapters) {
    if (!Array.isArray(chapters) || !chapters.length) return [];
    const volumeList = Array.isArray(volumes) ? volumes : [];
    const out = [], used = new Set();
    const add = (item, volumeName) => {
      const id = String(item?.id ?? "").trim();
      if (!/^\d+$/.test(id) || used.has(id)) return;
      used.add(id);
      const title = String(item.title || "").trim();
      const suffix = String(item.describe || "").trim();
      const name = suffix && !title.includes(suffix) ? title + " — " + suffix : title;
      const cost = Number(item.cost || 0);
      out.push({
        name: this.orderedChapterName(out.length + 1, volumeName, name, Number.isFinite(cost) ? cost : 0),
        url: this.chapterUrl(id), dateUpload: null, scanlator: null
      });
    };
    // Preserve the order of volumes AND the original order of chapters within
    // each volume; chapter IDs are not necessarily monotonically increasing.
    for (const v of volumeList) {
      const volName = String(v?.title || "").trim();
      for (const ch of chapters) if (String(ch?.parent_id ?? "") === String(v?.id ?? "")) add(ch, volName);
    }
    for (const ch of chapters) add(ch, "");
    return out;
  }
  chaptersFromDom(doc) {
    const nodes = doc.select('a[href*="/admin/novelReading?cid="], a[href*="novelReading?cid="]');
    const seen = new Set(), result = [];
    for (const a of nodes) {
      const url = this.absolute(this.attr(a, "href"));
      const m = url.match(/[?&]cid=(\d+)/);
      const id = m ? m[1] : "";
      const title = this.txt(this.first(a, [".episode-box span", "span"])) || this.txt(a);
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      result.push({name: this.orderedChapterName(result.length + 1, "", title, 0), url:this.chapterUrl(id), dateUpload:null, scanlator:null});
    }
    return result;
  }
  async getDetail(url) {
    const id = this.numericId(url);
    if (!id) throw new Error("Masiro：無效的書籍網址");
    const bookUrl = this.bookUrl(id);
    const doc = await this.getDocument(bookUrl);
    if (/小孩子不能看/.test(this.txt(this.first(doc, [".content", "body"]))) && !doc.selectFirst(".novel-title"))
      throw new Error("Masiro：帳號等級不足，無法查看這本書");
    const name = this.txt(this.first(doc, [".novel-title", "h1"]));
    if (!name) throw new Error("Masiro：未找到書籍資料，請確認已登入且帳號具有閱讀權限");
    const author = this.txt(this.first(doc, [".author a", ".author"]));
    const intro = this.first(doc, [".brief", ".novel-brief", ".intro"]);
    const description = this.txt(intro);
    const cover = this.first(doc, ["img.img-thumbnail", ".cover img", ".novel-cover img"]);
    const imageUrl = this.absolute(this.attr(cover,"data-src") || this.attr(cover,"data-original") || this.attr(cover,"src"), bookUrl);
    const genre = [];
    for (const t of doc.select(".tags a span, .tags a, .tags span")) {
      const x = this.txt(t);
      if (x && !genre.includes(x)) genre.push(x);
    }
    let chapters = this.chaptersFromJson(
      this.safeJsonScript(doc, "f-chapters-json"),
      this.safeJsonScript(doc, "chapters-json")
    );
    if (!chapters.length) chapters = this.chaptersFromDom(doc);
    if (!chapters.length) throw new Error("Masiro：目錄為空；可能需要登入、達到指定等級，或網站已更改目錄格式");
    return {name, link:bookUrl, imageUrl, description, author, artist:"", genre, status:5, chapters};
  }

  normalizeImages(html, baseUrl) {
    const self = this;
    return String(html || "").replace(/<img\b[^>]*>/gi, tag => {
      const get = key => {
        const match=tag.match(new RegExp("(?:\\s|^)"+key+"\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))","i"));
        return match ? (match[1] || match[2] || match[3] || "") : "";
      };
      const image = self.absolute(get("data-src") || get("data-original") || get("src"), baseUrl);
      if (!image) return "";
      const alt = get("alt").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
      return '<img src="'+image.replace(/&/g,"&amp;").replace(/"/g,"&quot;")+'" alt="'+alt+'" />';
    });
  }
  cleanHtml(raw, chapterUrl) {
    let html = String(raw || "");
    html = html.replace(/<(?:script|style|iframe|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|noscript)>/gi, "");
    html = html.replace(/<div\b[^>]*>\s*(?:&nbsp;|\u00a0|\s|<br\s*\/?\s*>)\s*<\/div>/gi, "<p>　</p>");
    html = this.normalizeImages(html, chapterUrl).trim();
    return html;
  }
  async getHtmlContent(name, url) {
    const m = String(url || "").match(/[?&]cid=(\d+)/);
    if (!m) throw new Error("Masiro：無效章節網址");
    const doc = await this.getDocument(this.chapterUrl(m[1]));
    const paid = this.txt(this.first(doc, [".pay", ".cost-pay", "button.pay"]));
    const cost = this.attr(this.first(doc, ["input.cost", ".cost input", "input[name=cost]"]), "value");
    const el = this.first(doc, [".box-body.nvl-content", ".nvl-content"]);
    const content = String(el?.innerHtml || "").trim();
    const paymentPrompt = /立即打钱|立即打錢|立即支付|付费后阅读|付費後閱讀/.test(paid);
    const contentPlain = content.replace(/<[^>]*>/g, "").trim();
    const placeholder = /^(?:立即打钱|立即打錢|立即支付)(?:\s*[：:]?\s*\d+\s*(?:金币|金幣))?$/.test(contentPlain);
    if (paymentPrompt || placeholder || (!content && cost && Number(cost) > 0))
      throw new Error("Masiro：這是付費章節；請先用自己的帳號在真白萌官網合法購買，然後重新整理");
    if (!el || !content) {
      const empty = this.txt(this.first(doc,[".error-box",".box-body",".content"]));
      if (/小孩子不能看|等级不足|等級不足/.test(empty)) throw new Error("Masiro：帳號閱讀等級不足");
      if (/当前章节内容为空|當前章節內容為空/.test(empty)) throw new Error("Masiro：網站回傳空章節");
      throw new Error("Masiro：找不到正文；可能需要登入、購買章節或網站已修改介面");
    }
    const html = this.cleanHtml(content, url);
    if (!html || (!/<img\b/i.test(html) && !html.replace(/<[^>]*>/g,"").replace(/&nbsp;|\s/g, "").trim()))
      throw new Error("Masiro：章節內容為空");
    return html;
  }
  getFilterList() { return []; }
  getSourcePreferences() { return []; }
}
