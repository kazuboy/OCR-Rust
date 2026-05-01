# Gemini OCR+

> AIの力で、ドキュメントの抽出・リネーム・整理をワンストップで。

**Gemini OCR+** は、Google Gemini API を活用した Windows 向けデスクトップ OCR ツールです。  
PDF や画像からテキストを抽出するだけでなく、AIによるファイル名の自動提案やフォルダへの自動振り分けまで、ドキュメント管理に必要な作業を一つのアプリで完結できます。

![Tauri](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![Rust](https://img.shields.io/badge/Rust-1.77+-orange?logo=rust)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 主な機能

### 📄 OCR テキスト抽出
- **高精度抽出**: PDF・画像（PNG, JPG, WebP 等）からテキストを抽出
- **構造化変換**: Gemini AI による高精度な構造化テキスト変換
- **柔軟な保存**: TXT / Markdown / CSV 形式で保存（追記モードも対応）
- **一括処理**: 複数ファイルの一括処理が可能

### 🏷️ リネーマー
- **自動提案**: ファイル内容を AI が解析し、最適なファイル名を自動提案
- **高度なルール**: ルールベースのリネーム（正規表現、連番付与など）も対応
- **安全な確認**: プレビュー付きで確認してから実行可能

### 📁 ファイリング（自動振り分け）
- **スマート提案**: AI が内容を読み取り、リネームと保存先の提案をセットで実行
- **整理アクション**: 移動 / コピーを選択可能
- **自動分類**: フォルダグルーピング機能（拡張子別、日付別、ファイル名別）
- **カスタム可能**: 用途に応じた振り分けルールをテンプレートとして保存

### 🛡️ セキュリティ
- **アクセス制限**: パス検証によるディレクトリトラバーサル防止
- **安全な命名**: Windows 予約名・禁止文字のバリデーション
- **シンボリックリンク対策**: リンク経由の外部脱出を防止
- **堅牢なファイル操作**: 移動時のアトミック処理と失敗時のロールバック機構

---

## 🚀 動作環境

| 項目 | 要件 |
|------|------|
| OS | Windows 10 / 11（64bit） |
| Rust | 1.77.2 以上 |
| Node.js | 18 以上 |
| API キー | Google AI Studio で取得した Gemini API キー |

---

## 📦 インストール方法

### 🔧 ソースからビルドする場合

#### 手順
1. **リポジトリをクローン**
   ```bash
   git clone https://github.com/kazuboy/OCR-Rust.git
   cd OCR-Rust
