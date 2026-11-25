---
title: 沉浸式翻译连接 Workbuddy2Api 的 CORS 问题
description: 排查浏览器跨域预检失败，并使用 Caddy 处理 OPTIONS 请求。
categories: [技术, 服务器]
---

日期：2026-11-25

## 问题现象

在沉浸式翻译中配置自定义 OpenAI 兼容服务：

- API 地址：`https://api.yehui2001.cn/v1/chat/completions`
- 模型：`deepseek-v4-flash`（用户确认模型和密钥有效）
- 测试服务提示“连接失败”。

浏览器控制台中针对该 API 的报错：

```text
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

命令行检查显示，API 地址可以访问；不带密钥的 POST 返回 `401`，说明请求到达了服务，但不能据此验证密钥或模型。针对该地址的 `OPTIONS` 预检请求返回 `405 Method Not Allowed`，且没有允许跨域的响应头。

## 原因

沉浸式翻译从 Chrome 扩展来源访问 API。浏览器在带 `Authorization` 等请求头的 POST 之前，先发送 `OPTIONS` 跨域预检。服务器没有正确响应预检，浏览器因此拦截后续 API 调用。

控制台中还有 `config.immersivetranslate.com` 和 `analytics.immersivetranslate.com` 的跨域错误，它们属于沉浸式翻译自身服务的请求，与这里针对自定义 API 的报错分别排查。

## 跨域预检的原理

沉浸式翻译扩展的来源是 `chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh`，API 的来源是 `https://api.yehui2001.cn`。两者来源不同，浏览器会按 CORS（跨域资源共享）规则检查请求。

这次请求使用 `POST`，携带 `Authorization` 请求头和 `Content-Type: application/json`，不符合简单跨域请求的条件。浏览器因此先发送 `OPTIONS` 预检，询问服务器是否允许该来源使用指定方法和请求头。预检不包含实际的翻译内容和 API 密钥：

```http
OPTIONS /v1/chat/completions HTTP/1.1
Host: api.yehui2001.cn
Origin: chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh
Access-Control-Request-Method: POST
Access-Control-Request-Headers: authorization, content-type
```

预检的作用是让服务器在实际请求产生影响前，先决定是否接受这种跨域调用。并非所有跨域请求都需要预检；符合简单请求条件的请求可以直接发送，然后由浏览器检查响应是否允许读取。`curl` 等非浏览器客户端通常不会自动执行浏览器的 CORS 预检，所以命令行能够访问并不代表浏览器扩展一定能访问。

### 405 和缺少响应头

`405 Method Not Allowed` 表示服务器收到了请求，但该地址不接受当前请求方法。当时预检返回 `405`，并带有 `Allow: POST`：接口接受用于聊天的 `POST`，但没有正确处理 `OPTIONS` 预检。

预检成功的响应示例：

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

`Access-Control-Allow-Origin` 指定允许的来源；`Access-Control-Allow-Methods` 指定允许的方法；`Access-Control-Allow-Headers` 指定允许的请求头。当时响应缺少这些跨域许可信息，浏览器无法确认服务器允许访问，于是拦截调用，实际 POST 没有发送。

修改前的流程：

```text
沉浸式翻译扩展
      │
      │ 1. 浏览器发送 OPTIONS 预检
      ▼
Caddy → W2API
      │
      │ 2. 返回 405，且没有 CORS 允许信息
      ▼
浏览器拦截
      │
      └── 实际 POST 翻译请求没有发送
```

### 修改后的请求流程

```text
沉浸式翻译扩展
      │
      │ 1. 浏览器发送 OPTIONS 预检
      ▼
Caddy 直接返回 204 和 CORS 响应头
      │
      │ 2. 浏览器检查通过
      ▼
浏览器发送真正的 POST 请求
      │
      ▼
Caddy 转发给 W2API
      │
      ▼
W2API 返回结果，Caddy 添加 CORS 响应头
      │
      ▼
沉浸式翻译读取结果
```

1. 浏览器向 Caddy 发送 `OPTIONS` 预检。
2. Caddy 直接返回 `204` 和允许该扩展来源、方法及请求头的 CORS 响应头。
3. 浏览器检查通过后，发送带有翻译内容和密钥的实际 `POST`。
4. Caddy 将 POST 转发给 W2API，并在响应中添加允许该来源的 CORS 响应头，浏览器才允许扩展读取结果。

预检响应和实际 POST 响应都需要满足相应的 CORS 检查。CORS 由浏览器执行；API 密钥仍由服务端验证，允许跨域不等于免去密钥验证。

## 修改 Caddy

原配置：

```caddyfile
api.yehui2001.cn {
    redir / /panel/ 302
    reverse_proxy 127.0.0.1:7863
}
```

将站点块替换为：

```caddyfile
api.yehui2001.cn {
    @immersive_origin header Origin chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh

    header @immersive_origin {
        Access-Control-Allow-Origin "chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh"
        Access-Control-Allow-Methods "GET, POST, OPTIONS"
        Access-Control-Allow-Headers "Authorization, Content-Type"
        Vary "Origin"
        defer
    }

    @preflight {
        method OPTIONS
        header Origin chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh
    }
    respond @preflight 204

    redir / /panel/ 302
    reverse_proxy 127.0.0.1:7863
}
```

扩展 ID 根据当时的控制台截图记录；如果使用其他浏览器或扩展 ID 发生变化，需要按实际 `Origin` 调整。由 Caddy 处理 CORS 时，W2API 暂不需要修改；如果上游也设置了 CORS，要避免重复的 `Access-Control-Allow-Origin` 响应头。

## 验证与重载

如果 Caddy 使用 systemd 安装，且配置路径为 `/etc/caddy/Caddyfile`：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

仅在配置验证通过后重载。Docker 部署的配置路径和重载方式可能不同。

在 PowerShell 中检查预检响应：

```powershell
curl.exe -i -X OPTIONS "https://api.yehui2001.cn/v1/chat/completions" `
  -H "Origin: chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh" `
  -H "Access-Control-Request-Method: POST" `
  -H "Access-Control-Request-Headers: authorization,content-type"
```

预期返回 `204`，并包含对应的 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods` 和 `Access-Control-Allow-Headers`。然后在沉浸式翻译中重新测试；若仍失败，查看实际 POST 请求的状态码、响应和控制台错误。

**状态：**上述配置为针对已观察到的 CORS 问题提出的修改方法；本次记录时尚未确认服务器已修改或端到端测试通过。
