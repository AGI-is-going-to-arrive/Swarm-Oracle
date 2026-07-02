# SwarmOracle Frontend

React + TypeScript 单页应用，集成 Phaser 3 游戏引擎。

## 开发

```bash
cd frontend
npm install
npm run dev      # 开发服务器 (端口 18928)
```

## 构建

```bash
npm run build    # 含 TypeScript 检查和性能预算
```

## 测试

```bash
npm test         # 单元测试 (vitest)
npx tsc -b       # TypeScript 检查（裸 tsc --noEmit 在本仓不检查任何文件）
npm run lint     # 代码检查
```

## 技术栈

- React 19 + TypeScript
- Phaser 3 (游戏可视化)
- Zustand (状态管理)
- i18next (中英双语)
- Tailwind CSS
