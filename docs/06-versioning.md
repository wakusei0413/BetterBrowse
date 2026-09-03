# BetterBrowse 版本号地图

项目有五套互不替代的版本号。修改前先按下表判断，不要因为发布版本变化而连带 bump 数据或协议修订。

| 版本号 | 唯一事实源 | 当前值 | 管辖范围 | 何时递增 |
|---|---|---:|---|---|
| Manifest 软件版本 | `BetterBrowse/manifest.json` | `1.0.0` / Milestone 4 | 用户可见发布包 | 发布软件、功能或修复版本时；不代表协议兼容性 |
| `API_VERSION` | `src/constants/api-version.js` | 1 | 扩展、Native Host、桥接客户端的消息契约 | 跨组件不兼容变更；UI 或普通修复不涨 |
| `LOCAL_DATA_SCHEMA_REVISION` | `src/constants/config.js` | 10 | 业务数据迁移边界 | 数据形状不兼容时，并在 `migration.js` 增加幂等迁移块 |
| `INDEXED_DB_SCHEMA_REVISION` | `src/core/storage/indexed-db.js` | 11 | IndexedDB 对象仓储与索引 | 新增/改变对象仓储或索引，并在 `onupgradeneeded` 建表/索引；只能涨不能降 |
| `FULL_BACKUP_FORMAT_REVISION` | `src/constants/format-revisions.js` | 1 | 全量备份 JSON 持久化格式 | 备份格式不兼容时；UI 和 Manifest 不涨它 |

**血的教训：** `INDEXED_DB_SCHEMA_REVISION` 只能单调递增。裸抬高版本号却不在 `onupgradeneeded` 建表，会造出“有库无表”的空库，之后必须再抬一次才能触发修复。

## 我要做 X，该动哪个

| 事情 | 应修改 |
|---|---|
| 改 UI 样式或文案 | Manifest 软件版本（若要发布）；不动 API/数据修订 |
| 改扩展与宿主/客户端消息契约 | `API_VERSION`，并同步协议文档与客户端 |
| 改业务数据字段或迁移形状 | `LOCAL_DATA_SCHEMA_REVISION` + `migration.js` 幂等迁移 |
| 给 IndexedDB 加对象仓储或索引 | `INDEXED_DB_SCHEMA_REVISION` + `onupgradeneeded` 建表/索引 |
| 改备份 JSON 结构 | `FULL_BACKUP_FORMAT_REVISION` + 兼容读取/迁移 |
| 普通 bug 修复、测试或文档更新 | 通常不动上述修订号 |

`deno task verify` 会检查唯一事实源、迁移目标、IndexedDB 建表路径、Manifest 格式与 API/软件版本解耦；它不能替维护者判断一次变更是否真的“不兼容”。
