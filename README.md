# OCR-Rust (Gemini OCR+)

Tauri (Rust) + Next.js で構成した、Windows向けの OCR / 抽出 / ファイル整理アプリです。

## 概要

Gemini OCR+ は、抽出結果の複数フォーマット出力（TXT / MD / CSV / JSON）、プロンプトテンプレート管理、翻訳・要約・PIIマスキングなどの自動加工に対応しています。  
Windows インストーラは GitHub Releases で配布します。

<img width="1919" height="1115" alt="image" src="https://github.com/user-attachments/assets/a4825e31-e967-4068-a305-6698331f91da" />

## 主な機能

- 文書・画像の OCR 抽出
- 出力形式: TXT / Markdown / CSV / JSON
- Markdown 向け YAML Frontmatter
- カスタムプロンプトテンプレート（保存 / 編集 / 削除）
- 出力内容の自動加工
  - 翻訳出力
  - 要約モード（重要3点 / 結論のみ）
  - 個人情報マスキング（PII）
  - 自動タグ生成
- AI提案によるファイル整理とルールベースリネーム
- 完全一致重複の検知・削除
- 選択ファイルのゴミ箱移動

## 技術スタック

- Frontend: Next.js 16 / React 19 / TypeScript
- Desktop: Tauri v2 / Rust
- AI: Gemini API
- Storage: SQLite (rusqlite)

## 動作要件

- Node.js 20 以上
- Rust stable
- Windows 10 / 11 推奨

## セットアップ

```bash
npm ci
```

Gemini APIキーは以下のどちらかで設定してください。

- アプリ内のモデル設定画面で保存
- 環境変数 `GEMINI_API_KEY` を設定

## 開発起動

Web UI のみ:

```bash
npm run dev
```

デスクトップアプリ (Tauri):

```bash
npm run tauri dev
```

## ローカルビルド

```bash
npm run tauri:build
```

Windows インストーラは通常、次に生成されます。

- `src-tauri/target/release/bundle/nsis/*.exe`

## GitHub Release (Windows EXE)

このリポジトリには Release 用 workflow が含まれています。

- workflow: `.github/workflows/release.yml`
- トリガー: `v*` タグ push

例:

```bash
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main
git push origin v0.1.1
```

workflow では次を Release に添付します。

- Windows インストーラ成果物
- `SHA256SUMS.txt`（チェックサム）

## セキュリティ方針（概要）

- Rust 側のファイル操作は許可ルート配下に制限
- 実行前にファイル名・パスを検証
- 移動は `rename` 優先、失敗時は安全なフォールバックで不整合を抑制

## 注意

- `api_key.txt` は `.gitignore` 済み（機密情報はコミットしない）
- `src/app/renamer` は現状 `filing` へリダイレクト
