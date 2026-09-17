# 零依赖：仅用 Node 内置模块与浏览器原生 API

项目把"运行时零第三方依赖"当作硬约束，因此服务端只使用 Node 24 内置的 `node:http`、`node:sqlite`、`node:crypto`；前端只使用浏览器原生 API，以 `<script type="module">` 直接加载，不引入构建步骤、打包器或任何 npm 包。仓库里没有 `dependencies`。

## Considered Options

- **引入包（express + ws + better-sqlite3）**：生态成熟、代码量最小，但直接违背"零依赖"这条硬约束，出局。
- **JSON 文件持久化**：不依赖 `node:sqlite`（该模块目前标记为实验性），但每次写入都要重写整个文件，且需自行实现原子替换以防写入中途损坏。
- **`node:sqlite`（已选）**：单文件数据库、真事务、并发写入安全，代价是依赖一个实验性 API。

## Consequences

- 服务端没有可用的 WebSocket 实现（Node 内置的 `WebSocket` 只是客户端），实时同步因此走 SSE。
- `node:sqlite` 是实验性接口。若未来 Node 调整其 API，改动的面收敛在数据访问层之内。
- 没有构建步骤意味着浏览器直接加载源码：模块拆分要顾及请求数，但省掉了整条工具链。
