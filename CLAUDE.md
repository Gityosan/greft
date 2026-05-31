# Graft — Claude Code 引き継ぎドキュメント

## このプロジェクトとは

言語横断の無損失バイナリシリアライザ。JS で値をエンコードし、他言語
（Python / Rust / Go / …）でデコードして使う。

**主なユースケース**: `zod-v4-mocks` で生成した JS のモックデータを、他言語の
テストフィクスチャとしてそのまま使う。

**無損失の定義（非対称）**:
- エンコーダ → ファイル: 完全無損失（その言語が表現できる値すべて）
- ファイル → 他言語デコーダ: best-effort（表現できない型はフォールバック、`spec/FORMAT.md` §5 に明記）

---

## リポジトリ構成

```
graft/
  spec/
    FORMAT.md          ← バイナリ仕様の単一の真実のソース
    golden/            ← 期待バイナリ (.bin) + 言語中立の期待値 (.meta.json)。13ベクタ
  js/                  ← リファレンス実装（公開対象のライブラリ）
    src/
      buffer.ts        ← LEB128 / ZigZag / IEEE754(LE) / UTF-8 低レベルプリミティブ
      format.ts        ← タグ定義（FORMAT.md と 1:1）
      encode.ts        ← JS値 → バイナリ（intern + heap、循環/共有/WeakProvider/拡張型）
      decode.ts        ← バイナリ → JS値（遅延メモ化解決、安全化リミット）
      extension.ts     ← TypeExtension（カスタム型レジストリ）
      json-bridge.ts   ← toJSON / fromJSON（JSON で覗く/手編集する用）
      cli.ts           ← `graft inspect` / `graft diff`（公開 bin）
      index.ts         ← barrel export
    test/              ← vitest（roundtrip / errors / extension / json-bridge / cli / property）
    scripts/gen-golden.ts ← golden + meta 生成
  conformance/         ← クロス言語の準拠テスト基盤（配布物ではない）
    README.md          ← golden/meta の契約と各ポートの実行方法
    js/ python/ rust/ go/  ← 各言語の独立デコーダ+エンコーダ+ランナー
  docs/RELEASING.md    ← npm 以外の配布方法まとめ
  README.md
  CLAUDE.md            ← このファイル
```

---

## 仕様文書との関係（最重要）

**`spec/FORMAT.md` が単一の真実のソース。**

- `js/src/format.ts` は FORMAT.md の TypeScript 実装で、常に同期していること
- 仕様を変えるときは **FORMAT.md を先に更新** → format.ts → encode/decode → テスト
  → golden 再生成 → 各 conformance ポートを更新、の順
- タグ値がずれていたら FORMAT.md を正とする

---

## 現在の実装状態（すべて実装済み）

### タグ（0〜47）
- プリミティブ: Null/Undefined/Bool/Int/Float/BigInt/String
- Symbol: Registered/Unique/WellKnown
- コンテナ: Array/Object/Map/Set（循環・共有 identity・任意オブジェクトキー対応）
- 弱参照: WeakMap/WeakSet（WeakProvider で内容を明示供給）
- 拡張: Date/Bytes/TypedArray/RegExp/Url/DataView/Error
- Custom(47): ユーザー登録の拡張型（`TypeExtension`）

### JS ライブラリ
- `encode(value, { provider?, types? })` / `decode(bytes, { types?, maxNodes? })`
- 循環参照・共有 identity を heap + 参照で保持。decode は遅延メモ化解決
- ガード: function / 未対応の exotic オブジェクト / 名前付きプロパティ付き配列は **throw**
  （無損失保証のため）。boxed primitive は unwrap。`__proto__` キーは安全に own 化
- 拡張型レジストリ（class インスタンス等を opt-in 無損失化）
- デコード安全化（count>バッファ / maxNodes / 範囲外 root・ref を拒否）
- JSON ブリッジ（`toJSON`/`fromJSON`、identity ロッシー・循環は拒否）
- CLI（`graft inspect`=ツリー+ヒストグラム、`graft diff`=値グラフ差分）

### テスト/検証
- vitest 108件パス（property test 含む）
- golden 13ベクタ + 各 .meta.json（`gen-golden.ts` で生成）
- conformance 4ポート（JS/Python/Rust/Go）: decode→meta 照合 **と** `encode(decode(golden))==元バイト`（バイト一致 round-trip）。すべて 13/13

---

## 実装上の制約（厳守）

- **JS ランタイムは V8 非依存**: `structuredClone` / `vm` / `Buffer`（Node 固有）を使わない。
  使うのは `DataView` / `TextEncoder` / `BigInt` 等の標準 API のみ
- **JS ランタイム依存ゼロ**: `js/package.json` の `dependencies` は空（devDeps のみ）。
  CLI は別エントリで、ライブラリ本体には Node 依存を持ち込まない
- **バイト決定性**: golden は全ポートでバイト一致するのが前提。フォーマットを変えたら
  golden を再生成し、4ポートすべてを追従させる（バイト一致テストが番人）
- **conformance はテスト基盤**: 各ポートはまだ未パッケージ（公開には packaging が必要、
  `docs/RELEASING.md` 参照）。配布対象は `js/` のみ
- **後方互換**: 未リリースなので破壊的変更OK（バイナリ仕様・API とも自由に整理してよい）

---

## よく使うコマンド

```bash
# JS（js/ 配下で）
pnpm test            # vitest
pnpm typecheck       # tsc --noEmit
pnpm lint            # oxlint
pnpm format          # oxfmt（--check で確認）
pnpm conformance     # JS リファレンスランナー（golden vs meta）
pnpm build           # tsdown（dist/index.js, dist/cli.js）
npx tsx scripts/gen-golden.ts   # golden + meta 再生成

# 他言語ポート（準拠 + バイト一致 round-trip）
python3 conformance/python/run.py   &&  python3 conformance/python/roundtrip.py
cd conformance/rust && cargo test
cd conformance/go   && go test ./...
```

---

## フォーマットを変更するときの手順

1. `spec/FORMAT.md` を更新（タグ表・§本文・予約レンジ）
2. `js/src/format.ts` を合わせる
3. `encode.ts` / `decode.ts` を実装
4. `js/test/` にテスト追加 → `pnpm test` / `typecheck` / `lint` / `format`
5. `npx tsx scripts/gen-golden.ts` で golden + meta 再生成
6. 各 conformance ポート（python/rust/go）を追従させ、`cargo test` / `go test` / `run.py` を通す
7. `pnpm conformance` で JS リファレンスも緑にする
