# AGENTS.md

本文件面向在本仓库上继续工作的 AI 代理与人类协作者：它记录**这个仓库是什么、代码怎么分层、哪些约束不能破**，以及排查问题时该先看哪里。

> 一句话：autoxxt 是一个零依赖 Node 的学习通（超星/泛雅）浏览器自动化工具箱。它不模拟按键、不接管用户浏览器，而是通过 Chrome DevTools Protocol（CDP）驱动一个**已登录**的浏览器，完成章节测验、作业、以及视频任务点进度等操作。

---

## 1. 仓库结构

```
src/                       核心库（原仓库，保持向后兼容）
  index.js                 交互式 CLI（列课程 → 选测试 → 作答提交）
  browser.js               找 Edge/Chrome，起或复用一个带 --remote-debugging-port 的实例
  cdp.js                   极简 CDP 客户端（Runtime/Page/Network/Input）
  chaoxing.js              学习通页面操作：列课程、拿 enc、列章节、开作业
  flow.js                  单套作业的完整流水线（抽题 → 题库/LLM → 作答 → 校验 → 提交 → 复核学习）
  config.js / kb.js / llm.js / text.js / ws.js
  inject/                  注入到页面里执行的函数（纯字符串化后 eval）
    courses.js chapters.js extract.js answer.js submit.js confirm.js
    review.js redo.js redoConfirm.js font.js quizstatus.js
tools/                     调试与专项驱动脚本（本文件重点）
test/unit.js               离线单测（题库、文本相似度），不需要浏览器
```

`tools/` 里每个脚本都是**独立可执行的**，只依赖 `src/`，不互相 import。新增能力请优先放 `tools/`，避免污染 `src/` 的既有契约。

---

## 2. 学习通有三套页面模板，别混用

这是本仓库最容易踩的坑：同一门课的不同入口，DOM 完全不同。

| 模板 | 识别特征 | 抽题 | 作答/提交 |
| --- | --- | --- | --- |
| **A. 老版作业页**（mooc1 `work/doHomeWorkNew`） | `.TiMu` + `.Zy_ulTop li` + `span[data]`；题干在 `div.font-cxsecret` | `src/inject/extract.js` | `src/inject/answer.js` |
| **B. 泛雅作业页**（`mooc2/work/dowork`） | `div.questionLi[data=qid][typename=单选题]` + `div.answerBg` + `span.num_option`/`num_option_dx` | `tools/fanya.js extract` | `tools/fanya.js answer` |
| **C. 章节测验页**（章节内嵌 work 模块，`mooc1 .../work/doHomeWorkNew?...&api=1`） | 顶层就有 `.TiMu`，但**页面里还嵌着 iframe** | `tools/qold.js extract` | `tools/qold.js answer` |

> 模板 A 与 C 的 DOM 几乎一样，区别在于 C 的页面上存在 iframe。`src/inject/extract.js` 和 `answer.js` 里的 `findDoc()` 会**无脑钻进第一个 iframe**，在 C 上就找不到题目了。所以引入了 `tools/qold.js`：同样的选择器，但只看顶层文档。

---

## 3. 字体混淆（font-cxsecret）

学习通把题干/选项里的汉字换成一批生僻码位，再用内联 base64 的 `@font-face` 渲染回真字。DOM 里读到的是乱码，屏幕上却是正常中文。

`src/inject/font.js` 的解法（纯浏览器内，无需本地字体库）：

1. 从 CSS 里挑出体积最大的内联 base64 字体，解析 sfnt 表拿 `cmap`（伪码位 → glyph id）；
2. 用 canvas 把每个伪码位和候选真字（U+4E00–U+9FA5）分别渲染成 32×32 位图，做余弦相似度；
3. 利用「subset 字体 glyph id 顺序 = 真字 Unicode 升序」这一规律，用单调 DP 全局对齐，比逐字独立匹配稳得多。

实测平均相似度约 0.83，会出现少量形近字误判（例如「学→字」「幼→幻」）。**这不影响作答**：选项按字母点，题干大意可读即可。若某套题完全解不出，先确认 `collectCss()` 有没有拿到跨域样式表（跨域 CSS 的 `cssRules` 会抛异常，属正常忽略）。

---

## 4. 工具目录（tools/）

### 4.1 通用调试

| 脚本 | 用途 |
| --- | --- |
| `probe.js` | 通用探针：`--tab N` 选标签页、`--nav/--navb64` 导航、`--file` 执行表达式文件、`--text` 打印正文、`--click` 点文字 |
| `tabs.js <port>` | 列出某调试端口上的全部标签页 |
| `run-inject.js <port> <name> [json]` | 直接跑 `src/inject/<name>.js` 并打印返回 |
| `scores.js [port]` | 汇总各作业成绩页上记录的分数 |
| `netlog.js` | 抓播放器/接口请求：`--play` 会同时触发播放，打印 method/url/postData/响应体 |

> 传参注意：Windows 上 `node` 可能是 `.cmd` 包装，命令里的 `&` 会被 `cmd.exe` 截断。凡是带查询串的 URL，用 `--navb64`（base64）传，别直接拼。

### 4.2 导航与课程/章节

| 脚本 | 用途 |
| --- | --- |
| `courses.js` | 列当前账号全部课程（courseid/clazzid/cpi），可带关键词过滤 |
| `course-open.js <courseId> <classId> <cpi>` | 走 `stucoursemiddle` 拿 `enc`，打开新版课程门户并打印任务中心概览 |
| `click-go.js <章号>` | 在门户任务中心点「第 N 章 去完成」，并报告新开的 `dowork` 地址 |
| `works.js` | 遍历章节，抽出每个「章节测验」的真实入口（含内层 `api/work?...ktoken=`） |
| `dump-chapters.js` | 按课程名抓第 N–M 章测验的题干（只读，不提交） |

### 4.3 作业/测验作答

| 脚本 | 用途 |
| --- | --- |
| `fanya.js extract/answer/submit/view/redo/status` | 泛雅模板（模板 B）全套：抽题、作答、提交、读复核页正确答案、重做 |
| `qold.js extract/answer/submit` | 章节测验模板（模板 C）：抽题时附带字体破解，作答用 **CDP 真鼠标事件** |
| `current-extract.js` / `current-solve.js` | 对「当前标签页」抽题/作答，不管页面怎么打开的 |

### 4.4 视频任务点

| 脚本 | 用途 |
| --- | --- |
| `venum.js --chapters id1,id2,...` | 统计各章视频任务点数量与总时长 |
| `vfill.js [--dry/--probe]` | 采集播放器上报 URL 并尝试补报（见下方「已证伪」） |
| `vtest.js` / `vtest2.js` | 倍速/播放状态诊断：焦点模拟、点击 big-play、采样 `currentTime` 与上报 |

### 4.5 多账号

| 脚本 | 用途 |
| --- | --- |
| `open-login.js --port 9223 --profile .profile-b` | 起一个**独立 profile + 独立调试端口**的浏览器并停在登录页，用于登录另一个账号 |

---

## 5. 关键实测结论（别再重复踩）

1. **视频进度上报是明文 GET，但带签名**
   `/mooc-ans/multimedia/log/a/<cpi>/<token>?clazzId=..&playingTime=..&duration=..&clipTime=0_..&objectId=..&otherInfo=..`
   原样重放返回 200；**只要改 `playingTime` 任何一个数字就 403**。签名跟查询串绑定，不能自己伪造。→ 只能让真实播放器跑。
2. **播放器倍速上限 2×**
   直接设 `video.playbackRate = 3/4` 会被播放器重置回 1 并暂停。2× 可稳定推进且进度照常累计。
3. **播放需要「像真人」**
   必须：`Emulation.setFocusEmulationEnabled(true)` + `Page.bringToFront` + 点击 `.vjs-big-play-button`。只调 `video.play()` 在 iframe 滚出视口时会立刻被暂停。
4. **完成条件是「观看时长 ≥ 总时长 90%」**，未完成前禁止拖拽。
5. **章节测验不计入任务点**，任务点只数视频 / PDF / 测验模块中的视频与文档；但章节测验仍计入课程成绩。
6. **作业允许重做次数是有限的**（常见 4 次）。`fanya.js view` 会读复核页的 `正确答案`，据此修正后再 `redo`，是刷到满分的标准路径。
7. 泛雅复核页结构：`div.questionLi` + `.stuAnswerContent`（我的答案）+ `.rightAnswerContent`（正确答案）。

---

## 6. 标准工作流

### 6.1 登录（一次即可）

```bash
node src/index.js --login                     # 主账号，端口 9222，profile = .profile
node tools/open-login.js --port 9223 --profile .profile-b   # 第二账号，完全隔离
```

### 6.2 刷一套泛雅作业（模板 B）

```bash
node tools/click-go.js 1                      # 门户里点开第 1 章作业
node tools/fanya.js extract --out data/ch01.json
node tools/fanya.js answer --answers data/ch01-answers.json
node tools/fanya.js submit
node tools/fanya.js view --out data/ch01-view.json   # 有错 → 改答案 → redo → 再 submit
```

### 6.3 刷章节测验（模板 C）

```bash
node tools/works.js --port 9223 --course <id> --clazz <id> --cpi <id> --enc <enc> --chapters a,b,c
node tools/probe.js --cdp 9223 --tab 0 --navb64 <base64(innerUrl)>
node tools/qold.js extract --out data/quiz1.json      # 自动字体破解
node tools/qold.js answer --answers data/quiz1-answers.json
node tools/qold.js submit
```

### 6.4 视频任务点

```bash
node tools/venum.js --chapters <ids>          # 先算总时长，决定工期
node tools/vtest2.js --only 1 --rate 2        # 确认能稳定播放
```

按 2× 计算：`总时长 / 2`。**不要**尝试伪造上报（见 §5.1）。

---

## 7. 给代理的硬性约定

- **不要提交敏感数据**：`data/`（题库、题干、答案）、`.profile*/`（含登录 Cookie）、`config.json`、任何 `*pat*` / `*token*` 文件都已在 `.gitignore` 里，不要为了「图方便」`git add -f` 它们。仓库里出现别人的 cookie 或 PAT 等于事故。
- **不要在 `src/inject/*.js` 里回退 `findDoc()` 的 iframe 下钻**——模板 A 依赖它。模板 C 请用 `tools/qold.js`。
- **改 `src/` 要保持 CLI 兼容**：`node src/index.js` 的交互式菜单、`--login/--list/--course/--work/--all/--dry/--force/--learn/--cdp` 这些开关不能改语义。
- **凡是「点一下」的操作，优先用 `Input.dispatchMouseEvent` 走真实鼠标事件**，而不是 `el.click()`：学习通很多 `li` 的 `onclick` 是 jQuery 绑定的，合成 click 常常不触发，且点击后 DOM 位移会让**批量缓存的坐标失效**——每次点击前重新取坐标。
- **Windows 环境注意事项**
  - 不要用 PowerShell `Set-Content -Encoding UTF8` 回写含中文的 `.js`（会加 BOM 或转成 GBK 双字节），一律用文件工具写入 UTF-8。
  - `node` 若是 `.cmd` 包装，命令行里的 `&` 会被 cmd 截断；URL 用 base64 传参。
- **失败要留证据**：脚本出错时优先打印 `location.href`、`document.body.innerText` 前 200 字、以及关键选择器的数量统计，再判断是模板不匹配还是登录态过期。

---

## 8. 已知局限

- LLM 兜底需要自备 OpenAI 兼容 API Key（`config.json` 的 `llm.apiKey`）；没有 Key 时仅靠题库命中。
- `font.js` 不支持 woff2 混淆字体（会明确报错）。
- 视频必须真实播放，没有捷径；这是平台签名机制决定的，不是本工具没做。
- 自动化操作可能违反学校规定与平台协议，使用后果自负（见 `LICENSE` 与 `README.md` 的免责声明）。
