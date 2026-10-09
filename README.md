# Koishi CNB 报障助手

[![npm version](https://img.shields.io/npm/v/koishi-plugin-cnb-bot)](https://www.npmjs.com/package/koishi-plugin-cnb-bot)
[![npm downloads](https://img.shields.io/npm/dm/koishi-plugin-cnb-bot)](https://www.npmjs.com/package/koishi-plugin-cnb-bot)
[![Koishi v4](https://img.shields.io/badge/Koishi-%5E4.18.0-514997)](https://koishi.chat/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Koishi 插件版 CNB 报障助手。用户发送 `debug [故障描述]` 后上传一个常见日志或诊断文件；插件把原始文件上传到 CNB、创建 Issue、请求配置好的 NPC 分析，并把已验证的分析结果发回会话。

- [AstrBot CNB 报障助手](https://github.com/HarcoChen/astrbot_plugin_cnb_bot)：适用于 AstrBot 的日志提交与 CNB 分析插件。

## 配置

| 配置 | 说明 |
| --- | --- |
| `cnb_repository` | CNB 仓库路径，例如 `group/repo`。必填 |
| `cnb_token` | CNB 令牌，需要 `repo-issue:rw`、`repo-notes:r`、`repo-notes:rw` 权限 |
| `group_whitelist` | 启用功能的群号；留空时所有群都不启用 |
| `private_whitelist` | 私信用户白名单；留空时允许所有人私信报障 |
| `npc_mention` | Issue 评论中用于触发 NPC 的提及文本，默认 `@CodeBuddy` |
| `npc_author_ids` / `npc_author_usernames` | NPC 评论作者白名单。至少配置一项，并核对仓库中实际的作者 ID 或 username |
| `assistant_name` | 在聊天中显示的分析助手名称 |
| `log_location_hint` | 开始报障时附加的日志位置说明 |
| `log_wait_minutes` | 等待日志上传时间，默认 10 分钟 |
| `analysis_wait_minutes` | 等待 NPC 分析时间，默认 20 分钟 |
| `recovery_confirm_minutes` | 等待用户确认问题是否解决，默认 30 分钟 |
| `max_log_file_mib` | 单个日志文件大小上限，默认 20 MiB |
| `poll_interval_seconds` | NPC 评论轮询间隔，默认 10 秒 |
| `issue_check_interval_seconds` | 用户确认阶段的 Issue 检查间隔，默认 30 秒 |
| `cnb_api_endpoint` / `cnb_web_endpoint` | CNB API 和网页地址，必须使用 HTTPS |
| `file_url_host_allowlist` | 可选的日志下载域名白名单；即使留空，也会拒绝内网和保留地址 |

其余配置用于控制结果发送重试次数、发送超时和历史保留天数。

## 指令

| 指令 | 作用 |
| --- | --- |
| `debug [描述]` | 开始报障，描述作为 Issue 标题 |
| `debug status` | 查看当前报障进度 |
| `debug analyze` | 补充信息后请求 NPC 重新分析 |
| `debug resolve` | 确认问题已解决并关闭 Issue |
| `debug cancel` | 取消当前报障；已创建的 Issue 保留 |
| `debug help` | 查看指令说明 |

分析中或等待确认时，可以继续上传 `.zip`、`.log`、`.json`、`.txt`、`.yaml`、`.yml`、`.xml`、`.csv` 等常见诊断文件，插件会把追加日志作为附件评论写入同一个 Issue。每条消息发送一个文件；补充完后发送 `debug analyze` 请求重新分析。

Issue 创建后，在群里 @机器人并附上文字，或在私信中直接发送文字，可以把补充说明写入 Issue 评论。每个用户在同一个群或私信会话中同时只能有一个未结束的报障。

## 隐私与文件处理

上传的日志原样提交给 CNB。插件不解压、不读取、不扫描，也不脱敏日志；故障描述作为 Issue 标题，用户主动发送的补充文字会作为评论提交。开始报障时会提醒用户确认文件不含隐私内容。

日志下载接受常见日志和诊断格式（`.zip`、`.log`、`.json`、`.txt`、`.yaml`、`.yml`、`.xml`、`.csv`、`.conf`、`.ini`、`.tar`、`.gz` 等），受大小上限约束。HTTP(S) 下载会检查每次重定向、域名白名单和解析到的 IP 地址，拒绝本机、内网及保留地址。临时文件存放在 Koishi 项目目录下的 `data/koishi-plugin-cnb-bot/`，CNB 返回附件上传成功后立即删除插件的本地副本，无需等待 Issue 创建或分析完成；报障结束时也会清理暂存文件。适配器提供的源文件不由插件删除。

上传时保留原始文件名；名称缺失时尝试从下载响应或链接获取，无法确定则提示重新上传，不会将文件默认命名为 `log.zip`。

报障状态存储在 Koishi 配置的数据库中，其中包括平台、机器人、群/频道、用户、Issue 编号和处理状态。插件不读取群聊历史；只有发起报障后用户主动提交的描述、日志附件和补充文字会进入 CNB。插件重启后会恢复未完成的流程。CNB Issue 创建请求若因连接中断而无法确认，插件会暂停并提示管理员按追踪编号核对，避免重复创建。

后台按下一次处理时间唤醒，只查询到期任务；没有定时任务时停止轮询。处理时间和状态字段建有数据库索引，历史清理直接由数据库批量执行。并发查询同一 Issue 的评论会共用一次请求。状态更新只写变动字段，并发冲突重试复用最新读取结果；分析回复通过一次遍历匹配，不为整页评论创建排序数组。下载和上传均使用流式传输，避免将整份日志载入内存。

## 开发

```sh
npm install
npm run build
```
