export type DateOrder = "DMY" | "MDY";

export type AssetKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "unknown";

export type ChatAsset = {
  fullName: string;
  fileName: string;
  normalizedFileName: string;
  mimeType: string;
  kind: AssetKind;
  size: number;
};

export type ChatMessage = {
  id: string;
  sender: string | null;
  text: string;
  timestamp: Date | null;
  attachment: ChatAsset | null;
  isSystem: boolean;
};

type ParsedHeader = {
  datePart: string;
  timePart: string;
  content: string;
};

type RawMessage = ParsedHeader & {
  id: string;
};

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "3gp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "ogg", "wav", "m4a", "aac", "opus"]);
const STICKER_EXTENSIONS = new Set(["webp"]);

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
};

function normalizeFileName(value: string) {
  return value.replace(/^.*[\\/]/, "").trim().toLowerCase();
}

function getExtension(fileName: string) {
  const lastPart = fileName.split(".").pop();
  return lastPart ? lastPart.toLowerCase() : "";
}

export function detectAssetKind(fileName: string): AssetKind {
  const extension = getExtension(fileName);

  if (STICKER_EXTENSIONS.has(extension) && fileName.toLowerCase().includes("sticker")) {
    return "sticker";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }

  if (extension) {
    return "document";
  }

  return "unknown";
}

export function inferMimeType(fileName: string) {
  const extension = getExtension(fileName);
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

export function guessDateOrder(chatText: string): DateOrder {
  let checkedLines = 0;

  for (const line of iterateLines(chatText.replace(/\u200e/g, ""))) {
    const header = parseMessageHeader(line);

    if (!header) {
      continue;
    }

    const [first, second] = header.datePart.split("/").map((part) => Number(part));

    if (Number.isNaN(first) || Number.isNaN(second)) {
      continue;
    }

    if (first > 12) {
      return "DMY";
    }

    if (second > 12) {
      return "MDY";
    }

    checkedLines += 1;

    if (checkedLines >= 200) {
      break;
    }
  }

  return "DMY";
}

export function parseChatMessages(
  chatText: string,
  assets: ChatAsset[],
  dateOrder: DateOrder,
) {
  const assetMap = new Map(assets.map((asset) => [asset.normalizedFileName, asset]));
  const rawMessages = extractRawMessages(chatText);
  const messages = rawMessages.map((rawMessage) =>
    normalizeRawMessage(rawMessage, assetMap, dateOrder),
  );
  const participants = Array.from(
    new Set(messages.map((message) => message.sender).filter(Boolean)),
  ) as string[];

  return { messages, participants };
}

function extractRawMessages(chatText: string) {
  const messages: RawMessage[] = [];
  let currentMessage: RawMessage | null = null;

  for (const line of iterateLines(chatText.replace(/\u200e/g, ""))) {
    const header = parseMessageHeader(line);

    if (header) {
      if (currentMessage) {
        messages.push(currentMessage);
      }

      currentMessage = {
        id: `raw-${messages.length + 1}`,
        ...header,
      };
      continue;
    }

    if (!currentMessage) {
      continue;
    }

    currentMessage.content = `${currentMessage.content}\n${line}`;
  }

  if (currentMessage) {
    messages.push(currentMessage);
  }

  return messages;
}

function parseMessageHeader(line: string): ParsedHeader | null {
  const dashPattern =
    /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|AM|PM)?)\s-\s([\s\S]+)$/;
  const bracketPattern =
    /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|AM|PM)?)\]\s([\s\S]+)$/;

  const dashMatch = line.match(dashPattern);

  if (dashMatch) {
    return {
      datePart: dashMatch[1],
      timePart: dashMatch[2],
      content: dashMatch[3],
    };
  }

  const bracketMatch = line.match(bracketPattern);

  if (bracketMatch) {
    return {
      datePart: bracketMatch[1],
      timePart: bracketMatch[2],
      content: bracketMatch[3],
    };
  }

  return null;
}

function normalizeRawMessage(
  rawMessage: RawMessage,
  assetMap: Map<string, ChatAsset>,
  dateOrder: DateOrder,
): ChatMessage {
  const senderSeparator = rawMessage.content.indexOf(": ");
  const hasSender = senderSeparator > 0;
  const sender = hasSender ? rawMessage.content.slice(0, senderSeparator).trim() : null;
  const fullText = hasSender
    ? rawMessage.content.slice(senderSeparator + 2).trim()
    : rawMessage.content.trim();
  const attachmentName = extractAttachmentName(fullText, assetMap);
  const attachment = attachmentName ? assetMap.get(normalizeFileName(attachmentName)) ?? null : null;
  const cleanedText = cleanMessageText(fullText, attachmentName);

  return {
    id: rawMessage.id,
    sender,
    text: cleanedText,
    timestamp: parseWhatsAppDate(rawMessage.datePart, rawMessage.timePart, dateOrder),
    attachment,
    isSystem: !hasSender,
  };
}

function extractAttachmentName(
  text: string,
  assetMap: Map<string, ChatAsset>,
) {
  const attachedMatch = text.match(/<attached:\s(.+?)>/i);

  if (attachedMatch) {
    return attachedMatch[1];
  }

  const fileAttachedMatch = text.match(/^(.+?)\s\((?:file|image|video|audio|document) attached\)$/i);

  if (fileAttachedMatch) {
    return fileAttachedMatch[1];
  }

  const candidateMatch = text.match(/([\w\-(). ]+\.[A-Za-z0-9]{2,5})/);

  if (candidateMatch) {
    const candidate = normalizeFileName(candidateMatch[1]);
    return assetMap.get(candidate)?.fileName ?? null;
  }

  return null;
}

function cleanMessageText(text: string, attachmentName: string | null) {
  const normalized = text
    .replace(/<attached:\s.+?>/gi, "")
    .replace(/^(.+?)\s\((?:file|image|video|audio|document) attached\)$/gi, "")
    .trim();

  if (normalized.length > 0) {
    return normalized;
  }

  if (attachmentName) {
    return "";
  }

  return text.trim();
}

function parseWhatsAppDate(
  datePart: string,
  timePart: string,
  dateOrder: DateOrder,
) {
  const [first, second, third] = datePart.split("/").map((value) => Number(value));

  if ([first, second, third].some((value) => Number.isNaN(value))) {
    return null;
  }

  const year = third < 100 ? 2000 + third : third;
  const day = dateOrder === "DMY" ? first : second;
  const month = dateOrder === "DMY" ? second : first;
  const timeMatch = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm|AM|PM)?$/);

  if (!timeMatch) {
    return null;
  }

  let hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] ?? "0");
  const meridiem = timeMatch[4]?.toLowerCase();

  if (meridiem === "pm" && hours < 12) {
    hours += 12;
  }

  if (meridiem === "am" && hours === 12) {
    hours = 0;
  }

  const value = new Date(year, month - 1, day, hours, minutes, seconds);
  return Number.isNaN(value.getTime()) ? null : value;
}

function* iterateLines(value: string) {
  let startIndex = 0;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];

    if (current !== "\n" && current !== "\r") {
      continue;
    }

    yield value.slice(startIndex, index);

    if (current === "\r" && value[index + 1] === "\n") {
      index += 1;
    }

    startIndex = index + 1;
  }

  if (startIndex <= value.length) {
    yield value.slice(startIndex);
  }
}
