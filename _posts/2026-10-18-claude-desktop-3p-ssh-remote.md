---
title: Claude Desktop 3P 版本启用 SSH 远程会话
description: 在 Windows 上为 Claude Desktop 第三方推理部署配置 SSH 远程会话，涵盖 sshHostAllowlist、连接设置、远程主机要求与安全注意事项。
categories: [技术实践, AI 工具, Claude]
---
## 前置条件

- Claude Desktop 版本 **≥ 1.40609.0**（SSH 功能在 3P 部署中为 beta 特性）
- Windows 系统（本文档基于 Windows，macOS/Linux 路径略有不同）
- 已配置好第三方推理提供商（gateway/bedrock/vertex 等）
- 远程主机需要运行 SSH 服务并开启 SFTP 子系统

## 一、确认当前配置来源

SSH 远程会话需要在托管配置中设置 `sshHostAllowlist` 键。首先确定你的配置来源：

### 1. 检查是否存在托管策略

在 PowerShell 中执行：

```powershell
reg query "HKLM\SOFTWARE\Policies\Claude"
reg query "HKCU\SOFTWARE\Policies\Claude"
```

**结果判断：**

- **找不到注册表项/值**：本地配置生效，可以自行修改（继续下一步）
- **查询成功且有 `inferenceProvider` 等键**：设备被 MDM/策略管理，需要联系 IT 管理员添加 `sshHostAllowlist`

### 2. 查看本地配置文件

如果没有托管策略，检查本地配置目录：

```powershell
dir "$env:LOCALAPPDATA\Claude-3p\configLibrary"
```

你会看到：
- `_meta.json`：记录当前生效的配置 ID
- `<id>.json`：实际配置文件（例如 `00000000-0000-4000-8000-000000157210.json`）


## 二、修改配置文件

### 方式 1：手动编辑 JSON（推荐）

1. **完全退出 Claude Desktop**（从托盘右键退出，不是关窗口）

2. **备份原配置文件**：

```powershell
Copy-Item "$env:LOCALAPPDATA\Claude-3p\configLibrary\<你的id>.json" `
          "$env:LOCALAPPDATA\Claude-3p\configLibrary\<你的id>.json.bak"
```

3. **编辑配置文件**，路径：

```
C:\Users\<你的用户名>\AppData\Local\Claude-3p\configLibrary\<id>.json
```

在 JSON 根对象中添加 `sshHostAllowlist` 键：

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:15721/claude-desktop",
  "inferenceGatewayApiKey": "your-api-key",
  "coworkEgressAllowedHosts": ["*"],
  "sshHostAllowlist": [
    "192.168.5.10"
  ]
}
```

**多台主机示例：**

```json
"sshHostAllowlist": [
  "192.168.5.10",
  "100.75.55.87",
  "*.example.com"
]
```

**允许所有主机（不推荐）：**

```json
"sshHostAllowlist": ["*"]
```

> ⚠️ **安全警告**：SSH 会话会将推理凭据（API key）转发到远程主机。`["*"]` 意味着允许连接任何主机，只在测试环境或完全信任所有可能连接的机器时使用。

4. **保存文件**（确保编码为 UTF-8 无 BOM）

5. **重新启动 Claude Desktop**

### 方式 2：PowerShell 脚本修改

如果你熟悉命令行，可以用脚本追加主机：

```powershell
# 先退出 Claude Desktop
$hostname = "192.168.5.10"  # 替换为你的主机
$configPath = "$env:LOCALAPPDATA\Claude-3p\configLibrary\<你的id>.json"

# 备份
Copy-Item $configPath "$configPath.bak"

# 修改
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$config | Add-Member -NotePropertyName sshHostAllowlist -NotePropertyValue @($hostname) -Force
$config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
```

### 方式 3：应用内配置窗口（图形界面）

1. 打开 **Help → Troubleshooting → Enable Developer Mode**
2. 打开 **Developer → Configure Third-Party Inference…**
3. 在左侧找到 **Code surface** 分组
4. 找到 `sshHostAllowlist`（标记为 Beta）
5. 添加主机地址
6. 点击 **Apply Changes**，应用会自动重启

> 📌 如果窗口打开时是只读状态，说明存在托管策略，需要联系管理员。

## 三、添加 SSH 连接

重启后，打开 Claude Desktop：

1. 新建会话时，点击环境下拉菜单（默认显示 "Local"）
2. 选择 **SSH → Add SSH connection…**
3. 填写连接信息：
   - **Name**：连接的显示名称（如 `LAB_PC_4090`）
   - **SSH host**：`user@hostname` 或 `~/.ssh/config` 中的别名（如 `LAB_PC_4090`）
   - **SSH port**：留空使用默认 22 或 config 中的端口
   - **SSH key (optional)**：私钥路径（如 `C:\Users\yehui\.ssh\id_ed25519`），留空则使用 SSH config 或 agent
   - **Worktree folder**：远程机器上的工作目录（如 `~/worktrees`），留空使用默认
4. 点击 **Add**

之后在环境下拉中选择该连接，即可启动 SSH 会话。

## 四、远程主机要求

远程机器需要满足以下条件：

### Linux/macOS 主机

- **处理器**：x86_64 或 arm64
- **SSH 服务**：必须启用 SFTP 子系统
  ```bash
  # 检查方法：在本地执行
  sftp user@hostname
  # 能出现 sftp> 提示符即为正常
  ```
- **会话限制**：`sshd_config` 中 `MaxSessions` 不能为 1（建议至少 10）
- **安装目录**：`~/.claude/remote/` 约 1GB 空间，且不能挂载为 `noexec`
- **Shell**：Bash、Zsh 或 sh
- **网络**：需能访问推理 API 端点

### Windows 主机

- 需要 **Claude Desktop ≥ 2.31226.0**
- 使用 Microsoft 的 OpenSSH Server
- 支持 x64 或 ARM64
- Shell 可以是 cmd.exe、PowerShell 5.1 或 Git Bash
- **限制**：
  - 终端功能受限
  - 历史消息加载可能不完整
  - fork 会话功能受限

## 五、常见问题

### SSH 选项没有出现

1. 确认 Claude Desktop 版本 ≥ 1.40609.0
2. 检查配置文件中的 `sshHostAllowlist` 是否正确添加
3. 确保没有 HKLM 托管策略覆盖本地配置
4. 确认已完全退出并重新启动应用（不是最小化）

### 连接失败

1. **检查 SFTP**：`sftp LAB_PC_4090` 能否正常连接
2. **检查会话数限制**：远程 `/etc/ssh/sshd_config` 中 `MaxSessions` 值
3. **检查网络**：远程机器能否访问推理 API（如果用的是公网 API）
4. **查看日志**：Help → Open Logs Folder，查看 `main.log`

### 已保存的连接消失

配置文件被覆盖或 `sshHostAllowlist` 丢失，重新添加即可。

## 六、通配符规则

`sshHostAllowlist` 支持通配符：

| 写法 | 匹配范围 |
|------|---------|
| `192.168.5.10` | 精确匹配该 IP |
| `*.example.com` | 匹配 `example.com` 及其所有子域 |
| `192.168.5.*` | 匹配该 C 段所有 IP |
| `*` | 匹配任何主机（不推荐） |

匹配是**大小写不敏感**的，会忽略 `user@` 前缀。

## 七、安全注意事项

1. **凭据转发**：SSH 会话会将推理 API 凭据转发到远程主机，只添加你信任的机器
2. **文件凭据不转发**：Bedrock IAM Identity Center、Vertex Google 登录等基于文件的凭据不会转发，这类会话会被拒绝
3. **定期审查**：定期检查 `sshHostAllowlist`，移除不再需要的主机
4. **网段隔离**：优先使用通配符限定内网网段，而不是 `["*"]`

## 八、参考文档

- [SSH remote sessions in Claude Desktop on 3P](https://claude.com/docs/third-party/claude-desktop/ssh-remote-sessions)
- [Configuration reference](https://claude.com/docs/third-party/claude-desktop/configuration)
- [Desktop application - Claude Code Docs](https://code.claude.com/docs/en/desktop)

---

**版本信息**  
本文档记录于 2026-10，测试环境版本为 v2.42304.0。Claude Desktop 版本和界面可能变化，请以官方文档为准。  
SSH remote sessions 功能自 v1.40609.0 起在 3P 部署中作为 beta 特性提供

