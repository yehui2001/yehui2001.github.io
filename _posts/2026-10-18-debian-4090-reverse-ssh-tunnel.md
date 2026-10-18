---
title: Debian 4090 服务器内网穿透实战：基于腾讯云公网服务器的反向 SSH 隧道
description: 使用反向 SSH 隧道，通过腾讯云公网服务器访问内网 Debian 4090，并配置密钥认证、VS Code Remote-SSH 与 systemd 自动重连。
categories: [技术实践, Linux, 服务器]
---

![image.png](https://raw.githubusercontent.com/yehui2001/imgbed/main/20261018202838072.png)

## 1. 背景与需求

实验室有一台搭载 RTX 4090 GPU 的 Debian 服务器，主要用于深度学习训练和科研实验。由于实验室服务器位于内网环境，没有方便使用的公网 SSH 入口，因此无法在校外直接通过 SSH 或 VS Code Remote-SSH 访问。



为了解决这个问题，我准备了一台具有公网 IP 的腾讯云 Debian 服务器作为跳板机，通过 **Reverse SSH Tunnel（反向 SSH 隧道）**，将实验室服务器的 SSH 服务映射到腾讯云服务器上。

最终实现以下目标：

- 在校外通过公网 IP 直接连接实验室服务器。
- 使用 SSH 密钥认证，避免开启密码登录。
- 通过 VS Code Remote-SSH 远程开发。
- 后续配置 systemd，实现隧道开机自启和断线自动重连。


本文记录从环境检查、密钥配置到隧道建立、故障排查的完整过程。

## 2. 网络架构与工作原理

### 2.1 网络拓扑

假设环境如下：

| 设备      | 操作系统       | 地址或端口                | 作用              |
| ------- | ---------- | -------------------- | --------------- |
| 本地电脑    | Windows 11 | 本地网络                 | SSH 客户端、VS Code |
| 腾讯云服务器  | Debian     | `CLOUD_PUBLIC_IP:22` | 公网跳板机           |
| 腾讯云隧道入口 | Debian     | `0.0.0.0:4090`       | 接收外部 SSH 连接     |
| 实验室服务器  | Debian     | `127.0.0.1:4090`     | 实际 SSH 服务       |
⚠️注意这里隧道入口和服务器SSH的端口不要求完全一样，可以自定义。
其中，`CLOUD_PUBLIC_IP` 需要替换成腾讯云服务器的真实公网 IP。

整体连接过程如下：

```
Windows 电脑
    |
    | SSH 连接 CLOUD_PUBLIC_IP:4090
    v
腾讯云公网服务器
    |
    | 反向 SSH 隧道转发
    v
实验室 Debian 服务器
    |
    | SSH 服务监听 TCP 4090
    v
完成远程登录
```

### 2.2 为什么使用反向 SSH 隧道？

传统 SSH 连接通常要求客户端能够直接访问目标服务器的 SSH 端口。如果实验室服务器位于内网，外部网络无法直接访问该服务器，就需要额外配置公网入口。

反向 SSH 隧道的思路是：

1. 由实验室服务器主动连接腾讯云公网服务器。
2. 在腾讯云服务器上创建一个远程监听端口。
3. 将发往该端口的 TCP 流量通过已经建立的 SSH 连接转发回实验室服务器。
4. 外部客户端访问腾讯云公网 IP 和指定端口，即可连接实验室服务器。

这种方式不需要在实验室路由器上配置端口映射，也不要求实验室服务器本身拥有公网 IP。

需要注意：反向隧道解决的是网络可达性问题，并不会自动完成目标服务器的 SSH 用户认证。

## 3. 第一步：检查实验室服务器的 SSH 服务

首先登录实验室 Debian 服务器，检查 SSH 服务实际监听的端口：

```
sudo ss -lntp | grep sshd
```

我的实验室服务器输出中包含：

```
LISTEN ... 0.0.0.0:4090 ... users:(("sshd",...))
LISTEN ... [::]:4090 ... users:(("sshd",...))
```

这说明 SSH 服务监听 TCP 4090 端口，并且可以接收发往对应网络接口的连接。

因此，本文统一使用 4090 作为实验室 SSH 服务端口。

如果你的服务器 SSH 服务实际监听的是 22 端口，那么后续命令中指向实验室 SSH 服务的目标端口应改为 22。

## 4. 第二步：为反向隧道创建专用 SSH 密钥

为了让实验室服务器能够主动登录腾讯云，需要先配置 SSH 公钥认证。

建议为隧道单独生成一对密钥，避免直接复用日常开发密钥。

### 4.1 在实验室服务器生成密钥

以下命令必须在**实验室 4090 服务器**上执行，而不是在腾讯云服务器上执行。

```
mkdir -p ~/.ssh
chmod 700 ~/.ssh

ssh-keygen -t ed25519 \
  -f ~/.ssh/id_ed25519_tunnel \
  -N "" \
  -C "lab4090-to-tencent"
```

生成两个文件：

```
~/.ssh/id_ed25519_tunnel
~/.ssh/id_ed25519_tunnel.pub
```

其中：

- `id_ed25519_tunnel`：私钥，用于实验室服务器登录腾讯云。
- `id_ed25519_tunnel.pub`：公钥，需要添加到腾讯云的授权列表。


这里使用空口令是为了便于后续 systemd 无人值守地建立隧道。代价是私钥文件一旦泄露，就可能被直接使用，因此必须限制文件权限并保护好服务器账户。

查看公钥：

```
cat ~/.ssh/id_ed25519_tunnel.pub
```

复制完整的一行公钥。

### 4.2 将公钥添加到腾讯云服务器

通过腾讯云 TAT 登录公网服务器，确保云服务器上已经存在用于连接的 Linux 用户，例如 `yehui`。

然后执行：

```
sudo install -d -m 700 -o yehui -g yehui \
  /home/yehui/.ssh

sudo touch /home/yehui/.ssh/authorized_keys

sudo chown yehui:yehui \
  /home/yehui/.ssh/authorized_keys

sudo chmod 600 \
  /home/yehui/.ssh/authorized_keys

sudo nano /home/yehui/.ssh/authorized_keys
```

将实验室服务器刚才生成的公钥追加到文件末尾，单独占一行。

注意保留已有公钥，不要覆盖原有的授权记录。

### 4.3 测试密钥认证

回到实验室服务器执行：

```
ssh -i ~/.ssh/id_ed25519_tunnel \
  -o IdentitiesOnly=yes \
  yehui@CLOUD_PUBLIC_IP
```

首次连接可能出现 SSH 主机指纹确认提示。应先核实腾讯云服务器的主机指纹，再决定是否接受。

如果能够正常登录腾讯云，说明实验室服务器到云服务器的 SSH 密钥认证已经打通。

退出远程会话：

```
exit
```

**关键点：隧道密钥的私钥保留在实验室服务器上，公钥添加到腾讯云服务器。不要把私钥复制到腾讯云。**

## 5. 第三步：配置腾讯云 SSH 服务，允许公网监听

这是整个配置过程中容易忽略的一步。

默认情况下，OpenSSH 的反向转发端口通常只监听远程服务器的回环地址，也就是 `127.0.0.1`。

这种情况下，腾讯云服务器本机能够访问隧道入口，但外部 Windows 电脑无法直接通过公网 IP 连接该端口。

如果希望直接连接：

```
CLOUD_PUBLIC_IP:4090
```

就需要允许 SSH 服务使用指定的非回环监听地址。

### 5.1 检查当前配置

在腾讯云服务器上执行：

```
sudo sshd -T | grep -E \
  '^(gatewayports|allowtcpforwarding)'
```

其中：

- `gatewayports` 决定远程转发端口是否可以监听非回环地址。

- `allowtcpforwarding` 决定 SSH 服务是否允许 TCP 转发。


对于本文采用的直接公网连接方案，需要确认有效配置允许指定监听地址，并允许 TCP 转发。

### 5.2 修改 SSH 配置

编辑配置文件：

```
sudo nano /etc/ssh/sshd_config
```

设置：

```
GatewayPorts clientspecified
```

如果 `AllowTcpForwarding` 被显式设置为 `no`，还需要根据安全策略调整为允许转发，例如：

```
AllowTcpForwarding yes
```

注意检查 `/etc/ssh/sshd_config.d/` 中的配置片段，以及 `sshd -T` 输出的最终生效配置，避免配置被其他规则覆盖。

保存后执行：

```
sudo sshd -t
sudo systemctl reload ssh
```

第一条命令用于检查 SSH 配置语法。只有检查通过后才重新加载服务。

建议保留当前 TAT 管理会话，避免配置错误时失去管理入口。

## 6. 第四步：建立反向 SSH 隧道

现在可以正式建立反向 SSH 隧道。

**这条命令必须在实验室 4090 服务器上执行。**

```
ssh -NT \
  -i ~/.ssh/id_ed25519_tunnel \
  -o IdentitiesOnly=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R 0.0.0.0:4090:127.0.0.1:4090 \
  yehui@CLOUD_PUBLIC_IP
```

### 6.1 理解 `-R` 参数

核心配置是：

```
-R 0.0.0.0:4090:127.0.0.1:4090
```

它的格式是：

```
-R [远程监听地址:]远程端口:目标地址:目标端口
```

各部分的含义如下：

|参数|含义|
|---|---|
|`0.0.0.0`|腾讯云服务器上监听所有 IPv4 网络接口|
|第一个 `4090`|腾讯云服务器上的隧道入口端口|
|`127.0.0.1`|实验室服务器本机的回环地址|
|第二个 `4090`|实验室 SSH 服务实际监听的端口|

因此，访问腾讯云服务器的公网 4090 端口，流量就会通过 SSH 隧道转发到实验室服务器的 SSH 4090 端口。

其他选项的作用：

- `-N -T`：不执行远程命令、不分配终端，只建立隧道。

- `ExitOnForwardFailure=yes`：远程端口转发创建失败时退出。

- `ServerAliveInterval=30`：每隔 30 秒发送一次存活检测。

- `ServerAliveCountMax=3`：连续检测无响应时断开连接。

- `IdentitiesOnly=yes`：限制 SSH 使用指定的身份密钥。


执行后，如果没有出现错误，并且终端一直停留在那里，通常说明 SSH 正在保持连接。

此时不要关闭该终端，否则隧道会随 SSH 连接结束而关闭。

## 7. 第五步：检查腾讯云上的隧道监听

保持实验室服务器上的隧道运行。

通过 TAT 登录腾讯云，执行：

```
sudo ss -lntp | grep ':4090'
```

理想情况下可以看到类似输出：

```
LISTEN ... 0.0.0.0:4090 ... users:(("sshd-session",...))
```

如果输出是：

```
127.0.0.1:4090
```

说明该端口仍然只绑定在回环地址上，需要检查：

1. 隧道命令是否使用了 `-R 0.0.0.0:4090:...`。

2. 腾讯云的 `GatewayPorts` 是否已经生效。

3. 是否存在其他 SSH 配置覆盖了当前设置。

4. 是否有旧隧道仍占用端口。


如果没有任何输出，则检查隧道是否已经断开，以及 SSH 日志中是否存在转发失败信息。

这里需要区分两个概念：

- **端口正在监听**：说明隧道入口已经创建。

- **SSH 能够成功登录**：还需要目标服务器接受客户端的身份认证。


端口监听成功，并不等于 SSH 用户认证必然成功。

## 8. 第六步：开放腾讯云安全组端口

⚠️这一点很重要，很多云服务器厂商为了安全考虑都需要手动去打开端口。

即使腾讯云上的 4090 已经监听在 `0.0.0.0`，公网流量仍可能被云安全组或系统防火墙拦截。

进入腾讯云控制台，找到云服务器关联的安全组，在入站规则中添加：

|配置项|设置|
|---|---|
|协议|TCP|
|端口|4090|
|来源|自己的公网 IP `/32`|
|策略|允许|

例如，若客户端公网 IP 为 `203.0.113.10`，来源应设置为 `203.0.113.10/32`。这里的地址仅用于演示。

不要直接将来源设置为 `0.0.0.0/0`，除非确实需要允许整个互联网访问。
如果系统启用了 UFW、nftables 等防火墙，也要检查对应的入站规则。
腾讯云 TCP 22 端口则用于实验室服务器主动连接腾讯云建立隧道。它与公网访问实验室 SSH 所使用的 4090 端口用途不同。

## 9. 第七步：配置 Windows SSH 公钥认证

完成端口转发后，还需要让 Windows 电脑能够通过实验室服务器自己的 SSH 认证。
注意：腾讯云与实验室服务器是两台独立的机器，各自维护自己的 `authorized_keys`。

### 9.1 查看 Windows 公钥指纹

在 Windows PowerShell 执行：

```
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

输出类似：

```
256 SHA256:xxxxxxxxxxxxxxxx yehui (ED25519)
```

这是公钥指纹，不是公钥本身。

### 9.2 检查实验室服务器授权文件

在实验室服务器执行：

```
ssh-keygen -lf /home/yehui/.ssh/authorized_keys
```

如果输出的指纹中包含 Windows 公钥对应的 SHA256 指纹，说明授权文件中已经存在这把公钥。

公钥注释名称可以不同，但同一把密钥的 SHA256 指纹应当一致。

如果不存在，就将 Windows 的公钥追加到实验室服务器的：

```
/home/yehui/.ssh/authorized_keys
```

然后确保权限正确：

```
chmod 700 /home/yehui/.ssh
chmod 600 /home/yehui/.ssh/authorized_keys
```

同时确认文件属于对应的 Linux 用户。

## 10. 第八步：从 Windows 直接连接实验室服务器

先在 Windows PowerShell 中测试公网 TCP 端口：

```
Test-NetConnection CLOUD_PUBLIC_IP -Port 4090
```

如果出现：

```
TcpTestSucceeded : True
```

说明 TCP 连接已经可以建立。

接着执行：

```
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" `
  -o IdentitiesOnly=yes `
  -p 4090 yehui@CLOUD_PUBLIC_IP
```

首次连接时，SSH 可能要求确认主机指纹。

由于该端口最终连接到实验室服务器的 SSH 服务，因此这里看到的目标主机指纹应与实验室服务器的 SSH 主机密钥对应。应核对指纹后再接受。

如果成功进入实验室服务器的命令行，说明公网连接、端口转发和 SSH 用户认证已经全部打通。

### 10.1 配置 VS Code Remote-SSH

打开 Windows 上的 SSH 配置文件：

```
%USERPROFILE%\.ssh\config
```

添加：

```
Host LAB_PC_4090_Cloud
    HostName CLOUD_PUBLIC_IP
    User yehui
    Port 4090
    IdentityFile C:\Users\你的用户名\.ssh\id_ed25519
    IdentitiesOnly yes
```

将 `CLOUD_PUBLIC_IP` 和 Windows 用户目录替换为实际值。

随后在 VS Code 中使用 Remote-SSH 连接 `LAB_PC_4090`，即可在本地编辑代码，并在实验室服务器上运行训练任务。

## 11. 配置 systemd，实现自动重连

手动运行的隧道在终端关闭、服务器重启或连接异常中断后可能失效，因此可以使用 systemd 管理隧道进程。

首先，停止之前手动运行的隧道，避免重复占用远程端口。

在实验室服务器创建服务文件：

```
sudo nano /etc/systemd/system/reverse-ssh-tunnel.service
```

写入：

```
[Unit]
Description=Reverse SSH Tunnel to Tencent Cloud
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=yehui
Environment=HOME=/home/yehui

ExecStart=/usr/bin/ssh -NT \
  -i /home/yehui/.ssh/id_ed25519_tunnel \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R 0.0.0.0:4090:127.0.0.1:4090 \
  yehui@CLOUD_PUBLIC_IP

Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

注意：如果编辑器或 systemd 不接受将 `ExecStart` 分成多行，应将该命令写成一整行。这里的反斜杠只用于说明参数之间的关系，不应原样写成多条独立的 `ExecStart`。

保存后执行：

```
sudo systemctl daemon-reload

sudo systemctl enable --now reverse-ssh-tunnel

sudo systemctl status reverse-ssh-tunnel --no-pager
```

查看日志：

```
sudo journalctl -u reverse-ssh-tunnel -n 50 --no-pager
```

如果服务正常运行，并且腾讯云上的 4090 端口重新监听，说明 systemd 已经成功建立隧道。

这里需要注意，`active (running)` 只能证明服务进程处于运行状态；仍应检查日志和远程端口监听情况，确认实际转发成功。

## 12. 实际踩坑记录与排查方法

### 问题一：在错误的服务器上执行隧道命令

实验过程中曾在腾讯云服务器上执行：

```
ssh -i ~/.ssh/id_ed25519_tunnel ...
```

随后出现：

```
Identity file .../id_ed25519_tunnel not accessible
Permission denied (publickey).
```

原因是隧道专用私钥只保存在实验室服务器上，而不是腾讯云服务器上。

**解决方法：反向隧道命令应由实验室服务器发起。**

### 问题二：腾讯云上的端口监听成功，但 SSH 登录失败

在腾讯云上执行：

```
ssh -p 4090 yehui@127.0.0.1
```

出现：

```
Permission denied (publickey).
```

这并不一定意味着隧道失败。该命令是腾讯云本机上的 SSH 客户端发起的连接，它使用的是腾讯云本机可用的客户端密钥，而不是 Windows 上的私钥。

隧道是否建立，应通过端口监听和转发状态检查；用户认证则应使用正确的客户端密钥进行测试。

### 问题三：端口只监听在 127.0.0.1

如果输出为：

```
127.0.0.1:4090
```

说明端口只允许腾讯云本机访问。

如果目标是公网直连，需要使用：

```
GatewayPorts clientspecified
```

并通过：

```
-R 0.0.0.0:4090:127.0.0.1:4090
```

指定监听地址。

### 问题四：公网端口无法访问

即使监听地址已经是：

```
0.0.0.0:4090
```

仍可能因为腾讯云安全组未开放 TCP 4090，导致 Windows 连接超时。

解决思路是依次检查：

1. 实验室隧道进程是否仍在运行。

2. 腾讯云是否监听 `0.0.0.0:4090`。

3. 腾讯云安全组是否允许 TCP 4090。

4. 腾讯云系统防火墙是否拦截流量。

5. Windows 当前网络是否能够访问该端口。


### 问题五：Windows 公钥指纹是否匹配

不要仅凭公钥注释名称判断密钥是否一致。

正确方式是分别计算 Windows 公钥和实验室服务器授权文件中的公钥指纹：

```
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

```
ssh-keygen -lf /home/yehui/.ssh/authorized_keys
```

如果 SHA256 指纹一致，说明对应的公钥已经存在于授权文件中。

## 13. 安全注意事项

本文采用的方案将实验室 SSH 服务通过腾讯云公网端口暴露出来，因此需要特别关注以下事项。

### 13.1 限制安全组来源

腾讯云安全组应尽可能只允许自己的公网 IP 访问 TCP 4090。

如果公网 IP 发生变化，需要更新安全组来源规则。

### 13.2 关闭不必要的密码认证

可以在腾讯云和实验室服务器上分别检查 SSH 的有效认证配置：

```
sudo sshd -T | grep -E \
  '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin)'
```

确认密钥认证可用后，再根据需要设置：

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```

修改后先检查配置语法：

```
sudo sshd -t
```

然后再重新加载 SSH 服务。

需要注意：腾讯云 SSH 服务的密码认证配置控制的是对腾讯云 SSH 服务本身的登录；通过 4090 转发到实验室服务器的连接，其用户认证由实验室服务器上的 SSH 服务决定。

### 13.3 保护隧道私钥

不要将 `id_ed25519_tunnel` 私钥上传到代码仓库，也不要通过聊天工具公开分享。

### 13.4 不要为了方便关闭防火墙

只开放确实需要的端口，并尽可能限制来源 IP。不要为了排障而直接关闭整个服务器的防火墙。

## 14. 总结

整个方案的核心是三个环节：

1. **认证：** 实验室服务器使用专用 SSH 密钥登录腾讯云。

2. **转发：** 通过反向 SSH 隧道，将腾讯云的 4090 端口映射到实验室 SSH 服务。

3. **访问：** Windows 通过腾讯云公网 IP 和端口 4090，使用自己的 SSH 密钥登录实验室服务器。


在排查问题时，建议按以下顺序进行：

```
密钥认证
   ↓
反向隧道建立
   ↓
腾讯云端口监听
   ↓
安全组与防火墙
   ↓
Windows TCP 测试
   ↓
SSH 用户认证
   ↓
VS Code Remote-SSH
```

这样可以将网络可达性问题与 SSH 身份认证问题分开排查，避免在错误的环节反复修改配置。

对于需要长期使用的科研服务器，最后再使用 systemd 管理隧道，可以减少手动重连的操作。
