"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  Copy,
  FolderOpen,
  Loader2,
  UploadCloud,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type AnalyzeMode = "auto" | "advanced";
type FolderGroupingMode = "none" | "filename" | "extension" | "date";
type RowStatus = "pending" | "ready" | "success" | "error";

interface OrganizeSuggestion {
  original_path: string;
  destination_path: string;
  suggested_name: string;
  reason?: string;
}

interface ExactDuplicateDeleteResult {
  path: string;
  action: "unique" | "kept" | "deleted" | "error";
  kept_path?: string | null;
  error?: string | null;
}

interface TrashMoveResult {
  path: string;
  success: boolean;
  error?: string | null;
}

interface FilingSuggestion {
  original_path: string;
  destination_path: string;
  reason: string;
}

interface RenameSuggestion {
  original_path: string;
  proposed: string;
  reason: string;
}

interface OrganizeResult {
  original_path: string;
  success: boolean;
  new_path?: string;
  error?: string;
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

interface FileMetadataInfo {
  path: string;
  file_name: string;
  extension: string;
  size_bytes: number;
  created_ms: number | null;
  modified_ms: number | null;
}

interface FilingFilter {
  keyword: string;
  extension: string;
  dateAfter: string;
  dateBefore: string;
}

interface FileRow {
  originalPath: string;
  originalName: string;
  newName: string;
  targetDir: string;
  reason: string;
  status: RowStatus;
  resultPath?: string;
  error?: string;
}

interface AdvancedRenameOptions {
  replace_old: string;
  replace_new: string;
  remove_text: string;
  use_regex: boolean;
  regex_pattern: string;
  regex_repl: string;
  prefix: string;
  suffix: string;
  metadata_format: string;
  case_mode: string;
  sequence_enabled: boolean;
  sequence_start: number;
  sequence_digits: number;
  sequence_separator: string;
}

interface FilingPromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

const DEFAULT_ADVANCED_OPTIONS: AdvancedRenameOptions = {
  replace_old: "",
  replace_new: "",
  remove_text: "",
  use_regex: false,
  regex_pattern: "",
  regex_repl: "",
  prefix: "",
  suffix: "",
  metadata_format: "",
  case_mode: "none",
  sequence_enabled: false,
  sequence_start: 1,
  sequence_digits: 3,
  sequence_separator: "_",
};

const CANDIDATE_DIRS_STORAGE_KEY = "ocr_filing_candidate_dirs_v1";
const FILING_TEMPLATE_PREFIX = "__filing_template_v1__:";
const DEFAULT_FILING_TEMPLATES: FilingPromptTemplate[] = [
  {
    id: "filing-default",
    name: "標準（名前+保存先）",
    prompt: "ファイル内容を読み取り、適切なファイル名と最適な保存先フォルダをセットで提案してください。",
  },
  {
    id: "filing-invoice",
    name: "請求書・領収書",
    prompt: "請求書・領収書は、日付_発行元_金額の形式でファイル名を提案し、保存先も提案してください。",
  },
  {
    id: "filing-contract",
    name: "契約書・申込書",
    prompt: "契約書・申込書は、書類種別_相手先_日付の形式でファイル名を提案し、保存先も提案してください。",
  },
  {
    id: "filing-image",
    name: "画像ファイル整理",
    prompt: "画像ファイルは内容を要約した短い日本語名を提案し、拡張子は維持してください。",
  },
];
const AUTO_FOLDER_SEGMENT_MAX = 36;
const AUTO_FOLDER_COUNT_LIMIT = 40;
const AUTO_FOLDER_FALLBACK = "その他";
const SAFE_PATH_LENGTH_LIMIT = 230;
const ANALYZE_TIMEOUT_MS = 60000;
const ANALYZE_RETRY_COOLDOWN_MS = 3000;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function extractFileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function withOriginalExtension(originalName: string, proposed: string): string {
  const p = proposed.trim();
  if (!p) return originalName;
  if (p.includes(".")) return p;
  const ext = originalName.includes(".") ? originalName.split(".").pop() : "";
  return ext ? `${p}.${ext}` : p;
}

function suggestTemplateName(prompt: string, index: number): string {
  const p = prompt.trim();
  if (!p) return `テンプレ${index + 1}`;
  if (p.includes("請求書") || p.includes("領収書")) return "請求書・領収書";
  if (p.includes("契約書") || p.includes("申込書")) return "契約書・申込書";
  if (p.includes("画像")) return "画像ファイル整理";
  if (p.includes("不明")) return "不明ファイル対応";
  if (p.includes("保存先") && p.includes("ファイル名")) return "標準（名前+保存先）";
  return `テンプレ${index + 1}`;
}

function encodeTemplate(template: FilingPromptTemplate): string {
  return `${FILING_TEMPLATE_PREFIX}${JSON.stringify({
    name: template.name,
    prompt: template.prompt,
  })}`;
}

function decodeTemplate(raw: string, index: number): FilingPromptTemplate {
  if (raw.startsWith(FILING_TEMPLATE_PREFIX)) {
    const payload = raw.slice(FILING_TEMPLATE_PREFIX.length);
    try {
      const parsed = JSON.parse(payload) as { name?: string; prompt?: string };
      const name = (parsed.name ?? "").trim();
      const prompt = (parsed.prompt ?? "").trim();
      if (name && prompt) {
        return { id: `stored-${index}`, name, prompt };
      }
    } catch {
      // fallback below
    }
  }

  const prompt = raw.trim();
  return {
    id: `legacy-${index}`,
    name: suggestTemplateName(prompt, index),
    prompt,
  };
}

function normalizeFolderSegment(raw: string): string {
  let normalized = raw
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!normalized) {
    normalized = AUTO_FOLDER_FALLBACK;
  }
  if (WINDOWS_RESERVED_NAMES.has(normalized.toUpperCase())) {
    normalized = `${normalized}_folder`;
  }
  if (normalized.length > AUTO_FOLDER_SEGMENT_MAX) {
    normalized = normalized.slice(0, AUTO_FOLDER_SEGMENT_MAX).trim();
  }
  return normalized || AUTO_FOLDER_FALLBACK;
}

function getFileStem(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0) return fileName;
  return fileName.slice(0, idx);
}

function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx < 0 || idx === fileName.length - 1) return "";
  return fileName.slice(idx + 1).toLowerCase();
}

function joinWindowsPath(base: string, segment: string): string {
  const b = base.replace(/[\\/]+$/g, "");
  if (!segment) return b;
  return `${b}\\${segment}`;
}

function safeDateFolder(ms?: number | null): string {
  if (!ms || Number.isNaN(ms)) return "日付不明";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "日付不明";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function capSegmentForPath(baseDir: string, segment: string, fileName: string): string {
  const roughLength = `${baseDir}\\${segment}\\${fileName}`.length;
  if (roughLength <= SAFE_PATH_LENGTH_LIMIT) return segment;

  const budget = Math.max(8, SAFE_PATH_LENGTH_LIMIT - baseDir.length - fileName.length - 2);
  return normalizeFolderSegment(segment).slice(0, budget);
}

export default function FilingPage() {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [destinationDirs, setDestinationDirs] = useState<string[]>([]);
  const [mode, setMode] = useState<AnalyzeMode>("auto");
  const [prompt, setPrompt] = useState(DEFAULT_FILING_TEMPLATES[0].prompt);
  const [savedTemplates, setSavedTemplates] = useState<FilingPromptTemplate[]>(DEFAULT_FILING_TEMPLATES);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(DEFAULT_FILING_TEMPLATES[0].id);
  const [advancedOptions, setAdvancedOptions] = useState<AdvancedRenameOptions>(DEFAULT_ADVANCED_OPTIONS);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [filesMetadata, setFilesMetadata] = useState<Record<string, FileMetadataInfo>>({});
  const [filterDraft, setFilterDraft] = useState<FilingFilter>({
    keyword: "",
    extension: "",
    dateAfter: "",
    dateBefore: "",
  });
  const [filterApplied, setFilterApplied] = useState<FilingFilter>({
    keyword: "",
    extension: "",
    dateAfter: "",
    dateBefore: "",
  });
  const [selectedRowPath, setSelectedRowPath] = useState<string>("");
  const [preview, setPreview] = useState<FilePreviewData | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isAnalyzeCooldown, setIsAnalyzeCooldown] = useState(false);
  const [analyzePhaseText, setAnalyzePhaseText] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [isDeduping, setIsDeduping] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const [selectedRowPaths, setSelectedRowPaths] = useState<string[]>([]);
  const [isMoveMode, setIsMoveMode] = useState(true);
  const [folderGroupingMode, setFolderGroupingMode] = useState<FolderGroupingMode>("none");
  const [isFolderGroupingPanelOpen, setIsFolderGroupingPanelOpen] = useState(false);
  const analyzeRequestSeqRef = useRef(0);
  const analyzeCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const candidatePathDisplay =
    destinationDirs.length === 0
      ? "未設定"
      : `${destinationDirs[0]}${destinationDirs.length > 1 ? ` (+${destinationDirs.length - 1})` : ""}`;

  const filteredRows = useMemo(() => {
    const isFilterActive =
      !!filterApplied.keyword ||
      !!filterApplied.extension ||
      !!filterApplied.dateAfter ||
      !!filterApplied.dateBefore;
    if (!isFilterActive) return rows;

    return rows.filter((row) => {
      const meta = filesMetadata[row.originalPath];
      const fileName = meta?.file_name ?? row.originalName;
      const ext = (meta?.extension ?? "").toLowerCase();

      if (filterApplied.keyword && !fileName.toLowerCase().includes(filterApplied.keyword.toLowerCase())) {
        return false;
      }
      if (filterApplied.extension && ext !== filterApplied.extension.toLowerCase().replace(".", "")) {
        return false;
      }

      const fileDate = meta?.created_ms ?? meta?.modified_ms ?? null;
      if (fileDate && filterApplied.dateAfter) {
        const after = new Date(filterApplied.dateAfter).getTime();
        if (fileDate < after) return false;
      }
      if (fileDate && filterApplied.dateBefore) {
        const before = new Date(filterApplied.dateBefore).getTime() + 86400000;
        if (fileDate > before) return false;
      }
      return true;
    });
  }, [rows, filesMetadata, filterApplied]);

  const allVisibleSelected =
    filteredRows.length > 0 && filteredRows.every((row) => selectedRowPaths.includes(row.originalPath));

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CANDIDATE_DIRS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const valid = parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (valid.length > 0) setDestinationDirs(Array.from(new Set(valid)));
    } catch {
      // noop
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CANDIDATE_DIRS_STORAGE_KEY, JSON.stringify(destinationDirs));
    } catch {
      // noop
    }
  }, [destinationDirs]);

  useEffect(() => {
    invoke<string[]>("get_templates")
      .then((res) => {
        const decoded = res
          .map((raw, index) => decodeTemplate(raw, index))
          .filter((t) => t.prompt.trim().length > 0);
        const templates = decoded.length > 0 ? decoded : DEFAULT_FILING_TEMPLATES;
        setSavedTemplates(templates);
        setSelectedTemplateId(templates[0].id);
        setPrompt(templates[0].prompt);
      })
      .catch(() => {
        setSavedTemplates(DEFAULT_FILING_TEMPLATES);
        setSelectedTemplateId(DEFAULT_FILING_TEMPLATES[0].id);
        setPrompt(DEFAULT_FILING_TEMPLATES[0].prompt);
      });
  }, []);

  useEffect(() => {
    setRows((prev) => {
      const prevMap = new Map(prev.map((r) => [r.originalPath, r]));
      return selectedFiles.map((path) => {
        const old = prevMap.get(path);
        const fileName = extractFileName(path);
        if (old) {
          return {
            ...old,
            targetDir: destinationDirs[0] ?? "",
          };
        }
        return {
          originalPath: path,
          originalName: fileName,
          newName: fileName,
          targetDir: destinationDirs[0] ?? "",
          reason: "",
          status: "pending" as RowStatus,
        };
      });
    });
  }, [selectedFiles, destinationDirs]);

  useEffect(() => {
    const valid = new Set(rows.map((r) => r.originalPath));
    setSelectedRowPaths((prev) => prev.filter((p) => valid.has(p)));
  }, [rows]);

  useEffect(() => {
    if (selectedFiles.length === 0) {
      if (Object.keys(filesMetadata).length > 0) setFilesMetadata({});
      return;
    }

    const newFiles = selectedFiles.filter((f) => !filesMetadata[f]);
    if (newFiles.length === 0) return;

    invoke<FileMetadataInfo[]>("get_files_metadata", { filePaths: newFiles })
      .then((metas) => {
        setFilesMetadata((prev) => {
          const next = { ...prev };
          for (const m of metas) next[m.path] = m;
          return next;
        });
      })
      .catch(() => {
        // noop
      });
  }, [selectedFiles, filesMetadata]);

  useEffect(() => {
    if (!selectedRowPath && rows.length > 0) setSelectedRowPath(rows[0].originalPath);
    if (rows.length === 0) {
      setSelectedRowPath("");
      setPreview(null);
    }
  }, [rows, selectedRowPath]);

  useEffect(() => {
    if (!selectedRowPath) return;
    let active = true;
    setIsPreviewLoading(true);
    invoke<FilePreviewData>("read_file_preview", { filePath: selectedRowPath })
      .then((res) => {
        if (active) setPreview(res);
      })
      .catch(() => {
        if (active) setPreview(null);
      })
      .finally(() => {
        if (active) setIsPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedRowPath]);

  useEffect(() => {
    return () => {
      if (analyzeCooldownTimerRef.current) {
        clearTimeout(analyzeCooldownTimerRef.current);
        analyzeCooldownTimerRef.current = null;
      }
    };
  }, []);

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
    if (Array.isArray(selected)) setSelectedFiles((prev) => Array.from(new Set([...prev, ...selected])));
    else if (selected) setSelectedFiles((prev) => Array.from(new Set([...prev, selected])));
  };

  const handleSelectSourceFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      const files = await invoke<string[]>("list_files_in_directory", { directoryPath: selected });
      if (files.length > 0) setSelectedFiles((prev) => Array.from(new Set([...prev, ...files])));
    } catch (e) {
      alert(`フォルダ読み込みエラー: ${e}`);
    }
  };

  const handleSelectFolders = async () => {
    const selected = await open({ directory: true, multiple: true });
    if (Array.isArray(selected)) setDestinationDirs((prev) => Array.from(new Set([...prev, ...selected])));
    else if (selected) setDestinationDirs((prev) => Array.from(new Set([...prev, selected])));
  };

  const applyCombinedSuggestions = (renameSuggestions: RenameSuggestion[], filingSuggestions: FilingSuggestion[]) => {
    const renameByPath = new Map(renameSuggestions.map((s) => [s.original_path, s]));
    const filingByPath = new Map(filingSuggestions.map((s) => [s.original_path, s]));

    setRows((prev) =>
      prev.map((row) => {
        const rename = renameByPath.get(row.originalPath);
        const filing = filingByPath.get(row.originalPath);
        if (!rename && !filing) return row;
        return {
          ...row,
          newName: rename ? withOriginalExtension(row.originalName, rename.proposed) : row.newName,
          targetDir: filing?.destination_path ?? row.targetDir,
          reason: rename?.reason || filing?.reason || "",
          status: "ready",
          error: undefined,
        };
      })
    );
  };

  const buildEffectiveAutoPrompt = (basePrompt: string): string => {
    const trimmed = basePrompt.trim();
    if (folderGroupingMode === "none") return trimmed;

    const policy =
      folderGroupingMode === "filename"
        ? "出力先配下ではファイル名（拡張子除く）を正規化したサブフォルダへ振り分ける前提で、命名提案をしてください。"
        : folderGroupingMode === "extension"
          ? "出力先配下では拡張子ごとのサブフォルダへ振り分ける前提で、命名提案をしてください。"
          : "出力先配下では作成日/更新日ベース（YYYY-MM）のサブフォルダへ振り分ける前提で、命名提案をしてください。";

    return `${trimmed}\n\n【追加条件】\n${policy}\n保存先フォルダは候補から選択し、サブフォルダ方針も考慮した理由を簡潔に添えてください。`;
  };

  const startAnalyzeCooldown = () => {
    setIsAnalyzeCooldown(true);
    if (analyzeCooldownTimerRef.current) {
      clearTimeout(analyzeCooldownTimerRef.current);
    }
    analyzeCooldownTimerRef.current = setTimeout(() => {
      setIsAnalyzeCooldown(false);
      analyzeCooldownTimerRef.current = null;
    }, ANALYZE_RETRY_COOLDOWN_MS);
  };

  const handleAnalyze = async () => {
    const targetFiles = filteredRows.map((r) => r.originalPath);
    if (targetFiles.length === 0) return;
    if (mode === "auto" && destinationDirs.length === 0) return;
    if (isAnalyzeCooldown) return;

    const requestId = analyzeRequestSeqRef.current + 1;
    analyzeRequestSeqRef.current = requestId;
    const isStale = () => analyzeRequestSeqRef.current !== requestId;
    setIsAnalyzing(true);
    setAnalyzePhaseText(mode === "auto" ? "解析準備中..." : "ルール適用中...");
    try {
      if (mode === "auto") {
        const effectivePrompt = buildEffectiveAutoPrompt(prompt);
        setAnalyzePhaseText("AI問い合わせ中...");
        const suggestions = await Promise.race([
          invoke<OrganizeSuggestion[]>("propose_organize", {
            prompt: effectivePrompt,
            filePaths: targetFiles,
            destinationDirs,
          }),
          new Promise<OrganizeSuggestion[]>((_, reject) =>
            setTimeout(() => reject(new Error("AI解析がタイムアウトしました（60秒）")), ANALYZE_TIMEOUT_MS)
          ),
        ]);
        if (isStale()) return;
        const byPath = new Map(suggestions.map((s) => [s.original_path, s]));

        setRows((prev) =>
          prev.map((row) => {
            const s = byPath.get(row.originalPath);
            if (!s) return row;
            return {
              ...row,
              newName: withOriginalExtension(row.originalName, s.suggested_name),
              targetDir: s.destination_path || row.targetDir,
              reason: s.reason ?? "",
              status: "ready",
              error: undefined,
            };
          })
        );
      } else {
        setAnalyzePhaseText("ルールを適用中...");
        const renameSuggestions = await invoke<RenameSuggestion[]>("propose_advanced_renames", {
          options: advancedOptions,
          filePaths: targetFiles,
        });
        if (isStale()) return;
        const renameByPath = new Map(renameSuggestions.map((s) => [s.original_path, s]));
        setRows((prev) =>
          prev.map((row) => {
            const rename = renameByPath.get(row.originalPath);
            if (!rename) return row;
            return {
              ...row,
              newName: withOriginalExtension(row.originalName, rename.proposed),
              reason: rename.reason || "",
              status: "ready",
              error: undefined,
            };
          })
        );
      }
    } catch (e) {
      if (isStale()) return;
      const message = String(e);
      const isTimeoutError =
        message.includes("タイムアウト") || message.toLowerCase().includes("timeout");
      if (isTimeoutError) {
        startAnalyzeCooldown();
        alert("AI解析がタイムアウトしました。3秒後に再試行できます。");
      } else {
        alert(`${mode === "advanced" ? "ルール適用" : "AI解析"}エラー: ${message}`);
      }
    } finally {
      if (!isStale()) {
        setIsAnalyzing(false);
        setAnalyzePhaseText("");
      }
    }
  };

  const persistTemplates = async (templates: FilingPromptTemplate[]) => {
    setSavedTemplates(templates);
    try {
      await invoke("save_templates", { templates: templates.map(encodeTemplate) });
    } catch {
      // noop
    }
  };

  const handleSaveTemplate = async () => {
    const t = prompt.trim();
    if (!t) return;

    const selected = savedTemplates.find((tpl) => tpl.id === selectedTemplateId);
    if (!selected) return;

    const nextTemplates = savedTemplates.map((tpl) =>
      tpl.id === selectedTemplateId
        ? { ...tpl, prompt: t }
        : tpl
    );
    await persistTemplates(nextTemplates);
  };

  const handleCreateTemplate = async () => {
    const name = window.prompt("新規テンプレート名を入力してください", `カスタム${savedTemplates.length + 1}`);
    const trimmedName = (name ?? "").trim();
    if (!trimmedName) return;

    const body = prompt.trim();
    if (!body) {
      alert("プロンプト欄が空です。");
      return;
    }

    const newTemplate: FilingPromptTemplate = {
      id: `custom-${Date.now()}`,
      name: trimmedName,
      prompt: body,
    };
    const nextTemplates = [newTemplate, ...savedTemplates];
    await persistTemplates(nextTemplates);
    setSelectedTemplateId(newTemplate.id);
  };

  const handleDeleteTemplate = async () => {
    if (savedTemplates.length <= 1) {
      alert("テンプレートは最低1つ必要です。");
      return;
    }
    const target = savedTemplates.find((tpl) => tpl.id === selectedTemplateId);
    if (!target) return;
    const ok = window.confirm(`テンプレート「${target.name}」を削除しますか？`);
    if (!ok) return;

    const nextTemplates = savedTemplates.filter((tpl) => tpl.id !== selectedTemplateId);
    const fallback = nextTemplates[0] ?? DEFAULT_FILING_TEMPLATES[0];
    await persistTemplates(nextTemplates);
    setSelectedTemplateId(fallback.id);
    setPrompt(fallback.prompt);
  };

  const handleApplyFilter = () => {
    setFilterApplied({ ...filterDraft });
  };

  const handleClearFilter = () => {
    const empty = { keyword: "", extension: "", dateAfter: "", dateBefore: "" };
    setFilterDraft(empty);
    setFilterApplied(empty);
  };

  const buildFolderSegmentForRow = (row: FileRow): string => {
    if (folderGroupingMode === "none") return "";

    if (folderGroupingMode === "filename") {
      const stem = getFileStem(row.newName || row.originalName);
      return normalizeFolderSegment(stem);
    }

    if (folderGroupingMode === "extension") {
      const ext = getFileExtension(row.newName || row.originalName) || filesMetadata[row.originalPath]?.extension || "";
      return normalizeFolderSegment(ext || "拡張子なし");
    }

    const meta = filesMetadata[row.originalPath];
    const ms = meta?.created_ms ?? meta?.modified_ms ?? null;
    return normalizeFolderSegment(safeDateFolder(ms));
  };

  const buildTargetDirPlan = (targets: FileRow[]): Map<string, string> => {
    const planned = new Map<string, string>();
    const seenFolderKeys = new Set<string>();

    for (const row of targets) {
      const base = (row.targetDir.trim() || destinationDirs[0] || "").trim();
      if (!base) continue;

      let segment = buildFolderSegmentForRow(row);
      if (folderGroupingMode === "filename" && segment) {
        const segmentKey = segment.toLowerCase();
        if (!seenFolderKeys.has(segmentKey) && seenFolderKeys.size >= AUTO_FOLDER_COUNT_LIMIT) {
          segment = AUTO_FOLDER_FALLBACK;
        }
        seenFolderKeys.add(segment.toLowerCase());
      }

      if (!segment) {
        planned.set(row.originalPath, base);
        continue;
      }

      segment = capSegmentForPath(base, segment, row.newName || row.originalName);
      planned.set(row.originalPath, joinWindowsPath(base, segment));
    }

    return planned;
  };
  const plannedTargetDirByPath = useMemo(
    () => buildTargetDirPlan(rows),
    [rows, folderGroupingMode, destinationDirs, filesMetadata]
  );

  const handleExecute = async () => {
    const targetPathSet = new Set(filteredRows.map((r) => r.originalPath));
    const targets = rows.filter(
      (r) =>
        targetPathSet.has(r.originalPath) &&
        (r.targetDir.trim().length > 0 || destinationDirs.length > 0) &&
        r.newName.trim().length > 0
    );
    if (targets.length === 0) return;
    const targetDirPlan = buildTargetDirPlan(targets);

    setIsExecuting(true);
    const resultMap = new Map<string, OrganizeResult>();
    const sourcePathMap = new Map<string, string>();
    const movedPathMap = new Map<string, string>();

    for (const row of targets) {
      const sourcePath = row.resultPath?.trim() ? row.resultPath : row.originalPath;
      sourcePathMap.set(row.originalPath, sourcePath);
      const effectiveTargetDir = targetDirPlan.get(row.originalPath) ?? row.targetDir;
      try {
        const res = await invoke<OrganizeResult>("organize_file", {
          request: {
            original_path: sourcePath,
            target_dir: effectiveTargetDir,
            new_filename: row.newName,
            is_move: isMoveMode,
          },
        });
        resultMap.set(row.originalPath, res);
        if (res.success && res.new_path) {
          movedPathMap.set(row.originalPath, res.new_path);
        }
      } catch (e) {
        resultMap.set(row.originalPath, {
          original_path: row.originalPath,
          success: false,
          error: String(e),
        });
      }
    }

    setRows((prev) =>
      prev.map((row) => {
        const res = resultMap.get(row.originalPath);
        if (!res) return row;
        if (res.success) {
          const nextPath =
            movedPathMap.get(row.originalPath) ??
            sourcePathMap.get(row.originalPath) ??
            row.resultPath ??
            row.originalPath;
          const nextName = extractFileName(nextPath);
          return {
            ...row,
            originalPath: nextPath,
            originalName: nextName,
            newName: nextName,
            status: "pending",
            reason: "",
            resultPath: undefined,
            error: undefined,
          };
        }
        return {
          ...row,
          status: "error",
          error: res.error ?? "実行に失敗しました",
        };
      })
    );

    if (movedPathMap.size > 0) {
      setSelectedFiles((prev) => Array.from(new Set(prev.map((p) => movedPathMap.get(p) ?? p))));
      setSelectedRowPath((prev) => movedPathMap.get(prev) ?? prev);
      setFilesMetadata((prev) => {
        const next: Record<string, FileMetadataInfo> = {};
        for (const [path, meta] of Object.entries(prev)) {
          const mapped = movedPathMap.get(path) ?? path;
          next[mapped] = { ...meta, path: mapped, file_name: extractFileName(mapped) };
        }
        return next;
      });
    }

    setIsExecuting(false);
  };

  const handleDeleteExactDuplicates = async () => {
    const targetFiles = Array.from(
      new Set(
        filteredRows
          .map((r) => (r.resultPath?.trim() ? r.resultPath : r.originalPath))
          .filter((p): p is string => !!p)
      )
    );
    if (targetFiles.length === 0) return;

    setIsDeduping(true);
    try {
      const results = await invoke<ExactDuplicateDeleteResult[]>("delete_exact_duplicates", {
        filePaths: targetFiles,
      });

      const deletedSet = new Set(results.filter((r) => r.action === "deleted").map((r) => r.path));
      const keptCount = results.filter((r) => r.action === "kept").length;
      const deletedCount = deletedSet.size;
      const errorCount = results.filter((r) => r.action === "error").length;

      if (deletedSet.size > 0) {
        setSelectedFiles((prev) => prev.filter((p) => !deletedSet.has(p)));
        setRows((prev) => prev.filter((r) => !deletedSet.has(r.originalPath) && !deletedSet.has(r.resultPath ?? "")));
        setFilesMetadata((prev) => {
          const next = { ...prev };
          for (const p of deletedSet) {
            delete next[p];
          }
          return next;
        });
        setSelectedRowPath((prev) => (deletedSet.has(prev) ? "" : prev));
      }

      if (errorCount > 0) {
        const firstErr = results.find((r) => r.action === "error" && r.error)?.error ?? "不明なエラー";
        alert(`完全重複削除: 削除 ${deletedCount}件 / 保持 ${keptCount}件 / エラー ${errorCount}件\n${firstErr}`);
      } else {
        alert(`完全重複削除: 削除 ${deletedCount}件 / 保持 ${keptCount}件`);
      }
    } catch (e) {
      alert(`完全重複削除エラー: ${e}`);
    } finally {
      setIsDeduping(false);
    }
  };

  const handleToggleSelectAllVisible = (checked: boolean) => {
    if (checked) {
      const merged = new Set([...selectedRowPaths, ...filteredRows.map((r) => r.originalPath)]);
      setSelectedRowPaths(Array.from(merged));
      return;
    }
    const visible = new Set(filteredRows.map((r) => r.originalPath));
    setSelectedRowPaths((prev) => prev.filter((p) => !visible.has(p)));
  };

  const handleToggleRowSelection = (path: string, checked: boolean) => {
    setSelectedRowPaths((prev) => {
      if (checked) {
        if (prev.includes(path)) return prev;
        return [...prev, path];
      }
      return prev.filter((p) => p !== path);
    });
  };

  const handleTrashSelectedRows = async () => {
    const selectedSet = new Set(selectedRowPaths);
    const targetRows = filteredRows.filter((r) => selectedSet.has(r.originalPath));
    if (targetRows.length === 0) return;

    const targetPaths = Array.from(
      new Set(targetRows.map((r) => (r.resultPath?.trim() ? r.resultPath : r.originalPath)))
    );

    setIsTrashing(true);
    try {
      const results = await invoke<TrashMoveResult[]>("move_files_to_trash", {
        filePaths: targetPaths,
      });
      const deletedSet = new Set(results.filter((r) => r.success).map((r) => r.path));
      const deletedCount = deletedSet.size;
      const errorCount = results.filter((r) => !r.success).length;

      if (deletedSet.size > 0) {
        setSelectedFiles((prev) => prev.filter((p) => !deletedSet.has(p)));
        setRows((prev) => prev.filter((r) => !deletedSet.has(r.originalPath) && !deletedSet.has(r.resultPath ?? "")));
        setFilesMetadata((prev) => {
          const next = { ...prev };
          for (const p of deletedSet) {
            delete next[p];
          }
          return next;
        });
        setSelectedRowPath((prev) => (deletedSet.has(prev) ? "" : prev));
      }
      setSelectedRowPaths([]);

      if (errorCount > 0) {
        const firstErr = results.find((r) => !r.success && r.error)?.error ?? "不明なエラー";
        alert(`ゴミ箱移動: 成功 ${deletedCount}件 / エラー ${errorCount}件\n${firstErr}`);
      } else {
        alert(`ゴミ箱移動: 成功 ${deletedCount}件`);
      }
    } catch (e) {
      alert(`ゴミ箱移動エラー: ${e}`);
    } finally {
      setIsTrashing(false);
    }
  };

  const updateRow = (path: string, patch: Partial<FileRow>) => {
    setRows((prev) =>
      prev.map((r) =>
        r.originalPath === path ? { ...r, ...patch, status: r.status === "success" ? "success" : "ready" } : r
      )
    );
  };

  return (
    <div className="silk-surface flex h-screen flex-col overflow-hidden bg-[#e9edf3] text-slate-700">
      <header className="glass h-14 shrink-0 border-b px-4 md:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-slate-500 hover:text-slate-700">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-semibold text-slate-800">ファイル整理</h1>
          <Button
            size="icon"
            variant="ghost"
            className="text-slate-600 hover:text-slate-800"
            onClick={handleSelectFiles}
            title="ファイルを選択"
          >
            <UploadCloud className="h-5 w-5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-slate-600 hover:text-slate-800"
            onClick={handleSelectSourceFolder}
            title="入力フォルダを選択"
          >
            <FolderOpen className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <div className="silk-pressed flex h-10 min-w-0 w-full max-w-[560px] items-center rounded-xl px-3">
            <span className="mr-2 shrink-0 text-sm text-slate-500">出力先</span>
            <span
              className={`truncate text-sm ${destinationDirs.length === 0 ? "text-slate-400" : "text-slate-700"}`}
              title={candidatePathDisplay}
            >
              {candidatePathDisplay}
            </span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="text-slate-600 hover:text-slate-800"
            onClick={handleSelectFolders}
            title="候補フォルダを選択"
          >
            <FolderOpen className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-2 p-2 xl:grid-cols-[1.4fr_1fr] overflow-hidden">
        <Card className="silk-raised min-h-0 border-0 bg-[#e9edf3] rounded-3xl flex flex-col">
          <CardHeader className="pb-1">
            <CardTitle className="text-base text-slate-800">整理リスト</CardTitle>
            <CardDescription className="text-xs text-slate-500">
              左側で対象を絞り込み、必要に応じてAI推論と実行を行います。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pt-0 min-h-0 overflow-hidden flex flex-col">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Input
                className="silk-pressed border-0 bg-[#e9edf3] text-slate-700 placeholder:text-slate-400"
                placeholder="キーワード"
                value={filterDraft.keyword}
                onChange={(e) => setFilterDraft((prev) => ({ ...prev, keyword: e.target.value }))}
              />
              <Input
                className="silk-pressed border-0 bg-[#e9edf3] text-slate-700 placeholder:text-slate-400"
                placeholder="拡張子 (pdf)"
                value={filterDraft.extension}
                onChange={(e) => setFilterDraft((prev) => ({ ...prev, extension: e.target.value }))}
              />
              <Input
                className="silk-pressed border-0 bg-[#e9edf3] text-slate-700"
                type="date"
                value={filterDraft.dateAfter}
                onChange={(e) => setFilterDraft((prev) => ({ ...prev, dateAfter: e.target.value }))}
              />
              <Input
                className="silk-pressed border-0 bg-[#e9edf3] text-slate-700"
                type="date"
                value={filterDraft.dateBefore}
                onChange={(e) => setFilterDraft((prev) => ({ ...prev, dateBefore: e.target.value }))}
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                type="button"
                className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]"
                onClick={handleApplyFilter}
              >
                抽出条件を適用
              </Button>
              <Button size="sm" type="button" variant="ghost" className="text-slate-500" onClick={handleClearFilter}>
                条件解除
              </Button>
              <span className="text-xs text-slate-500">対象 {filteredRows.length} / 全体{rows.length}</span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { key: "auto" as const, label: "AIおまかせ" },
                { key: "advanced" as const, label: "ルールベース" },
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMode(m.key)}
                  className={`rounded-xl px-3 py-2 text-sm ${
                    mode === m.key ? "silk-pressed text-slate-800" : "silk-raised text-slate-600"
                  }`}
                >
                  {m.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setIsFolderGroupingPanelOpen((prev) => !prev)}
                className={`rounded-xl px-3 py-2 text-sm ${
                  isFolderGroupingPanelOpen ? "silk-pressed text-slate-800" : "silk-raised text-slate-600"
                }`}
              >
                フォルダ移動
              </button>
            </div>

            {mode === "auto" && (
              <div className="silk-pressed rounded-xl p-2 space-y-2">
                <p className="mb-1 text-xs text-slate-600">AI指示（ファイル名と保存先を同時推論）</p>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto_auto]">
                  <select
                    className="h-8 rounded-lg border border-slate-300/70 bg-[#e9edf3] px-2 text-sm text-slate-700"
                    value={selectedTemplateId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setSelectedTemplateId(id);
                      const selected = savedTemplates.find((t) => t.id === id);
                      if (selected) setPrompt(selected.prompt);
                    }}
                  >
                    {savedTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                    {savedTemplates.length === 0 && (
                      <option value={DEFAULT_FILING_TEMPLATES[0].id}>{DEFAULT_FILING_TEMPLATES[0].name}</option>
                    )}
                  </select>
                  <Button
                    size="sm"
                    className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]"
                    onClick={handleSaveTemplate}
                  >
                    保存
                  </Button>
                  <Button
                    size="sm"
                    className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]"
                    onClick={handleDeleteTemplate}
                  >
                    削除
                  </Button>
                  <Button
                    size="sm"
                    className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]"
                    onClick={handleCreateTemplate}
                  >
                    新規
                  </Button>
                </div>
                <textarea
                  className="w-full min-h-[70px] rounded-lg border-0 bg-transparent text-sm text-slate-700 outline-none"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
            )}

            {mode === "advanced" && (
              <div className="silk-pressed rounded-xl p-2 space-y-2">
                <p className="text-xs text-slate-600">ルールベース設定（主に置換・連番）</p>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    className="border-0 bg-[#e9edf3] text-slate-700"
                    placeholder="置換: 旧文字列"
                    value={advancedOptions.replace_old}
                    onChange={(e) => setAdvancedOptions((p) => ({ ...p, replace_old: e.target.value }))}
                  />
                  <Input
                    className="border-0 bg-[#e9edf3] text-slate-700"
                    placeholder="置換: 新文字列"
                    value={advancedOptions.replace_new}
                    onChange={(e) => setAdvancedOptions((p) => ({ ...p, replace_new: e.target.value }))}
                  />
                  <Input
                    className="border-0 bg-[#e9edf3] text-slate-700"
                    placeholder="接頭語"
                    value={advancedOptions.prefix}
                    onChange={(e) => setAdvancedOptions((p) => ({ ...p, prefix: e.target.value }))}
                  />
                  <Input
                    className="border-0 bg-[#e9edf3] text-slate-700"
                    placeholder="接尾語"
                    value={advancedOptions.suffix}
                    onChange={(e) => setAdvancedOptions((p) => ({ ...p, suffix: e.target.value }))}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={advancedOptions.sequence_enabled}
                    onChange={(e) => setAdvancedOptions((p) => ({ ...p, sequence_enabled: e.target.checked }))}
                  />
                  連番を付与                </label>
                <textarea
                  className="w-full min-h-[56px] rounded-lg border border-slate-300/70 bg-[#e9edf3] px-2 py-1 text-sm text-slate-700 outline-none"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
            )}

            {isFolderGroupingPanelOpen && (
              <div className="silk-pressed rounded-xl p-2 space-y-2">
                <p className="text-xs text-slate-600">出力先フォルダの作り方</p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {[
                    { key: "none" as const, label: "そのまま出力先" },
                    { key: "filename" as const, label: "ファイル名で作成" },
                    { key: "extension" as const, label: "拡張子で作成" },
                    { key: "date" as const, label: "日時で作成" },
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setFolderGroupingMode(item.key)}
                      className={`rounded-xl px-3 py-2 text-xs ${
                        folderGroupingMode === item.key
                          ? "silk-raised text-slate-800"
                          : "border border-slate-300/70 text-slate-600"
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  フォルダ名は自動正規化（禁止文字除去・末尾調整）します。ファイル名ベースは新規40フォルダを超える分を「その他」に集約します。
                </p>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={isMoveMode} onChange={(e) => setIsMoveMode(e.target.checked)} />
                {isMoveMode ? "移動モード（元ファイルを移動）" : "コピーモード（元ファイルを保持）"}
              </label>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600"
                  onClick={handleTrashSelectedRows}
                  disabled={isTrashing || selectedRowPaths.length === 0}
                >
                  {isTrashing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  選択をゴミ箱へ
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-slate-600"
                  onClick={handleDeleteExactDuplicates}
                  disabled={isDeduping || filteredRows.length === 0}
                >
                  {isDeduping ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  完全重複削除
                </Button>
                <Button
                  size="sm"
                  className="silk-raised border-0 bg-[#e9edf3] text-slate-700 hover:bg-[#e9edf3]"
                  onClick={handleAnalyze}
                  disabled={
                    isAnalyzing ||
                    isAnalyzeCooldown ||
                    filteredRows.length === 0 ||
                    (mode === "auto" && destinationDirs.length === 0)
                  }
                >
                  {isAnalyzing ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRightLeft className="mr-1 h-4 w-4" />
                  )}
                  {mode === "advanced" ? "ルール適用" : "AI解析"}                </Button>
                {isAnalyzing && <span className="text-xs text-slate-500">{analyzePhaseText}</span>}
                {!isAnalyzing && isAnalyzeCooldown && (
                  <span className="text-xs text-amber-600">通信待機中... 3秒後に再試行できます</span>
                )}
                <Button
                  size="sm"
                  className="silk-raised border-0 bg-[#dce6ff] text-slate-700 hover:bg-[#dce6ff]"
                  onClick={handleExecute}
                  disabled={isExecuting || filteredRows.length === 0 || destinationDirs.length === 0}
                >
                  {isExecuting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Copy className="mr-1 h-4 w-4" />}
                  一括実行                </Button>
              </div>
            </div>

            <div className="silk-pressed min-h-0 flex-1 overflow-auto rounded-xl p-1">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-slate-300/90">
                    <TableHead className="w-[44px] text-slate-600">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(e) => handleToggleSelectAllVisible(e.target.checked)}
                      />
                    </TableHead>
                    <TableHead className="w-[90px] text-slate-600">状態</TableHead>
                    <TableHead className="text-slate-600">元ファイル</TableHead>
                    <TableHead className="text-slate-600">新しいファイル名</TableHead>
                    <TableHead className="text-slate-600">移動フォルダ（予定）</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((row) => (
                    <TableRow key={row.originalPath} className="cursor-pointer" onClick={() => setSelectedRowPath(row.originalPath)}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedRowPaths.includes(row.originalPath)}
                          onChange={(e) => handleToggleRowSelection(row.originalPath, e.target.checked)}
                        />
                      </TableCell>
                      <TableCell>
                        {row.status === "success" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                        {row.status === "error" && <XCircle className="h-4 w-4 text-red-600" />}
                        {(row.status === "pending" || row.status === "ready") && (
                          <span className="text-xs text-slate-500">{row.status === "ready" ? "解析準備完了" : "未処理"}</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-slate-700">{row.originalName}</TableCell>
                      <TableCell>
                        <Input
                          className="h-8 border-0 bg-[#e9edf3] text-slate-700"
                          value={row.newName}
                          onChange={(e) => updateRow(row.originalPath, { newName: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate text-slate-600" title={plannedTargetDirByPath.get(row.originalPath) ?? "未設定"}>
                        {plannedTargetDirByPath.get(row.originalPath) ?? "未設定"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {selectedRowPath && (
              <p className="truncate text-xs text-slate-500">
                {rows.find((r) => r.originalPath === selectedRowPath)?.reason ||
                  rows.find((r) => r.originalPath === selectedRowPath)?.error ||
                  ""}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="silk-raised min-h-0 border-0 bg-[#e9edf3] rounded-3xl flex flex-col">
          <CardHeader className="pb-1">
            <CardTitle className="text-base text-slate-800">プレビュー</CardTitle>
            <CardDescription className="text-xs text-slate-500">選択ファイルの内容確認</CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 overflow-hidden pt-0 space-y-2">

            <div className="silk-pressed h-full overflow-auto rounded-xl p-3">
              {isPreviewLoading && (
                <div className="flex h-full items-center justify-center text-slate-500">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}

              {!isPreviewLoading && preview?.preview_type === "image" && preview.content && (
                <img src={preview.content} alt="preview" className="mx-auto max-h-full max-w-full object-contain" />
              )}

              {!isPreviewLoading && preview?.preview_type === "text" && preview.content && (
                <pre className="whitespace-pre-wrap text-xs text-slate-700">{preview.content}</pre>
              )}

              {!isPreviewLoading && (!preview || preview.preview_type === "unsupported" || !preview.content) && (
                <div className="text-sm text-slate-500">プレビューを表示できません</div>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

