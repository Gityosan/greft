# Graft — Claude Code 引き継ぎドキュメント

## このプロジェクトとは

言語横断の無損失バイナリシリアライザ。  
JS / Python / Ruby / Go / Rust / C++ 間で値を転送する。

**主なユースケース**: `zod-v4-mocks` で生成した JS のモックデータを  
他言語（Rust/Go 等）のテストフィクスチャとしてそのまま使う。

**無損失の定義（非対称）**:
- エンコーダ → ファイル: 完全無損失
- ファイル → 他言語デコーダ: best-effort（言語が表現できない型はフォールバック、`spec/FORMAT.md` §5 に明記）

---

## リポジトリ構成

```
graft/
  spec/
    FORMAT.md          ← バイナリ仕様の単一の真実のソース
    golden/            ← 各型の期待バイナリ (.bin) ※タスク3で生成
  js/
    src/
      buffer.ts        ← LEB128 / ZigZag / IEEE754(LE) / UTF-8 低レベルプリミティブ
      format.ts        ← タグ定義（FORMAT.md と 1:1 対応）
      encode.ts        ← JS値 → バイナリ
      decode.ts        ← バイナリ → JS値（2パス、循環参照対応）
      index.ts         ← barrel export
    test/
      roundtrip.ts     ← 既存テスト（28件パス済み）
    scripts/           ← タスク3で追加
    tsconfig.json
    package.json
  conformance/         ← タスク4で追加
  CLAUDE.md            ← このファイル
  README.md
```

---

## 仕様文書との関係（最重要）

**`spec/FORMAT.md` が単一の真実のソース。**

- `js/src/format.ts` は FORMAT.md の TypeScript 実装であり、常に同期していること
- 仕様を変更するときは **FORMAT.md を先に更新** し、次に format.ts を変更する
- タグの数値が FORMAT.md と format.ts でずれていたら FORMAT.md を正とする

---

## 現在の実装状態

### 完了済み

- `buffer.ts`: ByteWriter / ByteReader（uvarint, svarint, f64, str）
- `format.ts`: Tag 0〜31（Null〜WeakSet）、KeyKind、MAGIC(`GRF1`)、VERSION
- `encode.ts`: 上記タグのエンコード、循環参照・共有参照・WeakProvider 対応
- `decode.ts`: 上記タグのデコード、2パス参照解決
- `test/roundtrip.ts`: 28件テスト（全パス）

### これから実装するタスク（下記順番どおりに実行）

---

## タスク1: Date タグの追加

### 仕様（FORMAT.md §5.3 参照）

```
Tag.Date = 40
payload: svarint(unix_ms) + svarint(sub_ms_nanos)
```

- `unix_ms`: `date.getTime()` の値（符号付きミリ秒）
- `sub_ms_nanos`: ミリ秒内のナノ秒オフセット 0–999999（JS は常に 0）

### 変更ファイル

**format.ts**
```typescript
// Tag enum に追加
Date = 40,
```

**encode.ts** — `buildObject` 内の instanceof チェックの先頭に追加
```typescript
if (obj instanceof Date) {
  const ms = obj.getTime();
  return leaf((w) => {
    w.u8(Tag.Date);
    w.svarint(BigInt(ms));
    w.svarint(0n); // sub_ms_nanos: JS は常に 0
  });
}
```

**decode.ts** — case に追加
```typescript
case Tag.Date: {
  const ms = r.svarint();
  r.svarint(); // sub_ms_nanos: JS では無視
  return { value: new Date(Number(ms)) };
}
```

### テスト（roundtrip.ts に追記）

以下をすべて検証すること:
- `new Date(0)` — epoch
- `new Date(-1)` — 紀元前方向（負のミリ秒）
- `new Date("2024-01-15T12:00:00.000Z")` — 通常の日付
- `new Date(253402300799999)` — 遠未来
- identity: `const d = new Date(); const root = { a: d, b: d }; out.a === out.b`

---

## タスク2: ArrayBuffer / TypedArray タグの追加

### 仕様（FORMAT.md §5.1, §5.4 参照）

```
Tag.Bytes = 41
payload: uvarint(byte_length) + raw_bytes
対象: ArrayBuffer のみ（DataView は対象外）

Tag.TypedArray = 42
payload: u8(element_type) + uvarint(byte_length) + raw_bytes
raw_bytes は リトルエンディアン
```

element_type コード（format.ts に ElementType enum として追加）:

```
Uint8 = 0, Uint8Clamped = 1, Uint16 = 2, Uint32 = 3,
Int8 = 4, Int16 = 5, Int32 = 6,
Float32 = 7, Float64 = 8,
BigInt64 = 9, BigUint64 = 10
```

### 変更ファイル

**format.ts**
```typescript
export enum Tag {
  // ... 既存 ...
  Bytes = 41,
  TypedArray = 42,
}

export enum ElementType {
  Uint8 = 0, Uint8Clamped = 1, Uint16 = 2, Uint32 = 3,
  Int8 = 4, Int16 = 5, Int32 = 6,
  Float32 = 7, Float64 = 8,
  BigInt64 = 9, BigUint64 = 10,
}
```

**encode.ts** — `buildObject` 内、`Array.isArray` チェックより**前に**追加

instanceof チェックの順序を厳守（具体的な型 → 抽象的な型の順）:
```
BigInt64Array → BigUint64Array → Float64Array → Float32Array
→ Int32Array → Uint32Array → Int16Array → Uint16Array
→ Int8Array → Uint8ClampedArray → Uint8Array
→ ArrayBuffer
```

各 TypedArray のエンコード:
```typescript
if (obj instanceof BigInt64Array) {
  return encodeTypedArray(ElementType.BigInt64, obj);
}
// ... 他の TypedArray ...
if (obj instanceof ArrayBuffer) {
  const bytes = new Uint8Array(obj);
  return leaf((w) => {
    w.u8(Tag.Bytes);
    w.uvarint(bytes.length);
    w.bytes(bytes);
  });
}
```

ヘルパー関数:
```typescript
function encodeTypedArray(et: ElementType, arr: ArrayBufferView): Node {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return leaf((w) => {
    w.u8(Tag.TypedArray);
    w.u8(et);
    w.uvarint(bytes.length);
    w.bytes(bytes);
  });
}
```

**decode.ts**

```typescript
case Tag.Bytes: {
  const len = r.uvarintNum();
  const raw = r.bytes(len);
  return { value: raw.buffer.slice(raw.byteOffset, raw.byteOffset + len) };
}
case Tag.TypedArray: {
  const et = r.u8();
  const len = r.uvarintNum();
  const raw = r.bytes(len);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + len);
  const ctors: Record<number, new (b: ArrayBuffer) => ArrayBufferView> = {
    [ElementType.Uint8]: Uint8Array,
    [ElementType.Uint8Clamped]: Uint8ClampedArray,
    [ElementType.Uint16]: Uint16Array,
    [ElementType.Uint32]: Uint32Array,
    [ElementType.Int8]: Int8Array,
    [ElementType.Int16]: Int16Array,
    [ElementType.Int32]: Int32Array,
    [ElementType.Float32]: Float32Array,
    [ElementType.Float64]: Float64Array,
    [ElementType.BigInt64]: BigInt64Array,
    [ElementType.BigUint64]: BigUint64Array,
  };
  const Ctor = ctors[et];
  if (!Ctor) throw new Error("unknown element type: " + et);
  return { value: new Ctor(buf) };
}
```

### テスト（roundtrip.ts に追記）

全 TypedArray 型をテストすること:
```typescript
// ArrayBuffer
const ab = new ArrayBuffer(4);
new Uint8Array(ab).set([1,2,3,4]);
// → decode 後 ArrayBuffer で同じバイト列

// 各 TypedArray
new Uint8Array([0, 127, 255])
new Int16Array([-32768, 0, 32767])
new Float64Array([1.1, NaN, -0, Infinity])
new BigInt64Array([0n, -1n, 9223372036854775807n])
// → それぞれ同じ型・同じ値で復元されること

// 空の TypedArray
new Uint8Array([])
```

---

## タスク3: golden ファイル生成スクリプト

`js/scripts/gen-golden.ts` を作成する。

### 出力先

```
spec/golden/
  primitive.bin     # null/undefined/bool/int/float/NaN/-0/±Infinity
  bigint.bin        # 正・負・ゼロ
  string.bin        # 空文字/ASCII/UTF-8マルチバイト/絵文字
  date.bin          # epoch/負/通常/遠未来
  bytes.bin         # ArrayBuffer
  typedarray.bin    # 全 ElementType
  map_set.bin       # Map/Set（オブジェクトキーを含む）
  symbol.bin        # Registered/Unique/WellKnown
  cycles.bin        # 循環参照・共有参照
```

### 各 .bin の構造

1つの .bin ファイル = 1つの Object ノードを root とし、  
各テストケースをキーとして持つ。例:

```typescript
encode({
  epoch: new Date(0),
  negative: new Date(-1),
  normal: new Date("2024-01-15T12:00:00.000Z"),
})
```

### スクリプト

```typescript
// js/scripts/gen-golden.ts
import { writeFileSync, mkdirSync } from "fs";
import { encode } from "../src/index.js";

mkdirSync("../spec/golden", { recursive: true });

writeFileSync("../spec/golden/date.bin", encode({
  epoch: new Date(0),
  negative: new Date(-1),
  normal: new Date("2024-01-15T12:00:00.000Z"),
  far_future: new Date(253402300799999),
}));

// ... 他のファイルも同様
```

実行コマンド: `cd js && npx tsx scripts/gen-golden.ts`

---

## タスク4: conformance ハーネスの骨組み

`conformance/README.md` を作成する。内容:

1. golden ファイルの読み方（バイナリ仕様への参照）
2. 他言語実装が準拠テストを通すための手順
3. 将来追加する言語実装のディレクトリ規約

実装コードは不要。ドキュメントのみ。

---

## 実装上の制約（すべてのタスクで守ること）

- **V8非依存**: `structuredClone` / `vm` / `Buffer`（Node.js固有）は使わない
- **外部依存ゼロ**: `js/` の runtime 依存なし（devDeps に `tsx` / `typescript` のみ）
- **FORMAT.md が正**: タグ値が FORMAT.md と format.ts でずれたら FORMAT.md に合わせる
- **既存テスト保護**: 全タスク完了後も既存28件を含む全テストが `0 failed` で終わること

---

## テスト実行

```bash
cd js && npx tsx test/roundtrip.ts
```

タスク追加後は全テストを回してから次のタスクへ進むこと。

---

## 作業開始前の確認事項

1. `js/src/format.ts` の MAGIC が `GRF1`（`0x47 0x52 0x46 0x31`）になっているか確認
2. `npx tsc --noEmit` がエラーなしで通ることを確認
3. `npx tsx test/roundtrip.ts` が 28 passed, 0 failed で終わることを確認

これらが通っていなければ、タスクに入る前に修正すること。
