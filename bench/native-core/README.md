# native-core — PoC: ネイティブ Rust デコードコアを各言語から叩く

## これは何か（配布物ではない）

「各言語でデコーダを書き直す」代わりに、**Rust でコアを 1 本書いて
コンパイル → 各言語から FFI で呼ぶ」道に意味があるか**を数字で確かめる
ための PoC。ここでは代表として **Rust コア + Python バインディング（PyO3）**
を作り、純 Python リファレンス（`conformance/python/decode.py`）とデコード
速度を比較する。

スコープは **JSON 形状のホットパス**（null / bool / int / bigint / float /
string / array / object）。モックフィクスチャの大半はこの形状なので、
スループットの判断材料としてはこれで十分。Map/Set/Date 等の特殊タグや
循環の網羅はこの PoC の対象外（コア化を本実装する場合に追従する）。

## 構成

```
bench/native-core/
  Cargo.toml        cdylib (PyO3, extension-module)。依存は FFI グルーの pyo3 のみ
  src/lib.rs        自己完結デコーダ。2 つの入口:
                      decode(bytes)      -> ネイティブ Python オブジェクト（実利用UX）
                      parse_count(bytes) -> Rust 値グラフに復元してノード数を返す（天井）
  gen_payload.py    encode.py で「モックフィクスチャ相当」を生成（Node 不要）
  bench.py          純Python と結果一致を検証 → timeit でスループット比較
  build.sh          ビルド + import 名へのリンク
```

## 実行

```bash
./build.sh                 # cargo build --release → graft_native.so にリンク
python3 gen_payload.py     # small.bin / large.bin を生成
python3 bench.py
```

必要環境: rustc/cargo、Python 3 + 開発ヘッダ（`Python.h`）、crates.io への
ネットワーク（pyo3 取得）。**追加の Python パッケージは不要**（ctypes ならぬ
PyO3 拡張を `cargo build` でそのまま import）。

## 測定結果（参考値・Python 3.11）

baseline = 純 Python `decode.py`（bytes → ネイティブ Python オブジェクト）

| payload | size | nodes | py-decode | **rust-decode (→Py)** | rust-parse (→Rust) |
|---|--:|--:|--:|--:|--:|
| small | 850 B | 58 | 6.4 MB/s (1.0x) | **122 MB/s (18.9x)** | 174 MB/s (27.0x) |
| large | 3.18 MB | 121,118 | 4.3 MB/s (1.0x) | **61.5 MB/s (14.4x)** | 83.9 MB/s (19.7x) |

数値は環境で変動するが、桁感は安定して再現する。

## 読み取り（= 判断材料）

- **Python では明確にお釣りが来る。** ネイティブ Python オブジェクトを
  実際に組み立てる「実利用に近い」経路でも **14〜19 倍**速い。
- **小ペイロードでも FFI 往復で負けない。** 850 B / 58 ノードでも 18.9 倍。
  FFI 1 回のコストより 1 回のデコード仕事量がずっと大きいので、当初懸念した
  「小データで FFI オーバーヘッドが支配的」は、この粒度（バイト列を渡して
  グラフを返す単位）では起きない。効くのは「数十バイトをタイトループで
  毎回 1 件ずつ呼ぶ」ような使い方だけ。
- **Python オブジェクト化のコストは残りの差。** `rust-decode`（→Python,
  14〜19x）と `rust-parse`（→Rust, 20〜27x）の差がマーシャリング分。
  消費側が Rust なら 20 倍超、Python に値を渡すなら 14〜19 倍。

## 次の判断

PoC の結論は「**Python 配布をネイティブコア化する価値は十分にある**」。
本実装に進むなら:

1. Rust コアを **C ABI / PyO3 の両対応**で切り出し（全タグ・循環・共有 identity・
   `encode` も）。FORMAT.md が引き続き単一の真実のソース。
2. 配布のコストは「依存 1 個」ではなく **プラットフォーム別 prebuilt のマトリクス**
   （OS×arch、wheel/prebuild 配布）。ここを CI に載せるのが本体作業。
3. **conformance の独立実装は番人として残す**。全ポートを単一コアに統一すると
   「13/13 バイト一致」が相互検証ではなくセルフチェックに退化するため。
