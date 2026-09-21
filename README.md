# binary-layout-studio-web

二进制布局检查工作台：用 DSL 定义报文布局（整数、位域、数组、选择分支、校验字段），
粘贴十六进制数据即可解析为字段树；在树上编辑字段值后可重新编码回字节流。
前端字段树与字节网格双向定位，解析与编码共享同一份编译计划。

## 快速开始

```bash
npm start          # http://localhost:8080
npm test           # node --test，28 个用例
```

无需任何第三方依赖（Node ≥ 18，前端为原生 ES2019）。

## 布局 DSL

```c
struct Item le {              // le = 小端（默认 be）
  id: u8;
  score: i16;
}

struct Packet be {
  magic:  u16 = 0xABCD;       // 常量：解析校验、编码强制
  hdr:    u16 { version: 4, type: 4, flags: 8 };  // 位域容器（可跨字节）
  count:  u8;
  length: u8;
  items:  Item[count];        // 长度由前字段决定（受限表达式）
  payload: bytes[length];     // 原始字节串
  body:   choose (hdr.type) { // 选择分支
    1: u16;
    2: bytes[2];
    _: u8;                    // 默认分支
  };
  tail:   u16 align(4);       // 对齐填充（相对所属结构体起点）
  crc:    crc16;              // 校验字段：覆盖所属结构体起点到本字段
}
```

- 类型：`u8/u16/u32`、`i8/i16/i32`、`bytes[expr]`、结构体引用、`choose`、`位域容器`
- 校验：`crc16`(CCITT)、`crc32`(IEEE)、`sum8`、`sum16`、`xor8`
- 表达式（受限）：`+ - * / % << >> & | == != < <= > >=`、括号、一元 `- ~`、
  字段引用（含 `hdr.type` 点号下钻）、`len(数组或字节字段)`；只允许引用**此前定义**的字段
- 数组长度若为裸字段引用（如 `Item[count]`），编辑数组后编码会**回填**该长度字段

## 架构

```
src/dsl.js       DSL 词法/语法 → AST
src/compiler.js  语义检查 + 编译计划（plan，不含任何预计算偏移）
src/runtime.js   位流读写；parse/encode 共用 plan 现场推进游标
src/checksum.js  校验算法
src/server.js    零依赖 HTTP：POST /api/compile|parse|encode + 静态文件
public/          字段树 + 字节网格 SPA
```

关键设计：

- **共享计划**：plan 只记录字段序列与表达式 AST；解析和编码各自从 0 开始推进游标，
  因此编辑后重编码不会复用任何旧偏移，依赖长度与校验全部重算（响应中的 `derived` 列出）。
- **最深成功路径**：解析按帧栈推进，失败时由未完成帧拼出部分树，
  返回 `deepest{bit,path}`、错误节点与已完成的兄弟字段。
- **范围安全**：所有读取先越界检查，节点范围恒在输入长度内；零长度数组范围为空（start==end）。
- **编译期检查**：前向引用、重复定义、位域超宽、非法 align、未知类型、
  无界递归（包含环上没有经过可空的数组/choose 边）。

## API

- `POST /api/compile` `{schema}` → `{ok, root, plan}` 或 `{ok:false, compileErrors[]}`
- `POST /api/parse` `{schema, hex}` → `{ok, values, tree, deepest, trailingBytes, checksumFailures[]}`
  或 `{ok:false, error{message,path,bit}, partial, values, deepest}`
- `POST /api/encode` `{schema, values}` → `{ok, hex, derived[]}` 或 `{ok:false, error}`

## 场景覆盖（test/engine.test.js）

| 场景 | 用例 |
| --- | --- |
| 跨字节位域 | be/le 容器 9+7 位，首字段横跨字节边界，编解码互逆 |
| 零长度数组 | 范围为空且不越界，后续字段偏移正确 |
| 联合分支 | 按前字段选分支、默认分支、无匹配报错 |
| 填充 | align(4) 产生填充节点，编码写零 |
| 截断 | 返回最深成功路径 + 部分树（含数组未完成元素） |
| 整数溢出 | 编码期拒绝越界值（含位域子字段） |
| 校验失败 | 解析标记 `checksumFailures`，重编码后恢复 |
| 嵌套结构 | 结构体数组、嵌套端序独立 |
| 编译检查 | 前向引用、无界递归（可空递归放行） |
| 往返一致 | 编码→解析→编码字节相同、逻辑值相同 |
| 编辑重算 | 改数组/字节长度 → 长度字段与校验重算、偏移整体移动 |

## 限制

- 整数位宽 ≤ 32（位域容器同）；表达式中间值须为安全整数
- 字段边界始终字节对齐（位域经容器整体读写）；align(N) 以字节为单位且相对所属结构体起点
- 校验覆盖范围固定为“所属结构体起点 → 校验字段”
