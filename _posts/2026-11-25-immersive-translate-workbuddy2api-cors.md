---
title: 使用 Caddy 解决沉浸式翻译调用 Workbuddy2Api 的跨域问题
description: 排查 OPTIONS 预检返回 405 的原因，并在 Caddy 中配置 CORS。
categories: [技术实践, 服务器]
---

使用沉浸式翻译调用自建的 Workbuddy2Api 时，测试服务提示连接失败。API 地址、密钥和模型名均已确认，浏览器控制台则给出了更具体的错误：

```text
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

问题出在跨域预检。下面记录排查过程及 Caddy 的配置方法。

## 排查预检请求

服务通过 Caddy 反向代理，原配置如下：

```caddyfile
api.yehui2001.cn {
    redir / /panel/ 302
    reverse_proxy 127.0.0.1:7863
}
```

在 PowerShell 中模拟浏览器的预检请求：

```powershell
curl.exe -i -X OPTIONS "https://api.yehui2001.cn/v1/chat/completions" `
  -H "Origin: chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh" `
  -H "Access-Control-Request-Method: POST" `
  -H "Access-Control-Request-Headers: authorization,content-type"
```

返回结果为 `405 Method Not Allowed`，并带有 `Allow: POST`，没有返回 CORS 响应头。这说明请求到达了服务，但该路径没有正确处理 `OPTIONS`。浏览器因此拦截了后续调用。

## 为什么需要 OPTIONS

沉浸式翻译运行在 Chrome 扩展来源 `chrome-extension://bpoadfkcbjbfhfodiogcnhhhpibjhbnh` 下，API 位于 `https://api.yehui2001.cn`，两者属于不同来源。

实际请求使用 `POST`，包含 `Authorization` 请求头和 JSON 内容，不满足浏览器对简单跨域请求的条件。因此浏览器先发送 `OPTIONS`，询问服务端是否允许该来源使用这些方法和请求头。预检不包含实际翻译内容或 API 密钥。

```text
浏览器 → OPTIONS 预检 → Caddy → Workbuddy2Api
浏览器 ← 405，缺少 CORS 响应头
浏览器拦截，实际 POST 不再发送
```

预检通过后，浏览器才会发送真正的 POST；实际响应也需要包含允许该来源的 `Access-Control-Allow-Origin`，浏览器才允许扩展读取结果。CORS 是浏览器的访问规则，API 密钥仍由服务端验证。命令行工具通常不会自动执行浏览器的预检，因此 curl 能访问不代表浏览器调用也能通过。

## 在 Caddy 中处理 CORS

修改站点配置，让 Caddy 直接响应预检，并为来自扩展的响应添加 CORS 头：

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

这里的扩展 ID 来自浏览器控制台中的 `Origin`，使用时应以自己的实际来源为准。Caddy 处理预检后，不需要为了此问题修改 Workbuddy2Api；如果上游也设置了 CORS，需检查是否出现重复的 `Access-Control-Allow-Origin` 响应头。

修改后的流程：

```text
浏览器 → OPTIONS 预检 → Caddy
浏览器 ← 204 和 CORS 响应头
浏览器 → POST 请求 → Caddy → Workbuddy2Api
浏览器 ← 带 CORS 响应头的 API 响应
```

## 重载并验证

如果 Caddy 通过 systemd 安装，且配置文件位于 `/etc/caddy/Caddyfile`，先验证配置，再重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Docker 部署的配置路径和重载命令可能不同。重载后重新执行前面的 `curl.exe` 命令，检查响应是否为 `204`，以及是否包含 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods` 和 `Access-Control-Allow-Headers`。再回到沉浸式翻译测试；若仍失败，继续查看实际 POST 的状态码和响应。

控制台中针对沉浸式翻译自身配置服务的错误，应与自建 API 的跨域错误分别排查。
