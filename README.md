# Yehui's Notes

个人博客与数字花园，发布于 [yehui2001.github.io](https://yehui2001.github.io/)。

## 功能

- 文章归档与分类
- 客户端全文搜索
- Utterances 文章评论与留言簿
- 深色模式、响应式布局与阅读进度
- RSS、Open Graph 分享卡片与基础 SEO

## 写新文章

在 `_posts` 目录新建 `YYYY-MM-DD-slug.md`：

```yaml
---
title: 文章标题
description: 一句话摘要
categories: [分类一, 分类二]
---

这里开始写正文。
```

提交到 `main` 分支后，GitHub Pages 会自动更新站点。

## 启用评论

评论由 [Utterances](https://utteranc.es/) 托管。首次使用时，需要为 `yehui2001/yehui2001.github.io` 仓库安装 Utterances GitHub App，并确认仓库已启用 Issues。即使评论框尚未启用，页面也保留了直接前往 GitHub Issues 留言的入口。
