"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowRight, FileText, FolderOpen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface FileMetadataInfo {
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  created_ms: number | null;
  modified_ms: number | null;
}

interface FilePreviewData {
  file_name: string;
  extension: string;
  size_bytes: number;
  created: string | null;
  modified: string | null;
  preview_type: "image" | "text" | "unsupported";
  content: string | null;
}

interface ExtractionResult {
  filePath: string;
  fileName: string;
  success: boolean;
  output: string;
  savedPath?: string;
  error?: string;
}

interface ModelSettingsInfo {
  model_id: string;
  has_api_key: boolean;
}

interface ModelListItem {
  id: string;
  display_name: string;
}

type OutputFormat = "txt" | "md" | "csv" | "json";
type SaveMode = "append_single" | "save_individual";
type PromptTemplate = { id: string; name: string; prompt: string };
type TranslationMode = "none" | "ja" | "en";
type SummaryMode = "none" | "bullets3" | "conclusion";
type PromptAugmentOptions = {
  translationMode: TranslationMode;
  summaryMode: SummaryMode;
  maskPii: boolean;
  yamlAutoTags: boolean;
};

const TEMPLATE_STORAGE_KEY = "ocr_prompt_templates_v2";
const LEGACY_TEMPLATE_STORAGE_KEY = "ocr_prompt_templates_v1";
const SAVE_MODE_STORAGE_KEY = "ocr_save_mode_v1";
const INDIVIDUAL_OUTPUT_DIR_KEY = "ocr_individual_output_dir_v1";
const APPEND_OUTPUT_FILE_KEY = "ocr_append_output_file_v1";
const PROMPT_AUGMENT_OPTIONS_STORAGE_KEY = "ocr_prompt_augment_options_v1";
const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "default-main-items",
    name: "主要項目抽出",
    prompt:
      "請求書・領収書などの文書から、日付、金額、税額、発行元、宛先、文書番号、支払期限など主要項目を漏れなく抽出してください。各項目は「項目名: 値」の形式で整理してください。",
  },
  {
    id: "default-table",
    name: "表データ優先",
    prompt:
      "表や明細を最優先で抽出し、列名と行の対応関係が崩れないように整理してください。表以外の文章は最後に「補足」として短くまとめてください。",
  },
  {
    id: "default-headerless",
    name: "本文優先抽出",
    prompt:
      "ヘッダー、フッター、ページ番号、繰り返しの定型文を除外し、本文だけを段落順に抽出してください。箇条書きは箇条書きのまま保持してください。",
  },
  {
    id: "default-strict-ocr",
    name: "忠実文字起こし",
    prompt:
      "改行、空行、記号、数値表記を可能な限り維持し、推測補完をせずに原文を忠実に文字起こししてください。読めない箇所は [判読不可] と明記してください。",
  },
];
const DEFAULT_TEMPLATE_IDS = new Set(DEFAULT_PROMPT_TEMPLATES.map((t) => t.id));
const DEFAULT_PROMPT_AUGMENT_OPTIONS: PromptAugmentOptions = {
  translationMode: "none",
  summaryMode: "none",
  maskPii: false,
  yamlAutoTags: false,
};

function mergeTemplatesWithDefaults(stored: PromptTemplate[]): PromptTemplate[] {
  const cleaned = stored.filter(
    (t): t is PromptTemplate =>
      typeof t?.id === "string" && typeof t?.name === "string" && typeof t?.prompt === "string"
  );
  const merged: PromptTemplate[] = [...DEFAULT_PROMPT_TEMPLATES];
  for (const t of cleaned) {
    if (!DEFAULT_TEMPLATE_IDS.has(t.id)) {
      merged.push(t);
    }
  }
  return merged;
}

function getBaseName(path: string): string {
  const fileName = path.split(/[/\\]/).pop() ?? path;
  return fileName.replace(/\.[^/.]+$/, "");
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim() || "extracted";
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

function joinPath(dir: string, fileName: string): string {
  if (/[\\/]$/.test(dir)) {
    return `${dir}${fileName}`;
  }
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${fileName}`;
}

function buildPrompt(
  format: OutputFormat,
  useYamlFrontmatter: boolean,
  customPrompt: string,
  augmentInstructions: string,
  sourcePath: string,
  preview: FilePreviewData
): string {
  const common = [
    "あなたはOCRとデータ抽出のアシスタントです。",
    "与えられた文書内容を読み取り、指定フォーマットのみを返してください。",
    "不要な前置きや解説は書かないでください。",
  ];

  let formatInstruction = "";
  if (format === "txt") {
    formatInstruction = "プレーンテキスト形式で、抽出結果のみを返してください。";
  } else if (format === "md") {
    formatInstruction = useYamlFrontmatter
      ? "Markdown形式で返し、先頭にYAML Frontmatter（title, source, extracted_at）を必ず付けてください。"
      : "Markdown形式で返してください。";
  } else if (format === "json") {
    formatInstruction =
      "JSON形式のみを返してください。Markdownコードブロックは禁止です。単一のJSONオブジェクトまたは配列で返してください。";
  } else {
    formatInstruction = "CSV形式のみを返してください。Markdownコードブロックは禁止です。";
  }

  const sourceBlock = [
    `source_path: ${sourcePath}`,
    `preview_type: ${preview.preview_type}`,
    "----- document preview start -----",
    preview.content ?? "",
    "----- document preview end -----",
  ].join("\n");

  return [
    ...common,
    formatInstruction,
    `ユーザー要求: ${customPrompt.trim() || "重要項目を漏れなく抽出"}`,
    augmentInstructions ? `追加要件（内部指定）:\n${augmentInstructions}` : "",
    sourceBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildPromptAugmentInstructions(
  options: PromptAugmentOptions,
  format: OutputFormat,
  useYamlFrontmatter: boolean
): string {
  const lines: string[] = [];

  if (options.translationMode === "ja") {
    lines.push("最終出力は必ず日本語で返してください。");
  } else if (options.translationMode === "en") {
    lines.push("最終出力は必ず英語で返してください。");
  }

  if (options.summaryMode === "bullets3") {
    lines.push("全文転記ではなく、重要ポイントを3項目の箇条書きで要約してください。");
  } else if (options.summaryMode === "conclusion") {
    lines.push("全文転記ではなく、結論・要点のみを簡潔に出力してください。");
  }

  if (options.maskPii) {
    lines.push("氏名・電話番号・メールアドレスは必ず *** にマスキングしてください。");
  }

  if (options.yamlAutoTags) {
    if (format === "md" && useYamlFrontmatter) {
      lines.push("YAML Frontmatterに tags を配列で追加してください（例: tags: [請求書, 2026, 取引先名]）。");
    } else {
      lines.push("可能な場合はメタデータとして推定タグを付与してください。");
    }
  }

  return lines.join("\n");
}

function normalizeOutput(
  format: OutputFormat,
  useYamlFrontmatter: boolean,
  filePath: string,
  aiText: string
): string {
  const cleaned = stripCodeFence(aiText);

  if (format === "txt") {
    return cleaned;
  }

  if (format === "csv") {
    return cleaned;
  }

  if (format === "json") {
    return cleaned;
  }

  if (!useYamlFrontmatter) {
    return cleaned;
  }

  if (cleaned.startsWith("---\n")) {
    return cleaned;
  }

  const title = sanitizeFileName(getBaseName(filePath));
  const now = new Date().toISOString();
  return `---\ntitle: ${title}\nsource: ${filePath}\nextracted_at: ${now}\n---\n\n${cleaned}`;
}

export default function Home() {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [selectedExecutionFiles, setSelectedExecutionFiles] = useState<string[]>([]);
  const [filesMetadata, setFilesMetadata] = useState<Record<string, FileMetadataInfo>>({});

  const [filterKeyword, setFilterKeyword] = useState("");
  const [filterExtension, setFilterExtension] = useState("");
  const [filterDateAfter, setFilterDateAfter] = useState("");
  const [filterDateBefore, setFilterDateBefore] = useState("");

  const [outputFormat, setOutputFormat] = useState<OutputFormat>("txt");
  const [useYamlFrontmatter, setUseYamlFrontmatter] = useState(false);
  const [saveMode, setSaveMode] = useState<SaveMode>("save_individual");
  const [individualOutputDir, setIndividualOutputDir] = useState("");
  const [appendOutputFile, setAppendOutputFile] = useState("");
  const [customPrompt, setCustomPrompt] = useState(DEFAULT_PROMPT_TEMPLATES[0].prompt);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>(DEFAULT_PROMPT_TEMPLATES);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(DEFAULT_PROMPT_TEMPLATES[0].id);
  const [promptAugmentOptions, setPromptAugmentOptions] = useState<PromptAugmentOptions>(
    DEFAULT_PROMPT_AUGMENT_OPTIONS
  );
  const [isPromptAugmentOpen, setIsPromptAugmentOpen] = useState(false);
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelListItem[]>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const [modelMessage, setModelMessage] = useState("");

  const [isDragOver, setIsDragOver] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [results, setResults] = useState<ExtractionResult[]>([]);
  const selectedTemplate = useMemo(
    () => promptTemplates.find((t) => t.id === selectedTemplateId) ?? null,
    [promptTemplates, selectedTemplateId]
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY) ?? localStorage.getItem(LEGACY_TEMPLATE_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const merged = mergeTemplatesWithDefaults(parsed);
      if (merged.length > 0) {
        setPromptTemplates(merged);
      }
    } catch {
      // noop
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(promptTemplates));
    } catch {
      // noop
    }
  }, [promptTemplates]);

  useEffect(() => {
    try {
      const savedMode = localStorage.getItem(SAVE_MODE_STORAGE_KEY);
      if (savedMode === "append_single" || savedMode === "save_individual") {
        setSaveMode(savedMode);
      }
      const savedDir = localStorage.getItem(INDIVIDUAL_OUTPUT_DIR_KEY);
      if (savedDir) setIndividualOutputDir(savedDir);
      const savedAppend = localStorage.getItem(APPEND_OUTPUT_FILE_KEY);
      if (savedAppend) setAppendOutputFile(savedAppend);
      const savedAugment = localStorage.getItem(PROMPT_AUGMENT_OPTIONS_STORAGE_KEY);
      if (savedAugment) {
        const parsed = JSON.parse(savedAugment);
        setPromptAugmentOptions({
          translationMode: parsed?.translationMode === "ja" || parsed?.translationMode === "en" ? parsed.translationMode : "none",
          summaryMode:
            parsed?.summaryMode === "bullets3" || parsed?.summaryMode === "conclusion" ? parsed.summaryMode : "none",
          maskPii: Boolean(parsed?.maskPii),
          yamlAutoTags: Boolean(parsed?.yamlAutoTags),
        });
      }
    } catch {
      // noop
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SAVE_MODE_STORAGE_KEY, saveMode);
    } catch {
      // noop
    }
  }, [saveMode]);

  useEffect(() => {
    try {
      localStorage.setItem(INDIVIDUAL_OUTPUT_DIR_KEY, individualOutputDir);
    } catch {
      // noop
    }
  }, [individualOutputDir]);

  useEffect(() => {
    try {
      localStorage.setItem(APPEND_OUTPUT_FILE_KEY, appendOutputFile);
    } catch {
      // noop
    }
  }, [appendOutputFile]);

  useEffect(() => {
    try {
      localStorage.setItem(PROMPT_AUGMENT_OPTIONS_STORAGE_KEY, JSON.stringify(promptAugmentOptions));
    } catch {
      // noop
    }
  }, [promptAugmentOptions]);

  useEffect(() => {
    if (promptTemplates.length === 0) {
      return;
    }
    if (!promptTemplates.some((t) => t.id === selectedTemplateId)) {
      setSelectedTemplateId(promptTemplates[0].id);
    }
  }, [promptTemplates, selectedTemplateId]);

  useEffect(() => {
    const valid = new Set(selectedFiles);
    setSelectedExecutionFiles((prev) => prev.filter((p) => valid.has(p)));
  }, [selectedFiles]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "enter") {
            setIsDragOver(true);
          } else if (event.payload.type === "drop") {
            setIsDragOver(false);
            const paths = event.payload.paths ?? [];
            if (paths.length > 0) {
              setSelectedFiles((prev) => Array.from(new Set([...prev, ...paths])));
              setSelectedExecutionFiles((prev) => Array.from(new Set([...prev, ...paths])));
            }
          } else if (event.payload.type === "leave") {
            setIsDragOver(false);
          }
        });
      } catch {
        // noop
      }
    };

    setup();
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (selectedFiles.length === 0) {
      if (Object.keys(filesMetadata).length > 0) {
        setFilesMetadata({});
      }
      return;
    }

    const newFiles = selectedFiles.filter((f) => !filesMetadata[f]);
    if (newFiles.length === 0) {
      return;
    }

    const fetchMeta = async () => {
      try {
        const metas = await invoke<FileMetadataInfo[]>("get_files_metadata", { filePaths: newFiles });
        setFilesMetadata((prev) => {
          const merged = { ...prev };
          for (const m of metas) {
            merged[m.path] = m;
          }
          return merged;
        });
      } catch {
        // noop
      }
    };

    fetchMeta();
  }, [selectedFiles, filesMetadata]);

  const filteredFiles = useMemo(() => {
    return selectedFiles.filter((path) => {
      const meta = filesMetadata[path];
      const fileName = meta?.file_name ?? path.split(/[/\\]/).pop() ?? path;
      const ext = (meta?.extension ?? "").toLowerCase();

      if (filterKeyword && !fileName.toLowerCase().includes(filterKeyword.toLowerCase())) {
        return false;
      }

      if (filterExtension && ext !== filterExtension.toLowerCase().replace(".", "")) {
        return false;
      }

      const fileDate = meta?.created_ms ?? meta?.modified_ms ?? null;
      if (fileDate && filterDateAfter) {
        const after = new Date(filterDateAfter).getTime();
        if (fileDate < after) {
          return false;
        }
      }
      if (fileDate && filterDateBefore) {
        const before = new Date(filterDateBefore).getTime() + 86400000;
        if (fileDate > before) {
          return false;
        }
      }

      return true;
    });
  }, [selectedFiles, filesMetadata, filterKeyword, filterExtension, filterDateAfter, filterDateBefore]);
  const selectedInFiltered = useMemo(
    () => filteredFiles.filter((f) => selectedExecutionFiles.includes(f)),
    [filteredFiles, selectedExecutionFiles]
  );
  const effectiveTargets = selectedInFiltered.length > 0 ? selectedInFiltered : filteredFiles;
  const isSaveDestinationReady =
    saveMode === "append_single" ? appendOutputFile.trim().length > 0 : individualOutputDir.trim().length > 0;
  const extractionDisabled = isProcessing || effectiveTargets.length === 0 || !isSaveDestinationReady;

  const handleSelectFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Documents & Images",
          extensions: ["pdf", "txt", "md", "csv", "json", "png", "jpg", "jpeg", "webp"],
        },
      ],
    });

    if (Array.isArray(selected)) {
      setSelectedFiles((prev) => Array.from(new Set([...prev, ...selected])));
      setSelectedExecutionFiles((prev) => Array.from(new Set([...prev, ...selected])));
    } else if (selected) {
      setSelectedFiles((prev) => Array.from(new Set([...prev, selected])));
      setSelectedExecutionFiles((prev) => Array.from(new Set([...prev, selected])));
    }
  };

  const handleSelectFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") {
      return;
    }

    try {
      const files = await invoke<string[]>("list_files_in_directory", { directoryPath: selected });
      setSelectedFiles((prev) => Array.from(new Set([...prev, ...files])));
      setSelectedExecutionFiles((prev) => Array.from(new Set([...prev, ...files])));
    } catch (e) {
      alert(`フォルダ読み込みエラー: ${e}`);
    }
  };

  const handleSelectIndividualOutputDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setIndividualOutputDir(selected);
    }
  };

  const handleSelectAppendOutputFile = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Text/Markdown/CSV/JSON", extensions: ["txt", "md", "csv", "json"] }],
    });
    if (typeof selected === "string") {
      setAppendOutputFile(selected);
    }
  };

  const handleSelectSaveDestination = async () => {
    if (saveMode === "save_individual") {
      await handleSelectIndividualOutputDir();
      return;
    }
    await handleSelectAppendOutputFile();
  };

  const handleClearFiles = () => {
    setSelectedFiles([]);
    setSelectedExecutionFiles([]);
    setResults([]);
    setProgressText("");
  };

  const handleToggleExecutionFile = (path: string, checked: boolean) => {
    setSelectedExecutionFiles((prev) => {
      if (checked) {
        if (prev.includes(path)) return prev;
        return [...prev, path];
      }
      return prev.filter((p) => p !== path);
    });
  };

  const handleSelectAllFiltered = () => {
    setSelectedExecutionFiles((prev) => Array.from(new Set([...prev, ...filteredFiles])));
  };

  const handleClearSelectionFiltered = () => {
    const visible = new Set(filteredFiles);
    setSelectedExecutionFiles((prev) => prev.filter((p) => !visible.has(p)));
  };

  const handleInvertSelectionFiltered = () => {
    const selectedSet = new Set(selectedExecutionFiles);
    setSelectedExecutionFiles((prev) => {
      const base = prev.filter((p) => !filteredFiles.includes(p));
      const inverted = filteredFiles.filter((p) => !selectedSet.has(p));
      return [...base, ...inverted];
    });
  };

  const runExtraction = async () => {
    const targets = effectiveTargets;
    if (targets.length === 0) {
      return;
    }
    if (saveMode === "append_single" && appendOutputFile.trim().length === 0) {
      alert("追記先ファイルを設定してください。");
      return;
    }
    if (saveMode === "save_individual" && individualOutputDir.trim().length === 0) {
      alert("出力フォルダを設定してください。");
      return;
    }

    setIsProcessing(true);
    setResults([]);

    const appendTargetPath = appendOutputFile.trim();
    const individualDir = individualOutputDir.trim();
    const ext = outputFormat;

    try {
      if (saveMode === "append_single") {
        if (!appendTargetPath) return;
      } else {
        if (!individualDir) return;
      }

      const nextResults: ExtractionResult[] = [];

      for (let i = 0; i < targets.length; i += 1) {
        const filePath = targets[i];
        const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
        setProgressText(`処理中 (${i + 1}/${targets.length}): ${fileName}`);

        try {
          const preview = await invoke<FilePreviewData>("read_file_preview", { filePath });

          if (!preview.content) {
            throw new Error("プレビュー内容が取得できませんでした");
          }
          if (preview.content === "FILE_TOO_LARGE") {
            throw new Error("ファイルが大きすぎるため処理できません");
          }
          if (preview.content.startsWith("READ_ERROR")) {
            throw new Error(preview.content);
          }

          const augmentInstructions = buildPromptAugmentInstructions(
            promptAugmentOptions,
            outputFormat,
            useYamlFrontmatter
          );
          const prompt = buildPrompt(
            outputFormat,
            useYamlFrontmatter,
            customPrompt,
            augmentInstructions,
            filePath,
            preview
          );
          const aiText = await invoke<string>("generate_text", { prompt });
          const normalized = normalizeOutput(outputFormat, useYamlFrontmatter, filePath, aiText);

          let savePath = "";
          let contentToWrite = normalized;
          let append = false;

          if (saveMode === "append_single") {
            savePath = appendTargetPath;
            append = true;
            if (outputFormat === "md") {
              contentToWrite = `\n\n## ${sanitizeFileName(getBaseName(filePath))}\n\n${normalized}`;
            } else if (outputFormat === "txt") {
              contentToWrite = `\n\n[${fileName}]\n${normalized}`;
            } else if (outputFormat === "json") {
              contentToWrite = `\n${normalized}`;
            } else {
              contentToWrite = `\n${normalized}`;
            }
          } else {
            const base = sanitizeFileName(getBaseName(filePath));
            savePath = joinPath(individualDir, `${base}.${ext}`);
          }

          await invoke("save_extracted_data", {
            filePath: savePath,
            content: contentToWrite,
            append,
          });

          nextResults.push({
            filePath,
            fileName,
            success: true,
            output: normalized,
            savedPath: savePath,
          });
        } catch (e) {
          nextResults.push({
            filePath,
            fileName,
            success: false,
            output: "",
            error: String(e),
          });
        }
      }

      setResults(nextResults);
      setProgressText("処理が完了しました");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveTemplate = () => {
    if (!selectedTemplate) return;
    const prompt = customPrompt.trim();
    if (!prompt) return;

    setPromptTemplates((prev) =>
      prev.map((t) => (t.id === selectedTemplate.id ? { ...t, prompt } : t))
    );
  };

  const handleCreateTemplate = () => {
    const name = window.prompt("新規テンプレート名を入力してください", `カスタム${promptTemplates.length + 1}`);
    const trimmedName = (name ?? "").trim();
    if (!trimmedName) return;

    const prompt = customPrompt.trim();
    if (!prompt) return;

    const next: PromptTemplate = {
      id: `custom-${Date.now()}`,
      name: trimmedName,
      prompt,
    };
    setPromptTemplates((prev) => [next, ...prev]);
    setSelectedTemplateId(next.id);
  };

  const handleDeleteTemplate = () => {
    if (!selectedTemplate) return;
    if (promptTemplates.length <= 1) return;

    const next = promptTemplates.filter((t) => t.id !== selectedTemplate.id);
    if (next.length === 0) return;
    setPromptTemplates(next);
    setSelectedTemplateId(next[0].id);
    setCustomPrompt(next[0].prompt);
  };

  const loadModelSettings = async (fetchList: boolean) => {
    try {
      const settings = await invoke<ModelSettingsInfo>("get_model_settings");
      setModelId(settings.model_id);
      setHasApiKey(settings.has_api_key);
      if (fetchList) {
        setIsLoadingModels(true);
        setModelMessage("");
        const models = await invoke<ModelListItem[]>("list_available_models");
        setModelOptions(models);
      }
    } catch (e) {
      setModelMessage(String(e));
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleOpenModelSettings = async () => {
    setIsModelSettingsOpen(true);
    await loadModelSettings(true);
  };

  const handleReloadModelList = async () => {
    await loadModelSettings(true);
  };

  const handleSaveModelSettings = async () => {
    const trimmed = modelId.trim();
    if (!trimmed) {
      setModelMessage("モデルIDを入力してください。");
      return;
    }
    setIsSavingModel(true);
    setModelMessage("");
    try {
      await invoke("set_model_id", { modelId: trimmed });
      setModelMessage("モデル設定を保存しました。");
    } catch (e) {
      setModelMessage(String(e));
    } finally {
      setIsSavingModel(false);
    }
  };

  return (
    <div className="silk-surface flex h-screen overflow-hidden bg-[#e9edf3] text-slate-700">
      <aside className="w-44 hidden border-r border-slate-300/80 bg-[#e9edf3] md:flex md:flex-col p-2">
        <div className="px-0.5">
          <h1 className="text-2xl font-bold text-slate-800">OCR+</h1>
          <p className="text-sm text-slate-500">Extract Studio</p>
        </div>
        <nav className="mt-3 flex flex-col items-start gap-1 text-sm">
          <Link
            href="/renamer"
            aria-label="ファイル整理"
            className="inline-flex h-8 w-28 items-center justify-center rounded-lg px-2 text-[12px] text-slate-600 transition hover:text-slate-800 silk-raised border-0 bg-[#e9edf3]"
          >
            ファイル整理
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="AIモデル"
            className="h-8 w-28 justify-center rounded-lg px-2 text-[12px] text-slate-600 hover:text-slate-800 silk-raised border-0 bg-[#e9edf3] hover:bg-[#e9edf3]"
            onClick={handleOpenModelSettings}
          >
            AIモデル
          </Button>
        </nav>

        <div className="mt-4 px-1">
          <h2 className="text-base font-semibold text-slate-800">入力</h2>
          <div className="mt-2 h-px w-32 bg-slate-300/90" />
          <div className="mt-2 flex flex-col items-start gap-1.5">
            <Button
              size="sm"
              type="button"
              className="h-9 w-28 rounded-lg silk-raised border-0 bg-[#e9edf3] text-[11px] text-slate-700 hover:bg-[#e9edf3]"
              onClick={handleSelectFiles}
            >
              ファイル
            </Button>
            <Button
              size="sm"
              type="button"
              className="h-9 w-28 rounded-lg silk-raised border-0 bg-[#e9edf3] text-[11px] text-slate-700 hover:bg-[#e9edf3]"
              onClick={handleSelectFolder}
            >
              フォルダ
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              className="h-8 w-28 rounded-lg text-[11px] text-slate-500 hover:text-slate-700"
              onClick={handleClearFiles}
            >
              クリア
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">D&D対応</p>
        </div>

        <div className="mt-3 px-1">
          <h2 className="text-base font-semibold text-slate-800">保存</h2>
          <div className="mt-2 h-px w-32 bg-slate-300/90" />
          <div className="mt-2 flex flex-col items-start">
            <button
              type="button"
              className={`h-9 w-28 rounded-lg px-2 text-center text-[11px] ${
                saveMode === "save_individual"
                  ? "silk-pressed text-slate-800"
                  : "silk-raised text-slate-500"
              }`}
              onClick={() => setSaveMode("save_individual")}
            >
              出力フォルダ
            </button>
            <button
              type="button"
              className={`mt-1.5 h-9 w-28 rounded-lg px-2 text-center text-[11px] ${
                saveMode === "append_single"
                  ? "silk-pressed text-slate-800"
                  : "silk-raised text-slate-500"
              }`}
              onClick={() => setSaveMode("append_single")}
            >
              追記ファイル
            </button>
          </div>

          <div className="mt-5 flex items-center">
            <Button
              size="sm"
              type="button"
              className="h-9 w-28 rounded-lg silk-raised border-0 bg-[#e9edf3] text-[11px] text-slate-700 hover:bg-[#e9edf3]"
              onClick={handleSelectSaveDestination}
              title={saveMode === "save_individual" ? individualOutputDir || "出力フォルダ" : appendOutputFile || "追記ファイル"}
              aria-label={saveMode === "save_individual" ? "出力フォルダを選択" : "追記ファイルを選択"}
            >
              選択
            </Button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden p-2 md:p-3">
        <div className="grid h-full grid-cols-1 gap-2 xl:grid-cols-[1.35fr_1.65fr] 2xl:grid-cols-[1.2fr_1.8fr]">
          <div className="grid gap-2 grid-rows-1 xl:grid-rows-[0.82fr_1.18fr] min-h-0">
            <Card className="silk-raised min-h-0 border-0 bg-[#e9edf3] flex flex-col rounded-3xl">
              <CardHeader className="pb-1">
                <CardTitle className="text-base text-slate-800">1. 対象ファイル</CardTitle>
                <CardDescription className="text-xs text-slate-500">条件で絞り込み、実行対象を選択</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 pt-0 min-h-0 overflow-hidden">
                <div className={`md:hidden flex flex-wrap justify-center gap-2 rounded-xl p-1 ${isDragOver ? "silk-pressed" : ""}`}>
                  <Button size="sm" className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]" onClick={handleSelectFiles}>
                    ファイル
                  </Button>
                  <Button size="sm" className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]" onClick={handleSelectFolder}>
                    フォルダ
                  </Button>
                  <Button size="sm" variant="ghost" className="text-slate-500" onClick={handleClearFiles}>
                    クリア
                  </Button>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  <Input className="silk-pressed border-0 bg-[#e9edf3] text-slate-700 placeholder:text-slate-400" placeholder="キーワード" value={filterKeyword} onChange={(e) => setFilterKeyword(e.target.value)} />
                  <Input className="silk-pressed border-0 bg-[#e9edf3] text-slate-700 placeholder:text-slate-400" placeholder="拡張子 (pdf)" value={filterExtension} onChange={(e) => setFilterExtension(e.target.value)} />
                  <Input className="silk-pressed border-0 bg-[#e9edf3] text-slate-700" type="date" value={filterDateAfter} onChange={(e) => setFilterDateAfter(e.target.value)} />
                  <Input className="silk-pressed border-0 bg-[#e9edf3] text-slate-700" type="date" value={filterDateBefore} onChange={(e) => setFilterDateBefore(e.target.value)} />
                </div>

                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-500">
                    候補 {filteredFiles.length} / 全体 {selectedFiles.length} / 選択 {selectedInFiltered.length}
                  </p>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button type="button" className="text-slate-500 hover:text-slate-700" onClick={handleSelectAllFiltered}>
                      全選択
                    </button>
                    <button type="button" className="text-slate-500 hover:text-slate-700" onClick={handleClearSelectionFiltered}>
                      解除
                    </button>
                    <button type="button" className="text-slate-500 hover:text-slate-700" onClick={handleInvertSelectionFiltered}>
                      反転
                    </button>
                  </div>
                </div>
                <div className="silk-pressed h-28 overflow-auto rounded-xl p-2 text-xs space-y-1">
                  {filteredFiles.map((p) => (
                    <label key={p} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedExecutionFiles.includes(p)}
                        onChange={(e) => handleToggleExecutionFile(p, e.target.checked)}
                      />
                      <span className="truncate" title={p}>{p}</span>
                    </label>
                  ))}
                  {filteredFiles.length === 0 && <div className="text-slate-500">ファイルがありません</div>}
                </div>
              </CardContent>
            </Card>

            <Card className="silk-raised min-h-0 border-0 bg-[#e9edf3] flex flex-col rounded-3xl">
              <CardHeader className="pb-1">
                <CardTitle className="text-base text-slate-800">2. 抽出設定</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0 overflow-auto">
                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="text-sm font-medium text-slate-700">出力フォーマット</label>
                    <div className="mt-1 grid grid-cols-4 gap-2">
                      {(["txt", "md", "csv", "json"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                            outputFormat === fmt ? "silk-pressed text-slate-800" : "silk-raised text-slate-500"
                          }`}
                          onClick={() => setOutputFormat(fmt)}
                        >
                          {fmt.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={useYamlFrontmatter}
                    disabled={outputFormat !== "md"}
                    onChange={(e) => setUseYamlFrontmatter(e.target.checked)}
                  />
                  YAML Frontmatter (Markdown時のみ)
                </label>

                <div className="md:hidden silk-pressed rounded-xl p-2 space-y-2">
                  <p className="text-xs font-medium text-slate-700">保存先設定</p>
                  <div className="flex flex-col gap-1.5 items-center">
                    <button
                      type="button"
                      className={`h-8 w-28 rounded-lg px-2 text-[11px] ${
                        saveMode === "save_individual" ? "silk-pressed text-slate-800" : "silk-raised text-slate-500"
                      }`}
                      onClick={() => setSaveMode("save_individual")}
                    >
                      出力フォルダ
                    </button>
                    <button
                      type="button"
                      className={`h-8 w-28 rounded-lg px-2 text-[11px] ${
                        saveMode === "append_single" ? "silk-pressed text-slate-800" : "silk-raised text-slate-500"
                      }`}
                      onClick={() => setSaveMode("append_single")}
                    >
                      追記ファイル
                    </button>
                  </div>
                  <div className="flex items-center">
                    <Button
                      size="sm"
                      type="button"
                      className="h-8 w-28 rounded-lg silk-raised border-0 bg-[#e9edf3] text-[11px] text-slate-700 hover:bg-[#e9edf3]"
                      onClick={handleSelectSaveDestination}
                      title={saveMode === "save_individual" ? individualOutputDir || "出力フォルダ" : appendOutputFile || "追記ファイル"}
                      aria-label={saveMode === "save_individual" ? "出力フォルダを選択" : "追記ファイルを選択"}
                    >
                      選択
                    </Button>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-slate-700">カスタムプロンプト</label>
                    <Button
                      size="sm"
                      type="button"
                      className="h-8 px-3 silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]"
                      onClick={() => setIsPromptAugmentOpen(true)}
                    >
                      高度
                    </Button>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
                    <select
                      className="silk-pressed h-9 rounded-xl border-0 bg-[#e9edf3] px-2 text-sm text-slate-700"
                      value={selectedTemplateId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setSelectedTemplateId(id);
                        const selected = promptTemplates.find((tpl) => tpl.id === id);
                        if (selected) setCustomPrompt(selected.prompt);
                      }}
                    >
                      {promptTemplates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]" type="button" onClick={handleSaveTemplate}>
                      保存
                    </Button>
                    <Button size="sm" className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]" type="button" onClick={handleDeleteTemplate}>
                      削除
                    </Button>
                    <Button size="sm" className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]" type="button" onClick={handleCreateTemplate}>
                      新規
                    </Button>
                  </div>
                  <textarea
                    className="silk-pressed mt-2 min-h-[120px] w-full rounded-xl border-0 bg-[#e9edf3] px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400"
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={runExtraction} disabled={extractionDisabled} className="silk-raised gap-2 rounded-xl border-0 bg-[#dce6ff] text-slate-700 hover:bg-[#dce6ff]">
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    {selectedInFiltered.length > 0 ? `選択${selectedInFiltered.length}件を実行` : `候補${filteredFiles.length}件を実行`}
                  </Button>
                  {progressText && <p className="text-xs text-slate-500">{progressText}</p>}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="silk-raised min-h-0 border-0 bg-[#e9edf3] flex flex-col rounded-3xl">
            <CardHeader className="pb-1">
              <CardTitle className="text-base text-slate-800">3. 結果プレビュー</CardTitle>
              <CardDescription className="text-xs text-slate-500">成功/失敗と抽出テキスト</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 pt-0 min-h-0 overflow-hidden">
              <div className="silk-pressed max-h-32 overflow-auto rounded-xl p-1">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-slate-300/90">
                      <TableHead className="text-slate-600">ファイル</TableHead>
                      <TableHead className="text-slate-600">状態</TableHead>
                      <TableHead className="text-slate-600">保存先</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((r) => (
                      <TableRow key={r.filePath}>
                        <TableCell className="max-w-[180px] truncate text-slate-700">{r.fileName}</TableCell>
                        <TableCell className="text-slate-700">{r.success ? "成功" : `失敗: ${r.error}`}</TableCell>
                        <TableCell className="max-w-[180px] truncate text-slate-700">{r.savedPath ?? "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-2 overflow-auto min-h-0">
                {results
                  .filter((r) => r.success)
                  .map((r) => (
                    <div key={`${r.filePath}-preview`} className="silk-pressed rounded-xl p-2">
                      <div className="text-xs font-medium mb-1 flex items-center gap-2">
                        <FileText className="w-3 h-3" />
                        {r.fileName}
                      </div>
                      <pre className="text-xs whitespace-pre-wrap max-h-28 overflow-auto">{r.output}</pre>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {isPromptAugmentOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
          <div className="silk-raised w-full max-w-lg rounded-2xl border border-slate-300/90 bg-[#e9edf3] p-4">
            <h3 className="text-base font-semibold text-slate-800">出力内容の自動加工</h3>
            <p className="mt-1 text-xs text-slate-500">チェック内容は内部的に最終プロンプトへ追記されます。</p>

            <div className="mt-3 space-y-3">
              <div>
                <label className="text-sm font-medium text-slate-700">翻訳出力</label>
                <select
                  className="silk-pressed mt-1 h-9 w-full rounded-xl border-0 bg-[#e9edf3] px-2 text-sm text-slate-700"
                  value={promptAugmentOptions.translationMode}
                  onChange={(e) =>
                    setPromptAugmentOptions((prev) => ({
                      ...prev,
                      translationMode: e.target.value as TranslationMode,
                    }))
                  }
                >
                  <option value="none">なし</option>
                  <option value="ja">日本語に翻訳</option>
                  <option value="en">英語に翻訳</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700">要約モード</label>
                <select
                  className="silk-pressed mt-1 h-9 w-full rounded-xl border-0 bg-[#e9edf3] px-2 text-sm text-slate-700"
                  value={promptAugmentOptions.summaryMode}
                  onChange={(e) =>
                    setPromptAugmentOptions((prev) => ({
                      ...prev,
                      summaryMode: e.target.value as SummaryMode,
                    }))
                  }
                >
                  <option value="none">なし（通常抽出）</option>
                  <option value="bullets3">重要ポイント3件</option>
                  <option value="conclusion">結論のみ</option>
                </select>
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={promptAugmentOptions.maskPii}
                  onChange={(e) =>
                    setPromptAugmentOptions((prev) => ({
                      ...prev,
                      maskPii: e.target.checked,
                    }))
                  }
                />
                個人情報をマスキング（氏名・電話・メール）
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={promptAugmentOptions.yamlAutoTags}
                  onChange={(e) =>
                    setPromptAugmentOptions((prev) => ({
                      ...prev,
                      yamlAutoTags: e.target.checked,
                    }))
                  }
                />
                YAMLタグ自動付与
              </label>
              <p className="text-xs text-slate-500">YAMLタグは Markdown + YAML Frontmatter のときに最も有効です。</p>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="text-slate-600"
                type="button"
                onClick={() => setIsPromptAugmentOpen(false)}
              >
                閉じる
              </Button>
            </div>
          </div>
        </div>
      )}

      {isModelSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
          <div className="silk-raised w-full max-w-xl rounded-2xl border border-slate-300/90 bg-[#e9edf3] p-4">
            <h3 className="text-base font-semibold text-slate-800">AIモデル設定</h3>
            <p className="mt-1 text-xs text-slate-500">
              使用するモデルを選択して保存します。APIキー状態: {hasApiKey ? "設定済み" : "未設定"}
            </p>

            <div className="mt-3 space-y-2">
              <label className="text-sm font-medium text-slate-700">モデル一覧（選択式・推奨）</label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <select
                    className="silk-pressed h-9 w-full min-w-0 rounded-xl border-0 bg-[#e9edf3] px-2 text-sm text-slate-700"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  >
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name} ({m.id})
                      </option>
                    ))}
                    {modelOptions.length === 0 && <option value={modelId || ""}>{modelId || "(モデル未取得)"}</option>}
                  </select>
                </div>
                <Button
                  size="sm"
                  type="button"
                  className="silk-raised shrink-0 border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]"
                  onClick={handleReloadModelList}
                  disabled={isLoadingModels}
                >
                  {isLoadingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : "再取得"}
                </Button>
              </div>

              <label className="text-sm font-medium text-slate-700">モデルID（直接指定）</label>
              <Input
                className="silk-pressed border-0 bg-[#e9edf3] text-slate-700"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="例: gemini-2.5-flash"
              />
              <p className="text-xs text-slate-500">
                一覧は「取得できたモデル候補」。直接指定は未表示モデルや将来モデルを手入力で使うための欄です。
              </p>
              {modelMessage && <p className="text-xs text-slate-600">{modelMessage}</p>}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="text-slate-600"
                type="button"
                onClick={() => setIsModelSettingsOpen(false)}
              >
                閉じる
              </Button>
              <Button
                size="sm"
                className="silk-raised border-0 bg-[#dce6ff] text-slate-700 hover:bg-[#dce6ff]"
                type="button"
                onClick={handleSaveModelSettings}
                disabled={isSavingModel}
              >
                {isSavingModel ? <Loader2 className="h-4 w-4 animate-spin" /> : "保存"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
