# CS61A GUI

一个面向 CS61A 作业的浏览器本地学习工作区。题面、源码、作答、备份和学习进度
均保存在当前浏览器中，不需要账号，也不会在不同访客之间共享。

## 在线模式

- 从官方目录选择 Lab、Homework 或 Project 后，由浏览器下载并安全解压 ZIP。
- 作业文件、答案和缓存题面保存在 IndexedDB；刷新页面后仍然存在。
- Monaco Editor 支持 Python、Scheme 和 SQL 语言模式。
- WWPD 与概念题在浏览器本地判定，正确答案不会发送到服务端。
- Python 与 OK 在独立的 Pyodide Web Worker 中运行；超时或取消会直接终止 Worker。
- 题面翻译使用 MyMemory 公共接口，只发送题面中的普通文本，不发送代码或答案。

浏览器中的 Pyodide 没有原生子进程、线程和系统命令。因此普通 Python 作业通常可以
直接运行；依赖外部可执行程序、系统网络或原生扩展的完整 OK 测试会显示明确错误，
这类作业可改用桌面模式。

## 部署到 Vercel

仓库根目录已经包含 `vercel.json`。在 Vercel 中导入此 GitHub 仓库即可，框架与构建
设置会自动读取：

- Install Command：`npm --prefix frontend ci`
- Build Command：`npm --prefix frontend run build`
- Output Directory：`frontend/dist`

`api/course.js` 是一个无状态的官方资源代理，只允许读取 `https://cs61a.org`，
不接收也不保存访客源码、作答或进度。其余功能均在浏览器中完成。

## 本地运行

PowerShell：

```powershell
.\setup.ps1
.\start.ps1
```

应用会在 `http://127.0.0.1:8761` 打开。FastAPI 在本地提供静态页面与官方资源代理；
作业数据仍保存在浏览器 IndexedDB 中。

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
