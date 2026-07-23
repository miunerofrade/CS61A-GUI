# CS61A GUI

一个面向 CS61A 作业的浏览器本地学习工作区。题面、源码、作答、备份和学习进度
均保存在当前浏览器中，不需要账号，也不会在不同访客之间共享。

## 下载桌面版

需要完整本机 OK 环境时，可从
[GitHub Releases](https://github.com/miunerofrade/CS61A-GUI/releases/latest)
下载 Windows x64 压缩包。完整解压后运行 `CS61A-GUI.exe`，无需另外安装 Node.js
或 Python。

## 在线模式

- 从官方目录选择 Lab、Homework 或 Project 后，由浏览器下载并安全解压 ZIP。
- 作业文件、答案和缓存题面保存在 IndexedDB；刷新页面后仍然存在。
- Monaco Editor 支持 Python、Scheme 和 SQL 语言模式。
- WWPD 与概念题在浏览器本地判定，正确答案不会发送到服务端。
- Python 与 OK 在独立的 Pyodide Web Worker 中运行；超时或取消会直接终止 Worker。
- 题面翻译使用 MyMemory 公共接口，只发送题面中的普通文本，不发送代码或答案。

浏览器中的 Pyodide 没有原生子进程、线程、原始网络套接字和系统命令。应用会在导入
作业时自动扫描源码与附属文件，并在左侧和题面顶部显示兼容性：

- 绿色勾：浏览器可运行当前标准 OK 测试。
- 黄色警告：基础测试可运行，但图形界面、多人或联网扩展需要桌面版。当前 Ants 的
  GUI 与 Cats 的 multiplayer 属于此类。
- 桌面图标：Scheme、SQL，或主源码直接依赖 `subprocess`、`multiprocessing`、
  `socket`、`threading`、`tkinter`、`turtle`，浏览器测试按钮会停用。

这项检测会随导入的作业内容动态执行，不依赖写死的 Lab 编号。

## 部署到 Vercel

仓库根目录已经包含 `vercel.json`。在 Vercel 中导入此 GitHub 仓库即可，框架与构建
设置会自动读取：

- Install Command：`npm --prefix frontend ci`
- Build Command：`npm --prefix frontend run build`
- Output Directory：`frontend/dist`

`api/course.js` 是一个流式、无状态的官方资源代理，只允许读取
`https://cs61a.org`，不接收也不保存访客源码、作答或进度。其余功能均在浏览器中完成。

## 本地运行

PowerShell：

```powershell
.\setup.ps1
.\start.ps1
```

应用会在 `http://127.0.0.1:8761` 打开。源码、备份与下载的作业位于本地工作区，
测试通过本机 Python 执行。

构建 Windows Release：

```powershell
.\scripts\build-release.ps1 -Version 1.0.0
```

只开发前端时：

```powershell
cd frontend
npm run dev
```

## 验证

```powershell
npm run build
uv run pytest -q
```

## 隐私与判题边界

浏览器本地判题意味着服务器看不到答案和代码，也意味着有经验的用户可以通过开发者
工具检查下载到浏览器的公开测试答案。这适合自学工具，但不能替代需要防作弊保证的
正式考试或 Gradescope 提交。
