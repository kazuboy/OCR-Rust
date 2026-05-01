OCR-Rust (Gemini OCR+)
Tauri + Next.js で作成した、デスクトップ向け OCR / 抽出 / ファイル整理アプリです。
GitHub Release では Windows 向け EXE を配布します。

主な機能
文書・画像の OCR 抽出（TXT / MD / CSV / JSON）
YAML Frontmatter 付き Markdown 出力
カスタムプロンプト + テンプレート保存/編集
追加加工（翻訳 / 要約 / PII マスキング / 自動タグ）
ファイル整理（AI提案 / ルールベース）
重複検知（完全一致）とゴミ箱移動
技術スタック
Frontend: Next.js 16 / React 19 / TypeScript
Desktop: Tauri v2 (Rust)
AI: Gemini API
DB: SQLite (rusqlite)
動作環境
Node.js 20 以上
Rust stable
Windows 10/11 推奨
セットアップ
npm ci
APIキーは次のいずれかで設定します。

アプリ内のモデル設定画面で保存
環境変数 GEMINI_API_KEY を設定
開発起動
Web のみ確認:

npm run dev
Tauri デスクトップとして起動:

npm run tauri dev
ビルド（ローカル）
npm run tauri:build
生成物（Windows EXE）は通常、次に出力されます。

src-tauri/target/release/bundle/nsis/*.exe
GitHub Release（EXE配布）
このリポジトリには tag push で Release を作る workflow が含まれています。

Workflow: .github/workflows/release.yml
トリガー: v* タグの push
例:

git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main
git push origin v0.1.1
セキュリティ方針（概要）
Rust 側のファイル操作は許可ルート配下に制限しています。
リネーム/移動時は不正なファイル名・パス要素を検証します。
移動処理は rename 優先、失敗時フォールバックで不整合を抑制します。
注意
api_key.txt は .gitignore 済みです。機密情報はコミットしないでください。
src/app/renamer は現状 filing へリダイレクトする導線です。
