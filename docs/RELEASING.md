# リリース方法まとめ（npm 以外）

このリポジトリの「配布物」は大きく3種類あります。リリース先は配布物ごとに
違うので、まずそこを整理します。

| 配布物 | 中身 | 主なリリース先 |
|--------|------|----------------|
| **JS ライブラリ** | `js/`（`encode` / `decode`） | npm / **JSR** / GitHub Releases / CDN |
| **フォーマット仕様 + golden** | `spec/FORMAT.md`, `spec/golden/*.bin` + `*.meta.json` | **GitHub Releases**（タグでバージョン固定） |
| **各言語ポート** | `conformance/{python,rust,go}` | crates.io / PyPI / Go modules（※下記の注意あり） |

> いまの各言語ポートは「準拠テスト用ハーネス」であって、まだ公開パッケージ
> として整えていません（`Cargo.toml` は `publish = false`、Go の module 名は
> インポート可能なパスではない、Python は素のスクリプト）。公開するなら後述の
> パッケージ化が必要です。

npm 以外の選択肢を、手軽な順・この repo に向いている順で並べます。

---

## 1. JSR（jsr.io）— JS/TS 向け npm 代替【最推奨】

Deno チーム製の JS/TS レジストリ。**TypeScript ソースをそのまま公開**でき
（ビルド不要）、npm / pnpm / yarn / Deno / Bun から使えます。

### セットアップ
`js/jsr.json`（または `deno.json`）を作る:

```jsonc
{
  "name": "@gityosan/greft",   // JSR は必ずスコープ付き
  "version": "1.0.0",
  "exports": "./src/index.ts"
}
```

### 公開
```bash
cd js
npx jsr publish        # 初回はブラウザ認証。Deno なら `deno publish`
```

### 利用側
```bash
npx jsr add @gityosan/greft        # npm/pnpm/yarn プロジェクト
# Deno: deno add jsr:@gityosan/greft
```

### 注意
- **slow types 制限**: 公開 API（`encode`/`decode` 等）に明示的な戻り値型が
  必要。このライブラリは既に型注釈付きなので概ねOK。
- GitHub Actions から **OIDC でトークン無し公開**ができる（後述）。

---

## 2. GitHub Releases — 仕様・golden・任意アセット【この repo で特に有用】

レジストリを介さず、**git タグに紐づけてファイルを配布**する最も汎用的な方法。
他言語ポートが参照する `spec/FORMAT.md` と `spec/golden/` を、バージョン固定で
配れるのが利点です。

### 手動
```bash
git tag v1.1.0 && git push origin v1.1.0
gh release create v1.1.0 \
  spec/FORMAT.md spec/golden/*.bin spec/golden/*.meta.json \
  --title "v1.1.0" --notes "..."
```

### Actions で自動化（タグ push で発火）
```yaml
# .github/workflows/release.yml
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: tar czf golden.tar.gz -C spec golden FORMAT.md
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            golden.tar.gz
            spec/FORMAT.md
```

### 利用側
リリースページの URL を直接ダウンロード、または
`https://github.com/gityosan/greft/releases/download/v1.1.0/golden.tar.gz`。

---

## 3. CDN 経由（レジストリ不要）

### jsDelivr（GitHub から直接）
ビルド済み JS をコミットしてあれば、レジストリ無しで配信できます:
```
https://cdn.jsdelivr.net/gh/gityosan/greft@v1.1.0/js/dist/index.js
```
- ブラウザ/Deno から ESM として import 可能。
- 注意: ブラウザは TS を実行できないので **`dist/` のビルド成果物が必要**。
  いまは `dist/` を生成物として扱っているため、CDN 配信するならビルドを
  コミットするか、JSR 経由にするのが楽。

### esm.sh / unpkg
これらは **npm レジストリ由来**で配信するため「npm 以外」にはならない。
GitHub だけで完結させたいなら jsDelivr の `/gh/` を使う。

---

## 4. GitHub Packages（npm 互換・npmjs.com 以外）

npm の仕組みのまま、ホストを GitHub にする方式。レジストリは
`npm.pkg.github.com`、パッケージ名は `@owner/name` 必須。

```ini
# .npmrc
@gityosan:registry=https://npm.pkg.github.com
```
```bash
npm publish        # GITHUB_TOKEN で認証
```
> ツールチェーンは npm のままなので「npm の親戚」。社内・限定公開向け。

---

## 5. git から直接インストール（レジストリを使わない）

パブリッシュせずに、リポジトリを依存に指定する方法。

```bash
# npm/pnpm（subdir 指定）
pnpm add "github:gityosan/greft#path:/js"
# Python
pip install "git+https://github.com/gityosan/greft#subdirectory=conformance/python"
# Rust（Cargo.toml）
graft = { git = "https://github.com/gityosan/greft" }
```
- 手軽だが**バージョン管理がタグ/コミット任せ**になる。
- npm の場合、ビルドが要るなら `prepare` スクリプトが必要。

---

## 6. 各言語ポートを「本物のパッケージ」として出す場合

### Rust → crates.io
1. `conformance/rust/Cargo.toml` の `publish = false` を外し、メタdata追加:
   ```toml
   description = "..."
   license = "MIT"        # 要 LICENSE
   repository = "https://github.com/gityosan/greft"
   ```
2. `cargo publish`（crates.io のトークンが必要）。
3. 自動化は `release-plz` や `cargo-dist` が定番。
- 公開せず git 依存でも可（上記5）。

### Python → PyPI
1. `conformance/python/pyproject.toml` を用意（パッケージ化）:
   ```toml
   [build-system]
   requires = ["hatchling"]
   build-backend = "hatchling.build"

   [project]
   name = "graft-codec"
   version = "1.0.0"
   ```
2. ビルド & アップロード:
   ```bash
   python -m build
   twine upload dist/*          # または `uv publish`
   ```
3. GitHub Actions の **Trusted Publishing（OIDC）** ならトークン不要。

### Go modules（中央レジストリ無し）
Go は「タグを push するだけ」がリリース。ただし**注意点**:
- `go.mod` の module 名を**インポート可能なパス**にする必要がある:
  現状 `module graft-conformance-go` → 例 `github.com/gityosan/greft/conformance/go`。
- サブディレクトリの module は**タグにプレフィックスが要る**:
  `conformance/go/v1.0.0` のように打つ。
- 公開後は `pkg.go.dev` が自動でインデックス。利用側:
  ```bash
  go get github.com/gityosan/greft/conformance/go@v1.0.0
  ```

---

## 7. （参考）対象外なもの
- **Homebrew / apt / Docker(GHCR)**: CLI やサービスの配布向け。本 repo は
  ライブラリ + 仕様なので基本不要。CLI を切り出したら検討。

---

## この repo へのおすすめ構成

1. **JS ライブラリ**: npm に加えて **JSR** にも出す（TS ネイティブ・Deno 対応）。
2. **仕様 + golden**: **GitHub Releases** にタグ付きで添付し、他言語ポートが
   バージョンを固定して取得できるようにする。
3. **各言語ポート**: 当面は git 依存で十分。需要が出たら crates.io / PyPI /
   Go modules へ昇格。
4. すべて **タグ push（`v*`）起点**にして GitHub Actions で自動化。トークンが
   要らない **OIDC（JSR / PyPI Trusted Publishing）** を優先。

### OIDC 公開の最小例（JSR）
```yaml
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
  id-token: write          # OIDC。これだけでトークン不要
jobs:
  publish:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: js } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: corepack enable && pnpm install --frozen-lockfile
      - run: npx jsr publish
```
