# autoxxt

> 超星学习通（xuexitong）章节测验 / 作业自动答题工具 —— 零依赖、自动破解字体混淆、题库自学习 + LLM 兜底、不接管你的浏览器。
>
> License: [MIT](./LICENSE)

零依赖 Node，通过 Chrome DevTools Protocol 驱动你自己已经登录的浏览器，自动完成：

- 选中课程 → 列出全部章节测验 / 作业
- 破解学习通的**字体混淆**，把乱码题干还原成可读中文
- **题库优先**（答过的题自动沉淀，下次直接命中）+ LLM 兜底（题库没有的题交给大模型判断）
- 自动作答（按选项真实字母，忽略页面上的随机打乱）、逐题校验、自动提交
- 交卷后从复核页**学习正确答案**回填题库，越用越准

> ⚠️ 仅供学习与技术研究。使用自动化工具答题可能违反学校规定与平台协议，后果自负。

---

## 为什么用 CDP 而不是模拟按键

学习通有三道防线，本工具是这样过的：

| 防线 | 现象 | 本工具的做法 |
| --- | --- | --- |
| 字体混淆 | 页面上是自定义 `@font-face`（`font-cxsecret`），复制出来是乱码，截图才能读 | 在页面内用 canvas 把混淆字体字形与系统字体字形做位图余弦匹配，再按「glyph id 顺序 = 真字 Unicode 升序」做单调 DP 对齐，一次解出全部字符 |
| 选项打乱 | 选项顺序和显示字母（A/B/C/D）每次都不一样 | 读 `span[data]` / `input[value]` 里的**真实字母**再点，不看显示字母 |
| 后台节流 | 标签页不在前台时，`validate` 请求的回调不返回，提交永远失败 | 每次操作前 `Page.bringToFront`，保证 `document.visibilityState === 'visible'` |

另外：工具**永远不会关闭你的浏览器**。它优先复用你已经打开的调试端口，没有才用独立的 profile 目录另起一个实例，只在你用完后提醒你自己关。

---

## 环境要求

- Node.js ≥ 18（自带 `fetch`；WebSocket 由本仓库自己实现，不依赖 `ws` 包）
- 一个 Chromium 内核浏览器：Microsoft Edge 或 Google Chrome
- 一个能用的 OpenAI 兼容 LLM API（默认 DeepSeek），**可选**——没有 API key 时只用题库，命中率随使用次数上升

无需 `npm install`。

---

## 快速开始

```bash
# 1) 首次：让浏览器带调试端口启动，并手动登录一次学习通
node src/index.js --login

# 2) 之后每次：直接跑交互式菜单
node src/index.js
```

Windows 也可以双击 `run.bat`，macOS / Linux 用 `./run.sh`。

登录只需一次：工具默认使用自己独立的浏览器配置目录（`~/.autoxxt/profile`），登录状态会被保留。你也可以复用平时用的浏览器，只要它是带 `--remote-debugging-port=9222` 启动的。

### 常用命令

```bash
node src/index.js --list                    # 只是列出课程和章节，不答题
node src/index.js --course 1 --all          # 第 1 门课的所有测验全部作答并提交
node src/index.js --course "毛泽东思想和中国特色社会主义理论体系概论" --all
node src/index.js --course 1 --work 3       # 只做第 3 套
node src/index.js --course 1 --work 3 --dry # 只作答、不提交（先看看答得对不对）
node src/index.js --course 1 --learn        # 只从已完成的复核页抄答案进题库，不消耗重做次数
node src/index.js --course 1 --all --force  # 已完成的也重做（会消耗重做次数！）
node src/index.js --cdp 9222 --course 1 --all   # 附加到已经在 9222 端口上的浏览器
```

| 开关 | 说明 |
| --- | --- |
| `--cdp <port>` | 附加到已存在的调试端口，不新起浏览器 |
| `--login` | 打开浏览器等你手动登录，登录后回车继续 |
| `--course <序号\|名称>` | 指定课程；不给则弹菜单 |
| `--work <n>` | 只处理该课程下的第 n 套测验 |
| `--all` | 该课程下所有测验依次处理 |
| `--max <n>` | 最多处理 n 套 |
| `--dry` | 只作答不提交 |
| `--force` | 已完成的也重做 |
| `--learn` | 只学不复做 |
| `--llm-key <key>` | 临时指定 LLM key（优先于 config.json） |
| `--list` | 只列课程与章节 |

---

## 配置文件

首次运行会生成 `config.json`（同时保留一份 `config.example.json` 作为模板）：

```json
{
  "browser": {
    "executablePath": null,          // 留空自动找 Edge / Chrome
    "port": 9222,
    "profileDir": null,              // 留空用 ~/.autoxxt/profile
    "headless": false
  },
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "",                    // ← 想用 LLM 兜底就填这里
    "model": "deepseek-chat",
    "temperature": 0,
    "batch": 10                      // 每次请求几道题
  },
  "quiz": {
    "autoSubmit": true,              // false = 只作答不提交
    "force": false,
    "skipDone": true,
    "maxRetryPerWork": 1
  },
  "kb": {
    "fuzzyMin": 0.82,                // 题干模糊匹配阈值（Dice 系数）
    "optMin": 0.86                   // 选项文本匹配阈值
  },
  "paths": {
    "kbFile": null,                  // 默认 data/kb.json
    "fontMapDir": null               // 默认 data/fontmaps/
  }
}
```

任何 OpenAI 兼容服务都能用，例如：

```json
{ "llm": { "baseUrl": "https://api.moonshot.cn/v1", "model": "moonshot-v1-8k", "apiKey": "sk-..." } }
```

---

## 题库（自学习）

`data/kb.json` 是核心资产：

- 键 = 归一化后的题干哈希（去空白、去标点、去括号后缀）
- 值 = **答案的选项文本**（不是字母——选项顺序每次都会变）、题型、来源、命中次数
- `source: "review"` 表示答案来自交卷后的复核页，**已核实**，不会被未核实的结果覆盖

所以：**同一门课第二次刷（比如帮同学刷）几乎全中**，只需 LLM 兜少量新题。题库可以直接复制给别人用，但请注意它包含题目文本。

想重置就删掉 `data/kb.json`。

---

## 工作原理（一图流）

```
src/index.js           交互式 CLI，串起整个流程
  └─ src/browser.js    找 Edge/Chrome，起（或复用）带调试端口的实例，永不 kill
  └─ src/cdp.js        极简 CDP 客户端（DOM/Runtime/Page/Network）
  └─ src/chaoxing.js   学习通页面操作：列课程 → 拿 enc → 列章节 → 打开测验
  └─ src/flow.js       单套作业的完整流水线
       ├─ src/inject/font.js       页面内破字体混淆（canvas + 单调 DP 对齐）
       ├─ src/inject/extract.js    抽题（兼容新老两套 DOM）
       ├─ src/kb.js + src/llm.js   题库优先，余下交 LLM
       ├─ src/inject/answer.js     按真实字母作答并回读校验
       ├─ src/inject/submit.js     点提交
       ├─ src/inject/confirm.js    点确认弹窗
       └─ src/inject/review.js     读复核页 → 回填题库
```

调试小工具：

```bash
node tools/run-inject.js 9222 quizstatus        # 对当前页跑某个 inject，看返回的 JSON
node tools/decode-page.js 9222 5                # 抽题 + 破字体 + 解码，打印前 5 题（核对解码质量）
node test/unit.js                               # 离线单元测试（题库、文本相似度，不需要浏览器）
```

---

## 常见问题

**Q：提示「这是成绩/答案复核页，不是作答页」？**
A：该套已经交过卷了。用 `--force` 重做（消耗一次重做次数），或看已完成成绩。

**Q：提交后一直显示「待完成」？**
A：几乎都是标签页被切到后台导致请求被节流。工具已自动 `bringToFront`；如果仍失败，把浏览器窗口保持在前台再跑一次。

**Q：解码出来的题干有几个字是错的（比如「国」显示成「囸」）？**
A：字体破解是位图相似度匹配，形近异体字偶尔会赢。这不影响作答——答案按选项字母走，LLM 也能读懂大意；题库侧的文本匹配用了模糊阈值兜底。

**Q：没有 LLM key 能用吗？**
A：能。只用题库，命中多少答多少，剩下的留空；交卷后复核页会把正确答案学进题库，下一套/下一次就更准。

**Q：会消耗重做次数吗？**
A：默认 `skipDone: true`，已完成的会跳过。只有 `--force` 才会重做。

---

## 免责声明

本项目仅用于学习浏览器自动化、字体反混淆、CDP 协议等技术。请勿用于违反学校纪律或平台用户协议的用途，使用产生的一切后果由使用者自行承担。

---

## License

[MIT](./LICENSE) © 2026 autoxxt contributors
