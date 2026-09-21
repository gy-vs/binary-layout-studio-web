# 二进制布局检查工作台

用声明式布局 DSL 描述二进制格式（整数、位域、数组、联合分支、校验字段），
粘贴十六进制数据即可解析出字段树并与字节范围双向联动；在字段树上编辑后
可重新编码——依赖长度、分支标签与校验值全部重算，偏移不复用旧值。

## 运行

```bash
pip install -r requirements.txt
./run.sh                 # 或: uvicorn backend.app.main:app --reload --port 8000
# 打开 http://127.0.0.1:8000
```

## 测试

```bash
python3 -m pytest tests/ -q     # 101 个用例
```

## 布局 DSL

```c
endian be;                       // 默认端序（int/bits 可用 le/be 后缀覆盖）

struct Packet {                  // 根结构 = 第一个声明的 struct
    hdr:    Header;              // 嵌套结构
    length: u8;
    kind:   u8;
    payload: choice (kind) {     // 联合分支
        case 0: { text: bytes[length]; }          // 长度由先前字段决定
        case 1: { count: u8; samples: [u16le; count]; }
        default: { raw: bytes[2]; }
    };
    align(4);                    // 填充到 4 字节边界；skip(n) 跳过 n 字节
    crc: checksum(u16, crc16, $start);   // 或 $start 换成字段名作为起点
    note: u8 if length > 0;      // 条件字段
    let total = length + 1;      // 派生值（不占位）
}

struct Header {
    magic: u16;
    flags: bits be { mode: 4; encrypted: 1; priority: 7; };  // 跨字节位域
}
```

- 整数：`u8..u64` / `i8..i64`（8 的倍数），端序后缀 `le`/`be`，缺省取 `endian` 声明
- 位域：`bits le|be { 名: 位宽; }`，可跨字节；be 从高位装、le 从低位装
- 数组：`[类型; 长度表达式]`；`bytes[n]` 为原始字节；长度可为 0
- 表达式（受限）：`+ - * / % << >> & | ^ ~ !`、比较、`&& ||`、三元、`len(x)`、
  整数字面量（含 `0x`/`0b`）、字段引用（含 `hdr.ver` 点路径）——无函数调用
- 校验算法：`sum8` `sum16` `xor8` `crc16`(CCITT-FALSE) `crc32`(IEEE)

## 编译期检查

- **前向非法引用**：表达式只能引用本结构体内声明在前的名字（choice 分支体内
  可见外层先前字段，分支内字段不外泄）
- **递归无界**：结构体引用图中任何环（直接/间接/经数组/经 choice）直接拒绝
- 重复名字、未知类型/算法、非法位宽、重复 case、校验位宽不足等

## 解析 / 编码语义

- 解析与编码共享同一份编译计划（`compiler.Plan`）
- 解析失败返回**最深成功路径**：部分字段树 + `error.path`（如 `["items","[1]"]`），
  已完成的字段与值保留；所有字节范围钳制在输入长度内
- 校验不匹配不中止解析，记入 `issues` 并在树上标记 `checksum.ok=false`
- 编码从值树整体重走计划：数组/字节长度按实际元素数回写计数字段
  （`fix_lengths`），分支标签同理回写；校验按编码后的字节重算
  （`fix_checksums`）；偏移全部重新产生
- 编码结果自动回读自检，返回全新字段树与归一化值；
  `encode(parse(x).values)` 再解析得到同一逻辑值

## API

| 端点 | 说明 |
| --- | --- |
| `POST /api/parse` | `{layout, hex}` → `{ok, tree, values, error, issues, length}` |
| `POST /api/encode` | `{layout, values, fix_checksums?, fix_lengths?}` → `{ok, hex, tree, values, issues}` |
| `GET /api/example` | 内置示例（布局 + 由引擎生成的报文） |

## 目录

```
backend/app/   expr.py(受限表达式) dsl.py(词法/语法) compiler.py(计划+检查)
               engine.py(解析/编码) checksums.py main.py(API)
frontend/      index.html app.js style.css   （字段树 ↔ 字节双向定位）
tests/         编译/解析/编码/往返/API 共 101 例
```
