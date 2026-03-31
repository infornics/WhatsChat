"use client";

import Image from "next/image";
import {
  type CSSProperties,
  type ChangeEvent,
  type ComponentType,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import JSZip from "jszip";
import type { JSZipObject } from "jszip";
import {
  Download,
  FileArchive,
  FileText,
  Image as ImageIcon,
  MessageCircleMore,
  Music4,
  Paperclip,
  Smartphone,
  Video,
} from "lucide-react";

import {
  type ChatAsset,
  type ChatMessage,
  type DateOrder,
  detectAssetKind,
  guessDateOrder,
  inferMimeType,
  parseChatMessages,
} from "@/lib/whatsapp-chat";

type ViewerState = {
  chatName: string;
  messages: ChatMessage[];
  participants: string[];
  selectedSelf: string | null;
  assets: ChatAsset[];
  rawChatText: string;
  dateOrder: DateOrder;
  zip: JSZip | null;
  zipEntries: Record<string, JSZipObject>;
  fileSize: number;
};

type ChatRow =
  | {
      id: string;
      type: "day";
      label: string;
    }
  | {
      id: string;
      type: "system";
      message: ChatMessage;
    }
  | {
      id: string;
      type: "message";
      message: ChatMessage;
      isSelf: boolean;
      joinsPrevious: boolean;
      breaksNext: boolean;
      showSender: boolean;
    };

const emptyState: ViewerState = {
  chatName: "WhatsChat",
  messages: [],
  participants: [],
  selectedSelf: null,
  assets: [],
  rawChatText: "",
  dateOrder: "DMY",
  zip: null,
  zipEntries: {},
  fileSize: 0,
};

const MAX_URL_CACHE = 120;
const VIRTUAL_OVERSCAN_PX = 1200;

function formatTime(date: Date | null) {
  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDay(date: Date | null) {
  if (!date) {
    return "Unknown day";
  }

  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getDayKey(date: Date | null) {
  if (!date) {
    return "unknown";
  }

  return date.toISOString().slice(0, 10);
}

function deriveChatName(fileName: string, txtName: string | null) {
  const source = txtName ?? fileName.replace(/\.zip$/i, "");
  return source
    .replace(/^whatsapp chat with\s+/i, "")
    .replace(/^_chat$/i, "Imported chat")
    .replace(/\.txt$/i, "")
    .trim();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function binarySearchOffset(offsets: number[], value: number) {
  let low = 0;
  let high = offsets.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    if (offsets[mid] <= value) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer;
}

function cleanupObjectUrls(urlMap: Map<string, string>) {
  for (const url of urlMap.values()) {
    URL.revokeObjectURL(url);
  }

  urlMap.clear();
}

function estimateTextLines(text: string, charsPerLine: number) {
  if (!text) {
    return 0;
  }

  return text.split("\n").reduce((lineCount, line) => {
    const estimated = Math.max(1, Math.ceil(line.length / charsPerLine));
    return lineCount + estimated;
  }, 0);
}

function estimateRowHeight(row: ChatRow) {
  if (row.type === "day") {
    return 52;
  }

  if (row.type === "system") {
    return 28 + estimateTextLines(row.message.text, 36) * 18 + 18;
  }

  const attachmentHeight =
    row.message.attachment?.kind === "image" || row.message.attachment?.kind === "sticker"
      ? 260
      : row.message.attachment?.kind === "video"
        ? 260
        : row.message.attachment?.kind === "audio" || row.message.attachment
          ? 90
          : 0;

  const senderHeight = row.showSender ? 18 : 0;
  const bubblePadding = 38;
  const textHeight = Math.max(1, estimateTextLines(row.message.text, 30)) * 22;

  return bubblePadding + senderHeight + attachmentHeight + textHeight;
}

function buildChatRows(messages: ChatMessage[], selectedSelf: string | null) {
  const rows: ChatRow[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const previousMessage = messages[index - 1];
    const nextMessage = messages[index + 1];
    const currentDay = getDayKey(message.timestamp);
    const previousDay = previousMessage ? getDayKey(previousMessage.timestamp) : null;

    if (currentDay !== previousDay) {
      rows.push({
        id: `day-${currentDay}-${index}`,
        type: "day",
        label: formatDay(message.timestamp),
      });
    }

    if (message.isSystem) {
      rows.push({
        id: `system-${message.id}`,
        type: "system",
        message,
      });
      continue;
    }

    const isSelf = Boolean(selectedSelf) && message.sender === selectedSelf;
    const joinsPrevious =
      Boolean(previousMessage) &&
      previousMessage?.sender === message.sender &&
      getDayKey(previousMessage?.timestamp ?? null) === currentDay &&
      !message.isSystem;
    const breaksNext =
      !nextMessage ||
      nextMessage.sender !== message.sender ||
      getDayKey(nextMessage.timestamp) !== currentDay ||
      nextMessage.isSystem;

    rows.push({
      id: `message-${message.id}`,
      type: "message",
      message,
      isSelf,
      joinsPrevious,
      breaksNext,
      showSender: !isSelf && !joinsPrevious && Boolean(message.sender),
    });
  }

  return rows;
}

export function WhatsAppChatViewer() {
  const [viewer, setViewer] = useState<ViewerState>(emptyState);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const urlCacheRef = useRef(new Map<string, string>());
  const urlUseOrderRef = useRef<string[]>([]);

  useEffect(() => {
    const urlCache = urlCacheRef.current;

    return () => {
      cleanupObjectUrls(urlCache);
    };
  }, []);

  useEffect(() => {
    function syncDefaultSidebarWidth() {
      const layout = layoutRef.current;

      if (!layout) {
        return;
      }

      const bounds = layout.getBoundingClientRect();
      const minWidth = 320;
      const maxWidth = Math.max(minWidth, bounds.width - 360);
      const nextWidth = Math.min(Math.max(bounds.width * 0.4, minWidth), maxWidth);

      setSidebarWidth(nextWidth);
    }

    syncDefaultSidebarWidth();
    window.addEventListener("resize", syncDefaultSidebarWidth);

    return () => {
      window.removeEventListener("resize", syncDefaultSidebarWidth);
    };
  }, []);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const layout = layoutRef.current;

      if (!layout) {
        return;
      }

      const bounds = layout.getBoundingClientRect();
      const nextWidth = event.clientX - bounds.left;
      const minWidth = 320;
      const maxWidth = Math.max(minWidth, bounds.width - 360);

      setSidebarWidth(Math.min(Math.max(nextWidth, minWidth), maxWidth));
    }

    function handlePointerUp() {
      setIsResizing(false);
    }

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizing]);

  useEffect(() => {
    function syncViewportHeight() {
      const container = chatScrollRef.current;

      if (!container) {
        return;
      }

      setViewportHeight(container.clientHeight);
    }

    syncViewportHeight();

    const container = chatScrollRef.current;

    if (!container) {
      return;
    }

    const observer = new ResizeObserver(syncViewportHeight);
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [viewer.messages.length]);

  const rows = useMemo(() => buildChatRows(viewer.messages, viewer.selectedSelf), [
    viewer.messages,
    viewer.selectedSelf,
  ]);

  const virtualization = useMemo(() => {
    const heights: number[] = [];
    const offsets: number[] = [];
    let runningOffset = 0;

    for (const row of rows) {
      offsets.push(runningOffset);
      const height = estimateRowHeight(row);
      heights.push(height);
      runningOffset += height;
    }

    const totalHeight = runningOffset;
    const startOffset = Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX);
    const endOffset = scrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX;
    const startIndex = rows.length === 0 ? 0 : binarySearchOffset(offsets, startOffset);
    let endIndex = rows.length;

    for (let index = startIndex; index < rows.length; index += 1) {
      if (offsets[index] > endOffset) {
        endIndex = index;
        break;
      }
    }

    return {
      offsets,
      heights,
      totalHeight,
      startIndex,
      endIndex,
    };
  }, [rows, scrollTop, viewportHeight]);

  const mediaCount = viewer.assets.filter(
    (asset) => asset.kind === "image" || asset.kind === "video" || asset.kind === "sticker",
  ).length;
  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;

  async function resolveAssetUrl(asset: ChatAsset) {
    const cached = urlCacheRef.current.get(asset.fullName);

    if (cached) {
      const nextOrder = urlUseOrderRef.current.filter((key) => key !== asset.fullName);
      nextOrder.push(asset.fullName);
      urlUseOrderRef.current = nextOrder;
      return cached;
    }

    const entry = viewer.zipEntries[asset.fullName];

    if (!entry) {
      throw new Error(`Missing file for ${asset.fileName}`);
    }

    const blob = await entry.async("blob");
    const url = URL.createObjectURL(
      new Blob([blob], {
        type: asset.mimeType,
      }),
    );

    urlCacheRef.current.set(asset.fullName, url);
    urlUseOrderRef.current.push(asset.fullName);

    while (urlUseOrderRef.current.length > MAX_URL_CACHE) {
      const expiredKey = urlUseOrderRef.current.shift();

      if (!expiredKey) {
        break;
      }

      const expiredUrl = urlCacheRef.current.get(expiredKey);

      if (expiredUrl) {
        URL.revokeObjectURL(expiredUrl);
        urlCacheRef.current.delete(expiredKey);
      }
    }

    return url;
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    cleanupObjectUrls(urlCacheRef.current);
    urlUseOrderRef.current = [];
    setStatus("loading");
    setErrorMessage("");
    setScrollTop(0);

    try {
      const imported = await parseExport(file);

      startTransition(() => {
        setViewer(imported);
        setStatus("ready");
      });
    } catch (error) {
      cleanupObjectUrls(urlCacheRef.current);
      urlUseOrderRef.current = [];
      setStatus("error");
      setViewer(emptyState);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The export could not be parsed. Please try another WhatsApp zip.",
      );
    } finally {
      event.target.value = "";
    }
  }

  function handleDateOrderChange(nextDateOrder: DateOrder) {
    if (!viewer.rawChatText) {
      return;
    }

    const parsed = parseChatMessages(viewer.rawChatText, viewer.assets, nextDateOrder);

    setViewer((current) => ({
      ...current,
      dateOrder: nextDateOrder,
      messages: parsed.messages,
      participants: parsed.participants,
      selectedSelf:
        current.selectedSelf && parsed.participants.includes(current.selectedSelf)
          ? current.selectedSelf
          : parsed.participants[0] ?? null,
    }));
  }

  return (
    <div className="h-dvh overflow-hidden bg-[linear-gradient(180deg,#e7f5ef_0%,#f6efe7_45%,#f8faf9_100%)]">
      <div
        ref={layoutRef}
        style={layoutStyle}
        className="grid h-full w-full grid-cols-1 gap-4 overflow-hidden px-4 py-4 sm:px-6 lg:[grid-template-columns:var(--sidebar-width)_14px_minmax(0,1fr)] lg:px-8 lg:py-6"
      >
        <section className="flex h-full min-h-0 flex-col overflow-y-auto rounded-[2rem] border border-white/70 bg-white/85 p-6 shadow-[0_24px_80px_rgba(28,56,44,0.14)] backdrop-blur">
          <div className="space-y-6">
            <div className="inline-flex w-fit items-center gap-2 rounded-full bg-[#e6fff3] px-4 py-2 text-sm font-semibold text-[#0f5c3f]">
              <MessageCircleMore className="size-4" />
              WhatsApp Export Reader
            </div>

            <div className="space-y-4">
              <h1 className="max-w-md text-4xl font-semibold tracking-tight text-[#163528] sm:text-5xl">
                Upload a WhatsApp export and read it like a real conversation.
              </h1>
              <p className="max-w-lg text-base leading-7 text-[#4d655a]">
                Drop in the `.zip` from WhatsApp. The app parses `_chat.txt`, matches images,
                videos, audio, and documents, then rebuilds the conversation in a familiar
                messaging layout directly in your browser.
              </p>
            </div>

            <label className="block cursor-pointer rounded-[1.75rem] border border-dashed border-[#8ec9ac] bg-[#f6fff9] p-6 transition hover:border-[#49a373] hover:bg-[#f1fff6]">
              <input
                type="file"
                accept=".zip,application/zip"
                className="sr-only"
                onChange={handleFileChange}
              />
              <div className="flex items-start gap-4">
                <div className="rounded-2xl bg-[#dff8ea] p-3 text-[#0f5c3f]">
                  <FileArchive className="size-6" />
                </div>
                <div className="space-y-2">
                  <div className="text-lg font-semibold text-[#143427]">
                    {status === "loading" ? "Parsing your export..." : "Choose export zip"}
                  </div>
                  <p className="text-sm leading-6 text-[#5d7468]">
                    Large exports are now virtualized and media loads on demand, so the reader
                    stays responsive with much bigger chats.
                  </p>
                </div>
              </div>
            </label>

            {errorMessage ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errorMessage}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard
                label="Messages"
                value={viewer.messages.length.toLocaleString()}
                icon={MessageCircleMore}
              />
              <StatCard
                label="Participants"
                value={viewer.participants.length.toLocaleString()}
                icon={Smartphone}
              />
              <StatCard label="Media" value={mediaCount.toLocaleString()} icon={Download} />
              <StatCard
                label="Zip Size"
                value={viewer.fileSize ? formatBytes(viewer.fileSize) : "0 B"}
                icon={FileArchive}
              />
            </div>

            {viewer.messages.length > 0 ? (
              <div className="space-y-4 rounded-[1.75rem] border border-[#e3efe8] bg-[#fbfdfc] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium uppercase tracking-[0.18em] text-[#6e8478]">
                      Conversation Setup
                    </div>
                    <div className="text-xl font-semibold text-[#173528]">{viewer.chatName}</div>
                  </div>
                  <div className="rounded-full bg-[#eaf8ef] px-3 py-1 text-xs font-medium text-[#21704c]">
                    Virtualized preview active
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-[#355244]">
                      Show these messages on the right
                    </span>
                    <select
                      value={viewer.selectedSelf ?? ""}
                      onChange={(event) =>
                        setViewer((current) => ({
                          ...current,
                          selectedSelf: event.target.value || null,
                        }))
                      }
                      className="h-11 w-full rounded-xl border border-[#d6e6dd] bg-white px-3 text-sm text-[#183529] outline-none transition focus:border-[#4a9d74]"
                    >
                      {viewer.participants.map((participant) => (
                        <option key={participant} value={participant}>
                          {participant}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-2">
                    <span className="text-sm font-medium text-[#355244]">Date format</span>
                    <select
                      value={viewer.dateOrder}
                      onChange={(event) =>
                        handleDateOrderChange(event.target.value as DateOrder)
                      }
                      className="h-11 w-full rounded-xl border border-[#d6e6dd] bg-white px-3 text-sm text-[#183529] outline-none transition focus:border-[#4a9d74]"
                    >
                      <option value="DMY">Day / Month / Year</option>
                      <option value="MDY">Month / Day / Year</option>
                    </select>
                  </label>
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-6 shrink-0 rounded-[1.75rem] bg-[#173528] p-5 text-[#d6efe3]">
            <div className="text-sm uppercase tracking-[0.18em] text-[#8fbea9]">How it works</div>
            <div className="mt-3 space-y-2 text-sm leading-6">
              <p>1. Upload the exported WhatsApp zip.</p>
              <p>2. The app parses the transcript without scanning every attachment against every message.</p>
              <p>3. Only the visible part of the chat is rendered, and media blobs load only when needed.</p>
            </div>
          </div>
        </section>

        <div className="relative hidden h-full lg:flex lg:items-center lg:justify-center">
          <button
            type="button"
            aria-label="Resize panels"
            onPointerDown={() => setIsResizing(true)}
            className="group flex h-full w-full touch-none cursor-col-resize select-none items-center justify-center"
          >
            <div
              className={[
                "h-full w-[2px] rounded-full bg-[#bfd4c8] transition",
                "group-hover:bg-[#4a9d74]",
                isResizing ? "bg-[#2f7d58]" : "",
              ].join(" ")}
            />
            <div
              className={[
                "absolute flex h-12 w-4 items-center justify-center rounded-full border border-[#d4e4db] bg-white/90 shadow-sm transition",
                "group-hover:border-[#84bc9d] group-hover:bg-[#f3fbf6]",
                isResizing ? "border-[#4a9d74] bg-[#f3fbf6]" : "",
              ].join(" ")}
            >
              <div className="flex gap-1">
                <span className="h-4 w-[2px] rounded-full bg-[#7f978a]" />
                <span className="h-4 w-[2px] rounded-full bg-[#7f978a]" />
              </div>
            </div>
          </button>
        </div>

        <section className="flex h-full min-h-0 items-stretch justify-center overflow-hidden">
          <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[2.5rem] border border-[#cfded6] bg-[#dde5dd] shadow-[0_30px_80px_rgba(23,53,40,0.18)]">
            <div className="shrink-0 flex items-center justify-between border-b border-[#d4dfd8] bg-[#f7faf8] px-6 py-4">
              <div>
                <div className="text-xs uppercase tracking-[0.24em] text-[#799181]">Preview</div>
                <div className="text-xl font-semibold text-[#173528]">{viewer.chatName}</div>
              </div>
              <div className="rounded-full bg-[#e9f8ef] px-3 py-1 text-sm font-medium text-[#136543]">
                {viewer.messages.length > 0 ? `${viewer.messages.length} messages` : "Waiting for zip"}
              </div>
            </div>

            <div
              ref={chatScrollRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              className="whatschat-wallpaper relative min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5"
            >
              {viewer.messages.length === 0 ? <EmptyPreview status={status} /> : null}

              {viewer.messages.length > 0 ? (
                <div style={{ height: virtualization.totalHeight }} className="relative">
                  {rows
                    .slice(virtualization.startIndex, virtualization.endIndex)
                    .map((row, visibleIndex) => {
                      const index = virtualization.startIndex + visibleIndex;
                      const top = virtualization.offsets[index];

                      return (
                        <div
                          key={row.id}
                          style={{ transform: `translateY(${top}px)` }}
                          className="absolute left-0 right-0"
                        >
                          <ChatRowRenderer row={row} resolveAssetUrl={resolveAssetUrl} />
                        </div>
                      );
                    })}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ChatRowRenderer({
  row,
  resolveAssetUrl,
}: {
  row: ChatRow;
  resolveAssetUrl: (asset: ChatAsset) => Promise<string>;
}) {
  if (row.type === "day") {
    return (
      <div className="my-4 flex justify-center">
        <div className="rounded-full bg-[#d9e5f8] px-4 py-1 text-xs font-medium text-[#36537b] shadow-sm">
          {row.label}
        </div>
      </div>
    );
  }

  if (row.type === "system") {
    return <SystemMessage message={row.message} />;
  }

  return (
    <div className={`space-y-2 ${row.isSelf ? "flex justify-end" : "flex justify-start"}`}>
      <article
        className={[
          "max-w-[85%] rounded-[1.4rem] px-3 py-2 shadow-[0_10px_24px_rgba(22,37,29,0.08)] sm:max-w-[75%]",
          row.isSelf ? "bg-[#dcf8c6] text-[#173528]" : "bg-white text-[#1d2d25]",
          row.joinsPrevious ? (row.isSelf ? "rounded-tr-md" : "rounded-tl-md") : "",
          row.breaksNext ? (row.isSelf ? "rounded-br-sm" : "rounded-bl-sm") : "",
        ].join(" ")}
      >
        {row.showSender && row.message.sender ? (
          <div className="mb-1 text-xs font-semibold text-[#0f7a52]">{row.message.sender}</div>
        ) : null}

        {row.message.attachment ? (
          <AttachmentPreview asset={row.message.attachment} resolveAssetUrl={resolveAssetUrl} />
        ) : null}

        {row.message.text ? (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-6">{row.message.text}</p>
        ) : null}

        <div className="mt-1 flex justify-end text-[11px] text-[#6f7f76]">
          {formatTime(row.message.timestamp)}
        </div>
      </article>
    </div>
  );
}

function EmptyPreview({ status }: { status: "idle" | "loading" | "ready" | "error" }) {
  return (
    <div className="flex h-full min-h-[580px] flex-col items-center justify-center px-6 text-center">
      <div className="rounded-[2rem] border border-white/70 bg-white/80 p-8 shadow-[0_20px_40px_rgba(39,68,56,0.12)] backdrop-blur">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-[#def5e7] text-[#0f6a45]">
          <FileArchive className="size-8" />
        </div>
        <h2 className="mt-5 text-2xl font-semibold text-[#183528]">
          {status === "loading" ? "Building your chat preview..." : "Your chat will appear here"}
        </h2>
        <p className="mt-3 max-w-md text-sm leading-6 text-[#5a7065]">
          Upload the exported zip from WhatsApp and the reader will reconstruct the conversation
          with media, timestamps, and day separators.
        </p>
      </div>
    </div>
  );
}

function SystemMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="my-2 flex justify-center">
      <div className="max-w-xl rounded-2xl bg-[#fff7cf] px-4 py-2 text-center text-xs leading-5 text-[#6d6232] shadow-sm">
        {message.text}
      </div>
    </div>
  );
}

function AttachmentPreview({
  asset,
  resolveAssetUrl,
}: {
  asset: ChatAsset;
  resolveAssetUrl: (asset: ChatAsset) => Promise<string>;
}) {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    void resolveAssetUrl(asset).then((url) => {
      if (isMounted) {
        setAssetUrl(url);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [asset, resolveAssetUrl]);

  if (!assetUrl) {
    return (
      <div className="mb-2 rounded-2xl bg-[#eff6f1] p-3 text-sm text-[#5e7467]">
        Loading {asset.kind}...
      </div>
    );
  }

  if (asset.kind === "image" || asset.kind === "sticker") {
    return (
      <div className="mb-2 overflow-hidden rounded-2xl bg-[#edf4ef]">
        <Image
          src={assetUrl}
          alt={asset.fileName}
          width={1200}
          height={900}
          unoptimized
          className="max-h-80 w-full object-cover"
        />
      </div>
    );
  }

  if (asset.kind === "video") {
    return (
      <div className="mb-2 overflow-hidden rounded-2xl bg-black">
        <video controls className="max-h-80 w-full" preload="metadata">
          <source src={assetUrl} type={asset.mimeType} />
        </video>
      </div>
    );
  }

  if (asset.kind === "audio") {
    return (
      <div className="mb-2 rounded-2xl bg-[#eff6f1] p-3">
        <audio controls className="w-full">
          <source src={assetUrl} type={asset.mimeType} />
        </audio>
      </div>
    );
  }

  return (
    <a
      href={assetUrl}
      download={asset.fileName}
      className="mb-2 flex items-center gap-3 rounded-2xl bg-[#eff6f1] p-3 transition hover:bg-[#e6f1ea]"
    >
      <div className="rounded-xl bg-white p-2 text-[#246746] shadow-sm">
        <AssetIcon kind={asset.kind} className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{asset.fileName}</div>
        <div className="text-xs text-[#6a7a72]">{formatBytes(asset.size)}</div>
      </div>
      <Paperclip className="size-4 text-[#567367]" />
    </a>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-[1.35rem] border border-[#deebe4] bg-[#fbfdfc] p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[#60766a]">{label}</span>
        <Icon className="size-4 text-[#16714c]" />
      </div>
      <div className="mt-3 text-2xl font-semibold text-[#163528]">{value}</div>
    </div>
  );
}

function AssetIcon({
  kind,
  className,
}: {
  kind: ChatAsset["kind"];
  className?: string;
}) {
  if (kind === "image" || kind === "sticker") {
    return <ImageIcon className={className} />;
  }

  if (kind === "video") {
    return <Video className={className} />;
  }

  if (kind === "audio") {
    return <Music4 className={className} />;
  }

  return <FileText className={className} />;
}

async function parseExport(file: File): Promise<ViewerState> {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const zipEntries = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  const textEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".txt"));
  const chatEntry =
    textEntries.find((entry) => entry.name.toLowerCase().includes("chat")) ?? textEntries[0];

  if (!chatEntry) {
    throw new Error("No chat transcript was found inside the zip file.");
  }

  const rawChatText = await chatEntry.async("string");

  if (!rawChatText.trim()) {
    throw new Error("The chat transcript is empty.");
  }

  const assetEntries = entries.filter((entry) => entry.name !== chatEntry.name);
  const assets = assetEntries.map((entry) => {
    const fileName = entry.name.split("/").pop() ?? entry.name;
    const entryData = (entry as JSZipObject & { _data?: { uncompressedSize?: number } })._data;

    return {
      fullName: entry.name,
      fileName,
      normalizedFileName: fileName.trim().toLowerCase(),
      mimeType: inferMimeType(fileName),
      kind: detectAssetKind(fileName),
      size: entryData?.uncompressedSize ?? 0,
    } satisfies ChatAsset;
  });

  const dateOrder = guessDateOrder(rawChatText);
  const parsed = parseChatMessages(rawChatText, assets, dateOrder);

  return {
    chatName: deriveChatName(file.name, chatEntry.name.split("/").pop() ?? null),
    messages: parsed.messages,
    participants: parsed.participants,
    selectedSelf: parsed.participants[0] ?? null,
    assets,
    rawChatText,
    dateOrder,
    zip,
    zipEntries,
    fileSize: file.size,
  };
}
