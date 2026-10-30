const mangayomiSources = [{
  name: "嗶哩輕小說（繁體）",
  lang: "zh",
  baseUrl: "https://tw.linovelib.com",
  apiUrl: "",
  iconUrl: "https://tw.linovelib.com/favicon.ico",
  typeSource: "single",
  itemType: 2,
  version: "0.2.5",
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

  cleanContent(html, chapterUrl) {
    let s = String(html || "");
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
    s = s.replace(/<ins\b[^>]*>[\s\S]*?<\/ins>/gi, "");
    s = s.replace(/<a\b[^>]*>\s*(?:上一章|下一章|目錄|書頁)\s*<\/a>/gi, "");
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
            report({ html: html, next: next, error: "", diag: {
              pageImages: best.el.querySelectorAll("img").length,
              renderedMs: Date.now() - start,
              imageExamples: Array.prototype.slice.call(best.el.querySelectorAll("img"), 0, 2).map(function(img) {
                return img.getAttribute("data-src") || img.getAttribute("data-original") || img.currentSrc || img.getAttribute("src") || "";
              })
            } });
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
    const html = this.cleanContent(payload.html, chapterUrl);
    if (!html) throw new Error("Linovelib：背景載入後正文仍為空");
    return {html, next: this.absolute(payload.next || "", chapterUrl), diag: payload.diag || null};
  }

  // Experimental: use Mangayomi's existing loopback HLS streaming bridge
  // for image *bytes*. The current implementation forwards binary unchanged
  // when the proxy URL uses /key.bin rather than /playlist.m3u8.
  // This is undocumented for images and may not work with every app version.
  imageUrlBase64(value) {
    const utf8 = encodeURIComponent(String(value)).replace(/%([0-9A-F]{2})/g,
      (_, code) => String.fromCharCode(parseInt(code, 16)));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let result = "";
    for (let i = 0; i < utf8.length; i += 3) {
      const a = utf8.charCodeAt(i);
      const b = i + 1 < utf8.length ? utf8.charCodeAt(i + 1) : -1;
      const c = i + 2 < utf8.length ? utf8.charCodeAt(i + 2) : -1;
      result += alphabet[a >> 2];
      result += alphabet[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)];
      if (b >= 0) result += alphabet[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)];
      if (c >= 0) result += alphabet[c & 63];
    }
    return result;
  }

  // A proxy session's Referer is shared by all images within one chapter.
  // Create ONE session per chapter rather than expiring sessions every 16 images.
  async imageProxySession(url, referer) {
    const userAgent = "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/135.0.0.0 Mobile Safari/537.36";
    const headers = {
      "User-Agent": userAgent,
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
    };
    if (referer) headers["Referer"] = referer;
    const original = await createHlsProxyUrl(url, headers);
    const match = String(original).match(/^(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^/?]+\/)playlist\.m3u8\?/);
    if (!match) throw new Error("本機代理格式不符合預期");
    return match[1] + "key.bin?url=";
  }

  async proxyChapterImages(html) {
    let images = [];
    const re = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
    let match;
    while ((match = re.exec(html)) !== null) {
      const src = match[2].replace(/&amp;/g, "&");
      if (/^https:\/\/(?:[a-z0-9-]+\.)?readpai\.com\//i.test(src)) images.push(src);
    }
    images = [...new Set(images)];
    if (!images.length) return { html, info: "本章沒有 readpai 圖片" };
    if (typeof createHlsProxyUrl !== "function") {
      return { html, info: "本機圖片代理介面不存在；仍使用原始圖片網址（" + images.length + " 張）" };
    }

    try {
      // The reference host used by a separate public Linovelib reader's image downloader.
      const base = await this.imageProxySession(images[0], "https://www.bilinovel.com/");
      const mappings = {};
      for (const imageUrl of images) mappings[imageUrl] = base + this.imageUrlBase64(imageUrl);
      const converted = html.replace(re, (tag, quote, encoded) => {
        const raw = encoded.replace(/&amp;/g, "&");
        if (!mappings[raw]) return tag;
        return tag.replace(/\bsrc\s*=\s*(["'])(.*?)\1/i,
          'src="' + mappings[raw].replace(/&/g, "&amp;") + '"');
      });
      let testHtml = "";
      // Only one image per mode for troubleshooting Referer policies.
      try {
        const tw = await this.imageProxySession(images[0], "https://tw.linovelib.com/");
        const noRef = await this.imageProxySession(images[0], "");
        const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        testHtml = '<hr/><p><strong>Linovelib 圖片代理測試</strong></p>' +
          '<p>方案 A：bilinovel Referer（上方全文圖片已使用）</p>' +
          '<p>方案 B：linovelib Referer</p><img src="' + esc(tw + this.imageUrlBase64(images[0])) + '" />' +
          '<p>方案 C：沒有 Referer</p><img src="' + esc(noRef + this.imageUrlBase64(images[0])) + '" />';
      } catch (_) {
        testHtml = '<p>無法建立額外的 Referer 對照組。</p>';
      }
      return { html: converted + testHtml,
        info: "已用本機串流代理處理 " + images.length + " 張圖片（方案 A）。代理網址為暫時性，不適合長期離線儲存。" };
    } catch (e) {
      return { html, info: "本機代理建立失敗，保留原網址：" + String(e) };
    }
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
    const diagnostics = [];
    for (let page = 0; page < 12; page++) {
      if (visited.has(currentUrl)) throw new Error("Linovelib：偵測到重複的章節分頁");
      visited.add(currentUrl);
      let html = "";
      let next = "";
      let webviewError = null;
      try {
        const rendered = await this.readRenderedChapter(currentUrl);
        html = rendered.html;
        if (rendered.diag) diagnostics.push(rendered.diag);
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
      if (!next) {
        const combined = parts.join("\n<hr/>\n");
        const tags = (combined.match(/<img\b/gi) || []).length;
        const d = diagnostics[0] || {};
        const ms = Number(d.renderedMs) || 0;
        const pages = parts.length;
        const pageImages = Number(d.pageImages) || 0;
        const example = (d.imageExamples || []).find(x => x) || "";
        const escape = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
        const summary = "Linovelib 診斷：" + pages + " 個正文分頁；擷取到 " + tags + " 個 img 標籤；首分頁原始圖片 " + pageImages + " 張；首分頁背景讀取約 " + (ms / 1000).toFixed(1) + " 秒。";
        const sample = example ? ("<p><small>圖片網址樣本：" + escape(example) + "</small></p>") : "";
        const proxied = await this.proxyChapterImages(combined);
        return proxied.html + '<hr/><p><small>' + escape(summary) + '</small></p>' + sample +
          '<p><small>' + escape(proxied.info) + '</small></p>';
      }
      currentUrl = next;
    }
    throw new Error("Linovelib：章節超過 12 頁，為避免截斷請檢查分頁");
  }

  getFilterList() { return []; }
  getSourcePreferences() { return []; }
}
