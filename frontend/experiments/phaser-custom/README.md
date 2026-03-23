# Phaser Custom Spike

最初用于验证 `phaser-core + 最小缺口补齐` 是否能显著压缩 Theater 引擎体积。
当前这套入口已经被主线 `vite` / `vitest` 复用。

## Files

- `entry.mjs`
  - 基于 `phaser/src/phaser-core.js`
  - 当前主线和实验配置都 alias 到这里，不再走 `entry.cjs`
  - 补齐当前 Theater 明确依赖的 `Math`、`Loader.Events`、`GameObjects.Container`、`GameObjects.Rectangle`
- `phaser3spectorjs-stub.cjs`
  - 仅供实验配置使用，用来压住 `phaser3spectorjs` 解析噪声
- `vite.config.ts`
  - 在实验构建里显式复用同一套 `phaser -> entry.mjs` alias
- `vitest.config.ts`
  - 在实验测试里显式复用同一套 `phaser -> entry.mjs` alias

## Commands

```bash
cd frontend
npx tsc --noEmit -p tsconfig.app.json
npm run test:spike:phaser-custom
npm run build
```

## Current Result

最近一次确认：

- `npm run test:spike:phaser-custom`: `34 passed`
- `npm run build`: pass

## Guardrail

- 主线 `vite.config.ts` / `vitest.config.ts` 已经 alias 到 `entry.mjs`，改这里就是在改主线 Phaser 入口
- 继续把这层控制在 `phaser-core + 最小缺口补齐`；新增缺口先补真实浏览器 smoke，再看是否继续扩
