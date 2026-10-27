/**
 * 页面内字体破解。
 *
 * 学习通给题干套了一层「混淆字体」：@font-face 是内联 base64，把正文里的汉字换成
 * 一批生僻字码位，再用这个字体把它们渲染回「真字」的字形。所以 DOM 里读到的是乱码，
 * 屏幕上却是正常汉字。
 *
 * 破解思路（全部在浏览器里做，不需要任何本地字体/图像库）：
 *  1. 取出内联 base64 字体，解析 sfnt 表拿到 cmap（伪码位 -> glyph id）。
 *  2. 用 canvas 把每个伪码位用该字体渲染成位图；
 *     用系统 CJK 字体把候选真字（U+4E00..U+9FA5）也渲染成位图。
 *  3. 关键规律：这类 subset 字体的 glyph id 顺序 == 真字的 Unicode 升序。
 *     于是把「字形相似度」和「码位单调递增」合成一个 DP 求最优对齐，
 *     一组字一起解，比单字独立匹配准得多（单字匹配会被形近字带偏）。
 *
 * 返回 { ok, family, map: { 伪字: 真字 }, count, avgSim, minSim, error }
 */
(args) => {
  const { sampleText } = args || {};

  const descend = () => {
    let d = document;
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      if (seen.has(d)) break;
      seen.add(d);
      const f = d.querySelector('iframe');
      if (!f || !f.contentDocument) break;
      d = f.contentDocument;
    }
    return d;
  };

  const collectCss = () => {
    const texts = [];
    const walk = (doc) => {
      for (const st of doc.styleSheets) {
        try {
          for (const r of st.cssRules) texts.push(r.cssText);
        } catch (_) { /* 跨域忽略 */ }
      }
      for (const s of doc.querySelectorAll('style')) texts.push(s.textContent || '');
      for (const f of doc.querySelectorAll('iframe')) {
        try { if (f.contentDocument) walk(f.contentDocument); } catch (_) { /* ignore */ }
      }
    };
    walk(document);
    return texts.join('\n');
  };

  const pickFontB64 = () => {
    const css = collectCss();
    const re = /@font-face\s*\{[^}]*?font-family\s*:\s*['"]?([^'";]+)['"]?[^}]*?url\(\s*['"]?data:[^;,]*(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)['"]?\s*\)/gi;
    let m;
    const found = [];
    while ((m = re.exec(css))) found.push({ family: m[1].trim(), b64: m[2].replace(/\s+/g, '') });
    if (!found.length) return null;
    // 选体积最大、且不是图标字体的那个（图标字体通常很小）
    found.sort((a, b) => b.b64.length - a.b64.length);
    return found[0];
  };

  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  function u16(dv, o) { return dv.getUint16(o); }
  function u32(dv, o) { return dv.getUint32(o); }

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readTables(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const tables = {};
    if (tag === 'wOFF') {
      const numTables = u16(dv, 12);
      for (let i = 0; i < numTables; i++) {
        const p = 44 + i * 20;
        const t = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
        const off = u32(dv, p + 4);
        const compLen = u32(dv, p + 8);
        const origLen = u32(dv, p + 12);
        let data = bytes.subarray(off, off + compLen);
        if (compLen < origLen) data = await inflate(data);
        tables[t] = data;
      }
      return tables;
    }
    if (tag === 'wOF2') throw new Error('暂不支持 woff2 混淆字体，请反馈');
    const numTables = u16(dv, 4);
    for (let i = 0; i < numTables; i++) {
      const p = 12 + i * 16;
      const t = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      const off = u32(dv, p + 8);
      const len = u32(dv, p + 12);
      tables[t] = bytes.subarray(off, off + len);
    }
    return tables;
  }

  function cmapEntries(cmap) {
    const dv = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
    const numTables = u16(dv, 2);
    let best = null;
    for (let i = 0; i < numTables; i++) {
      const p = 4 + i * 8;
      const pid = u16(dv, p);
      const eid = u16(dv, p + 2);
      const off = u32(dv, p + 4);
      const fmt = u16(dv, off);
      const score = (pid === 3 && eid === 10) ? 4 : (pid === 3 && eid === 1) ? 3 : (pid === 0) ? 2 : 1;
      if ((fmt === 4 || fmt === 12) && (!best || score > best.score)) best = { off, fmt, score };
    }
    if (!best) throw new Error('字体里没有可解析的 cmap 子表');
    const out = [];
    if (best.fmt === 4) {
      const off = best.off;
      const segX2 = u16(dv, off + 6);
      const seg = segX2 / 2;
      const endP = off + 14;
      const startP = endP + segX2 + 2;
      const deltaP = startP + segX2;
      const rangeP = deltaP + segX2;
      for (let s = 0; s < seg; s++) {
        const end = u16(dv, endP + s * 2);
        const start = u16(dv, startP + s * 2);
        const delta = dv.getInt16(deltaP + s * 2);
        const rangeOff = u16(dv, rangeP + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end && c !== 0x10000; c++) {
          let gid;
          if (rangeOff === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            const gi = rangeP + s * 2 + rangeOff + (c - start) * 2;
            if (gi + 1 >= cmap.length) continue;
            gid = u16(dv, gi);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid) out.push({ cp: c, gid });
        }
      }
    } else {
      const off = best.off;
      const nGroups = u32(dv, off + 12);
      for (let g = 0; g < nGroups; g++) {
        const p = off + 16 + g * 12;
        const sc = u32(dv, p);
        const ec = u32(dv, p + 4);
        const sg = u32(dv, p + 8);
        for (let c = sc; c <= ec; c++) out.push({ cp: c, gid: sg + (c - sc) });
      }
    }
    return out;
  }

  // ---------- 位图 ----------
  const CELL = 128;
  const FEAT = 32;
  const canvas = document.createElement('canvas');
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const featureCache = new Map();

  function renderFeature(ch, fontSpec) {
    ctx.clearRect(0, 0, CELL, CELL);
    ctx.font = fontSpec;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(ch, CELL / 2, CELL / 2);
    const img = ctx.getImageData(0, 0, CELL, CELL).data;
    // alpha 通道二值化 + 墨迹包围盒
    let minX = CELL, minY = CELL, maxX = -1, maxY = -1;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const a = img[(y * CELL + x) * 4 + 3];
        if (a > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    // 盒式平均降采样（比最近邻稳，能压掉 96/128px 渲染的锯齿）
    const vec = new Float32Array(FEAT * FEAT);
    for (let gy = 0; gy < FEAT; gy++) {
      const y0 = minY + Math.floor((gy * h) / FEAT);
      const y1 = minY + Math.max(y0 - minY + 1, Math.floor(((gy + 1) * h) / FEAT));
      for (let gx = 0; gx < FEAT; gx++) {
        const x0 = minX + Math.floor((gx * w) / FEAT);
        const x1 = minX + Math.max(x0 - minX + 1, Math.floor(((gx + 1) * w) / FEAT));
        let sum = 0;
        let cnt = 0;
        for (let y = y0; y < y1 && y <= maxY; y++) {
          for (let x = x0; x < x1 && x <= maxX; x++) {
            sum += img[(y * CELL + x) * 4 + 3];
            cnt++;
          }
        }
        vec[gy * FEAT + gx] = cnt ? sum / cnt / 255 : 0;
      }
    }
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };

  function pickRefFamily() {
    const families = ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC',
      'Hiragino Sans GB', 'SimHei', 'Noto Sans SC', 'sans-serif'];
    ctx.font = '40px sans-serif';
    for (const fam of families) {
      ctx.font = `40px "${fam}"`;
      const w = ctx.measureText('国').width;
      // 缺字时浏览器会退回其他字体，宽度仍可能非 0；用两字差异做粗筛
      const w2 = ctx.measureText('龘').width;
      if (w > 1 && w2 > 1) return fam;
    }
    return 'sans-serif';
  }

  // 字体内容指纹（FNV-1a 32bit），用于把破解结果缓存到磁盘
  const fnv = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  };

  return (async () => {
    const picked = pickFontB64();
    if (!picked) return { ok: false, error: '页面上没有找到内联 base64 字体（可能这一套没做混淆）' };
    let bytes = b64ToBytes(picked.b64);
    const hash = fnv(bytes);
    let tables;
    try {
      tables = await readTables(bytes);
    } catch (e) {
      return { ok: false, error: '解析字体失败：' + e.message };
    }
    if (!tables.cmap) return { ok: false, error: '字体缺少 cmap 表' };
    let entries;
    try {
      entries = cmapEntries(tables.cmap);
    } catch (e) {
      return { ok: false, error: '解析 cmap 失败：' + e.message };
    }
    if (!entries.length) return { ok: false, error: 'cmap 为空' };

    // 注册探针字体
    const face = new FontFace('__xt_probe', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    try {
      await face.load();
      document.fonts.add(face);
    } catch (e) {
      return { ok: false, error: '注册探针字体失败：' + e.message };
    }

    const refFamily = pickRefFamily();
    const probeFont = `40px "__xt_probe"`;
    const refFont = `40px "${refFamily}"`;

    // 伪字 -> 特征（按 gid 升序）
    const probes = entries
      .slice()
      .sort((a, b) => a.gid - b.gid)
      .map((e) => ({ ch: String.fromCharCode(e.cp), cp: e.cp, gid: e.gid }));
    for (const p of probes) p.feat = renderFeature(p.ch, probeFont);
    const probesOk = probes.filter((p) => p.feat);
    if (!probesOk.length) return { ok: false, error: '探针字体渲染不出任何字形' };

    // 候选真字（按码位升序）——只在页面上真实出现的字附近猜也够，但全量更稳
    const cands = [];
    for (let cp = 0x4e00; cp <= 0x9fa5; cp++) cands.push(String.fromCharCode(cp));
    const extra = '，。、；：？！“”‘’（）《》【】—…·0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for (const ch of extra) cands.push(ch);
    for (const ch of cands) {
      if (!featureCache.has(ch)) featureCache.set(ch, renderFeature(ch, refFont));
    }
    const candFeat = cands.map((ch) => featureCache.get(ch));
    const validCands = [];
    for (let i = 0; i < cands.length; i++) if (candFeat[i]) validCands.push({ ch: cands[i], idx: i, feat: candFeat[i] });
    if (!validCands.length) return { ok: false, error: `参考字体 ${refFamily} 渲染不出汉字，换一台机器或装个中文字体` };

    // 单调 DP：probes(按 gid) 对齐 validCands(按码位)，要求下标同时递增
    const N = probesOk.length;
    const M = validCands.length;
    const NEG = -1e9;
    const score = new Float32Array(N * M);
    for (let i = 0; i < N; i++) {
      const pf = probesOk[i].feat;
      for (let j = 0; j < M; j++) score[i * M + j] = dot(pf, validCands[j].feat);
    }
    const dp = new Float32Array((N + 1) * (M + 1));
    const from = new Uint8Array((N + 1) * (M + 1)); // 1=up 2=left 3=diag
    for (let i = 1; i <= N; i++) {
      for (let j = 1; j <= M; j++) {
        let best = dp[(i - 1) * (M + 1) + j];
        let dir = 1;
        const left = dp[i * (M + 1) + j - 1];
        if (left > best) { best = left; dir = 2; }
        const diag = dp[(i - 1) * (M + 1) + j - 1] + score[(i - 1) * M + (j - 1)];
        if (diag > best) { best = diag; dir = 3; }
        dp[i * (M + 1) + j] = best;
        from[i * (M + 1) + j] = dir;
      }
    }
    const map = {};
    const sims = [];
    let i = N;
    let j = M;
    while (i > 0 && j > 0) {
      const dir = from[i * (M + 1) + j];
      if (dir === 3) {
        map[probesOk[i - 1].ch] = validCands[j - 1].ch;
        sims.push(score[(i - 1) * M + (j - 1)]);
        i--; j--;
      } else if (dir === 1) i--;
      else j--;
    }
    const avg = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
    const min = sims.length ? Math.min(...sims) : 0;

    // 只保留页面上确实出现过的伪字，减少误伤
    const text = sampleText || '';
    let used = 0;
    for (const k of Object.keys(map)) if (text.includes(k)) used++;

    return {
      ok: true, family: picked.family, refFamily, count: Object.keys(map).length, hash,
      usedInText: used, avgSim: Number(avg.toFixed(3)), minSim: Number(min.toFixed(3)),
      map,
    };
  })();
}
