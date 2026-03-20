# Phaser Custom Spike

隔离实验，用于验证 `phaser-core + 最小缺口补齐` 是否能显著压缩 Theater 引擎体积，
且不影响主线构建配置。

## Files

- `entry.cjs`
  - 基于 `phaser/src/phaser-core.js`
  - 补齐当前 Theater 明确依赖的 `Math`、`Loader.Events`、`GameObjects.Container`
- `phaser3spectorjs-stub.cjs`
  - 仅供实验配置使用，用来压住 `phaser3spectorjs` 解析噪声
- `vite.config.ts`
  - 只在实验构建里把裸 `phaser` alias 到 `entry.cjs`
- `vitest.config.ts`
  - 只在实验测试里复用同一 alias

## Commands

```bash
cd frontend
npx tsc --noEmit -p tsconfig.app.json
npm run test:spike:phaser-custom
npm run build:spike:phaser-custom
```

## Current Result

最近一次实验结论：

- `tsc`: pass
- targeted spike tests: pass
- spike build: pass
- `phaser` chunk:
  - baseline: `1202.19 kB` / gzip `328.41 kB`
  - spike: `713.91 kB` / gzip `201.06 kB`

## Guardrail

- 不要把这里的 alias 直接搬到主线 `vite.config.ts` / `vitest.config.ts`
- 先补真实浏览器 smoke，再决定是否值得产品化
