# Code Over SSH

用 VS Code Remote-SSH 连着内网服务器时,让服务器上的程序把「某个文件的路径」发给你的
VS Code 窗口,**编辑器立刻打开这个文件**。

典型用法:你在服务器上跑着 VNC 图形界面,看到一个想编辑的文件,在 VNC 里执行

```bash
cosh /path/to/file
```

本地 VS Code 就会自动打开它(可直接编辑、保存,和平时远程开发一样)。

## 功能

- **一条命令打开文件** —— `cosh <路径>`,无需在 VSCode 里手动翻目录
- **多用户互不干扰** —— 同一台服务器上多个用户各自使用,客户端只会连到自己的 VS Code 窗口
- **多窗口可控** —— 默认发给最近活跃的窗口,也可用 `--all` 一次打开到所有窗口
- **客户端零依赖** —— 单个静态链接的 `cosh` 二进制;也可以用等价的 `cosh.py`(仅需 python3)
- **不改动环境** —— 不新增监听端口,不用改 SSH 配置

## 安装

**1. 安装扩展**(在已通过 SSH 连接远程服务器的 VS Code 窗口中)

下载 Release 中的 `code-over-ssh-1.0.0.vsix`,然后在扩展面板右上角 `...` →
`Install from VSIX...` 选择该文件。

**2. 部署客户端**(放到服务器上,哪个目录都行)

```bash
scp cosh 用户@服务器:~/bin/
ssh 用户@服务器 'chmod +x ~/bin/cosh'
```

> 服务器不是 x86_64,或不想单独传二进制?扩展安装目录里已自带客户端源码:
> `~/.vscode-server/extensions/Exciton00.code-over-ssh-1.0.0/client/`
> —— 可直接 `python3 cosh.py <路径>`(仅需 python3),或 `make` 现场编译 `cosh`。

## 使用

```bash
cosh /path/to/file          # 在最近活跃的 VS Code 窗口打开
cosh --all /path/to/file    # 在本用户所有 VS Code 窗口打开
cosh --list                 # 列出当前已连接的 VS Code 窗口
cosh --host <hostId> /path  # 指定某个窗口打开
cosh --help                 # 全部选项
```

> 注意:`list` 不是子命令,位置参数一律按文件路径处理,查看窗口列表请用 `--list`。

在 VNC 桌面里更顺手的两种接法:

- **文件管理器右键**:加一个自定义动作(GNOME/Nautilus 的 "Scripts" 或自定义动作),命令填 `cosh %F`
- **快捷键 / 终端**:直接敲 `cosh $(realpath 目标文件)`

退出码:`0` 打开成功;`1` 打开失败(原因在标准错误);`2` 本用户当前没有活跃的 VS Code 窗口,或用法错误。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `code_over_ssh.restrictToWorkspace` | `false` | 只允许打开当前工作区文件夹内的文件 |
| `code_over_ssh.notifyOnOpen` | `true` | 通过 `cosh` 打开文件时弹出提示 |
| `code_over_ssh.stateDir` | `~/.code_over_ssh` | 覆盖状态目录 |

## 多用户与安全

- 每个 Unix 用户有独立的状态目录 `~/.code_over_ssh`(权限 `0700`),其中的 socket 与访问令牌为 `0600`
- 客户端只会发现并连接**当前用户**自己的 VS Code 窗口,用户之间天然隔离
- 每次连接都校验随机令牌,校验失败立即断开
- 只接受**已存在的常规文件**;开启 `restrictToWorkspace` 后仅限工作区内
- 每次打开都会写入 `Code Over SSH` 输出面板日志,便于回溯

> 前提:VNC 会话中的 `cosh` 需与 SSH 登录使用**同一个 Unix 用户**。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `no Code Over SSH state dir ...` | 该用户还没有通过 SSH 打开 VS Code 窗口,或扩展未激活 |
| `no registered hosts ...` | VS Code 刚启动,稍等 1~2 秒重试 |
| `ERR bad handshake` | 扩展与客户端版本不一致,或使用了其他用户的状态目录 |
| 在 VNC 里执行后 VS Code 无反应 | 查看输出面板 `Code Over SSH: Show Log`;确认 VNC 与 SSH 用户一致 |
| 想同时打开到多个窗口 | `cosh --all <路径>` |

## License

MIT © 2026 Exciton00
