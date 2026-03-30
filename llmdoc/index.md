# SwarmOracle — llmdoc Index

> 项目 AI 上下文入口。目标是让默认读取保持精简：只读当前真值，不读历史流水。

## 默认读取顺序

按需停止，不要机械地把所有文档一次性读完：

1. `overview/project.md`
   产品范围、交付边界、当前剩余问题。
2. `overview/backend.md` 或 `overview/frontend.md`
   只读与你当前任务相关的一侧。
3. `guides/development.md`
   仅在需要运行命令、测试或签收时读取。
4. `reference/api.md` / `reference/config.md`
   仅在查接口或配置时按需读取。

## 文档分层

### 当前真值

- [overview/project.md](overview/project.md)
  产品范围、当前基线、已知边界。
- [overview/backend.md](overview/backend.md)
  后端模块地图、authority、运行时约束。
- [overview/frontend.md](overview/frontend.md)
  前端页面、状态边界、加载与自动化入口。
- [guides/development.md](guides/development.md)
  本地开发、验证、签收命令。
- [reference/api.md](reference/api.md)
  接口与 WebSocket 参考。
- [reference/config.md](reference/config.md)
  环境变量与运行时调参参考。

### 非默认入口

- `implement/*`
  设计基线、历史方案、阶段性评审与归档。
- `progress.md`
  逐轮发现/修复/复验流水。

这两类文档默认不应进入“当前真值”上下文。

## 维护规则

- `overview/*`
  只保留当前真值、边界与入口；不要写 session 级测试流水。
- `guides/*`
  只保留可执行命令和操作约定；不要堆叠历史验证日志。
- `reference/*`
  只保留稳定接口与配置契约；实现细节以源码为准。
- 历史计划、评审、回顾统一放到 `implement/` 或 `progress.md`。
