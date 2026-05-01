Gemini OCR+
AIの力で、ドキュメントの抽出・リネーム・整理をワンストップで。

Gemini OCR+ は、Google Gemini API を活用した Windows 向けデスクトップ OCR ツールです。
PDF や画像からテキストを抽出するだけでなく、AIによるファイル名の自動提案やフォルダへの自動振り分けまで、ドキュメント管理に必要な作業を一つのアプリで完結できます。

TauriNext.jsRustLicense

✨ 主な機能
📄 OCR テキスト抽出
PDF・画像（PNG, JPG, WebP 等）からテキストを抽出
Gemini AI による高精度な構造化テキスト変換
TXT / Markdown / CSV 形式で保存（追記モードも対応）
複数ファイルの一括処理
🏷️ リネーマー
ファイル内容を AI が解析し、最適なファイル名を自動提案
ルールベースのリネーム（正規表現、プレフィックス/サフィックス、連番付与など）も対応
プレビュー付きで安全に確認してから実行
📁 ファイリング
AI がファイル内容を読み取り、リネームと保存先フォルダの提案をセットで実行
移動 / コピーを選択可能
フォルダグルーピング機能（拡張子別、日付別、ファイル名別）
カスタムプロンプトテンプレートで用途に応じた振り分けルールを保存
🛡️ セキュリティ
パス検証によるディレクトリトラバーサル防止
Windows 予約名・禁止文字のバリデーション
シンボリックリンク経由の脱出を canonicalize で防止
ファイル移動時のアトミック処理とロールバック機構
🖥️ スクリーンショット
※ 開発中のため、今後変更される可能性があります。

🚀 動作環境
項目	要件
OS	Windows 10 / 11（64bit）
Rust	1.77.2 以上
Node.js	18 以上
API キー	Google AI Studio で取得した Gemini API キー
📦 インストール方法
🔧 ソースからビルドする場合
前提条件
Rust がインストール済みであること
Node.js (v18+) がインストール済みであること
Tauri v2 の前提条件 を満たしていること
手順
bash
# リポジトリをクローン
git clone https://github.com/<your-username>/ocr-rust.git
cd ocr-rust
# 依存関係のインストール
npm install
# .env ファイルを作成し、API キーを設定
echo GEMINI_API_KEY=your_api_key_here > src-tauri/.env
# 開発モードで起動
npx tauri dev
📥 ビルド済みバイナリを使う場合
Releases
 ページから最新の .msi または .exe インストーラーをダウンロードしてください。
初回起動時に設定画面から Gemini API キーを入力します。

⚙️ 設定
API キーの設定
Gemini API キーは以下の 2 通りの方法で設定できます。

アプリ内の設定画面から入力（推奨）
src-tauri/.env ファイルに直接記述：
GEMINI_API_KEY=your_api_key_here
使用可能な AI モデル
アプリ内の設定画面からモデルを切り替えられます（例: gemini-2.5-flash, gemini-2.5-pro など）。

🏗️ 技術スタック
レイヤー	技術
フレームワーク	Tauri v2
フロントエンド	Next.js 16 + React 19
UI ライブラリ	shadcn/ui + Tailwind CSS v4
バックエンド	Rust
AI	Google Gemini API (via genai crate)
データベース	SQLite（rusqlite）— 操作履歴の保存
PDF 処理	pdf-extract
📂 プロジェクト構成
ocr-rust/
├── src/                    # フロントエンド（Next.js）
│   ├── app/
│   │   ├── page.tsx        # メイン：OCR 抽出画面
│   │   ├── renamer/        # AI リネーマー画面
│   │   └── filing/         # AI ファイリング画面
│   └── components/         # 共通 UI コンポーネント
├── src-tauri/              # バックエンド（Rust / Tauri）
│   └── src/
│       ├── lib.rs          # Tauri コマンド登録
│       ├── file_ops.rs     # ファイル操作（リネーム、移動、コピー、重複削除等）
│       ├── ai_renamer.rs   # AI リネーム提案ロジック
│       ├── ai_filing.rs    # AI ファイリング提案ロジック
│       ├── renamer_rules.rs # ルールベースリネームエンジン
│       ├── config.rs       # 設定管理（API キー、モデル選択）
│       └── db.rs           # SQLite データベース管理
└── docs/                   # 開発ドキュメント
🤝 コントリビューション
バグ報告や機能要望は 
Issues
 からお気軽にどうぞ。
Pull Request も歓迎します。

📄 ライセンス
このプロジェクトは 
MIT License
 の下で公開されています。

🙏 謝辞
Google Gemini API — AI によるテキスト解析・リネーム提案の中核
Tauri — 軽量で安全なデスクトップアプリケーションフレームワーク
shadcn/ui — 美しく再利用可能な UI コンポーネント
