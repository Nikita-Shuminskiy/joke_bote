import dotenv from "dotenv";
import { Telegraf } from "telegraf";

dotenv.config();

const token = process.env.BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

if (!token) {
  throw new Error("BOT_TOKEN is required");
}

const targetUserIds = new Set(
  (process.env.TARGET_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0),
);

const roastCooldownMs = parsePositiveInt(process.env.ROAST_COOLDOWN_MS, 20 * 60 * 1000);
const replyChancePercent = clamp(parsePositiveInt(process.env.REPLY_CHANCE_PERCENT, 12), 1, 100);
const maxContextMessages = 12;

const aiFallbackLine = "Сегодня даже нейросеть взяла паузу. Считай, это редкий комплимент.";

const helpText = [
  "/start - краткая справка",
  "/help - список команд",
  "/id - показать user_id и chat_id",
  "/roastme - получить шутку про себя",
  "/joke - получить случайную шутку",
  "",
  "Для реакций в группе:",
  "1. Добавь бота в группу",
  "2. Выключи Privacy Mode через BotFather",
  "3. При желании задай TARGET_USER_IDS через .env",
].join("\n");

const bot = new Telegraf(token);
const lastReplyAtByChat = new Map<number, number>();
const recentMessagesByChat = new Map<number, Array<{ username: string; text: string }>>();
const geminiSystemPrompt = [
  "Ты пишешь на русском.",
  "Сгенерируй одну короткую, смешную и добродушную шутку в сухом пафосном стиле.",
  "Стиль: сдержанный, ироничный, псевдо-мудрый вайб боевиков без прямого копирования чьих-либо цитат.",
  "У тебя есть контекст последних сообщений чата, используй его как фон разговора.",
  "Шути только по теме диалога, без выбора конкретной жертвы.",
  "Не используй оскорбления, угрозы, хейт, мат, сексуальный контент, темы внешности, здоровья, расы, религии или унижения.",
  "Отвечай одной фразой длиной до 25 слов.",
].join(" ");

console.log("Bot config loaded", {
  botUsername: process.env.BOT_USERNAME || null,
  hasBotToken: Boolean(token),
  hasGeminiApiKey: Boolean(geminiApiKey),
  geminiModel,
  targetUserIdsCount: targetUserIds.size,
  roastCooldownMs,
  replyChancePercent,
  maxContextMessages,
});

bot.start((ctx) => ctx.reply(helpText));
bot.help((ctx) => ctx.reply(helpText));

bot.command("id", async (ctx) => {
  console.log("ID command requested", {
    chat: getChatLogInfo(ctx.chat),
    from: getUserLogInfo(ctx.from),
    messageId: ctx.message.message_id,
  });

  await ctx.reply(
    [
      `user_id: ${ctx.from.id}`,
      `username: ${ctx.from.username ? `@${ctx.from.username}` : "none"}`,
      `chat_id: ${ctx.chat.id}`,
      `chat_type: ${ctx.chat.type}`,
    ].join("\n"),
  );
});

bot.command("joke", async (ctx) => {
  await ctx.reply(
    await generateAiJoke({
      mode: "general",
    }),
  );
});

bot.command("roastme", async (ctx) => {
  await ctx.reply(
    await generateAiJoke({
      mode: "self",
      username: ctx.from.username,
    }),
  );
});

bot.on("text", async (ctx) => {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    return;
  }

  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) {
    return;
  }

  const chatId = ctx.chat.id;
  console.log("Incoming group message", {
    chat: getChatLogInfo(ctx.chat),
    from: getUserLogInfo(ctx.from),
    messageId: ctx.message.message_id,
    textPreview: text.slice(0, 120),
  });

  rememberMessage(chatId, {
    username: ctx.from.username ?? ctx.from.first_name ?? "unknown",
    text,
  });

  const now = Date.now();
  const lastReplyAt = lastReplyAtByChat.get(chatId) ?? 0;

  if (now - lastReplyAt < roastCooldownMs) {
    return;
  }

  const shouldReply = roll(replyChancePercent);

  if (!shouldReply) {
    return;
  }

  console.log("Context-aware group joke triggered", {
    chatId,
    fromId: ctx.from.id,
    username: ctx.from.username ?? null,
    messageId: ctx.message.message_id,
    textPreview: text.slice(0, 120),
  });

  const line = await generateAiJoke({
    mode: "group",
    messageText: text,
    username: ctx.from.username,
    chatContext: recentMessagesByChat.get(chatId) ?? [],
  });
  lastReplyAtByChat.set(chatId, now);

  await ctx.reply(line, {
    reply_parameters: {
      message_id: ctx.message.message_id,
    },
  });
});

bot.on("new_chat_members", (ctx) => {
  console.log("New chat members", {
    chat: getChatLogInfo(ctx.chat),
    addedBy: getUserLogInfo(ctx.from),
    members: ctx.message.new_chat_members.map(getUserLogInfo),
  });
});

bot.catch((error) => {
  console.error("Bot error", error);
});

bot.launch().then(() => {
  console.log("Telegram bot is running", {
    botUsername: process.env.BOT_USERNAME || null,
  });
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const value = Number(input);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roll(chancePercent: number): boolean {
  return Math.random() * 100 < chancePercent;
}

async function generateAiJoke(input: {
  mode: "general" | "self" | "group";
  messageText?: string;
  username?: string;
  chatContext?: Array<{ username: string; text: string }>;
}): Promise<string> {
  if (!geminiApiKey) {
    console.error("Gemini API key is missing");
    return aiFallbackLine;
  }

  const prompt = buildPrompt(input);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: geminiSystemPrompt }],
        },
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 1,
          maxOutputTokens: 80,
        },
      }),
    },
  );

  if (!response.ok) {
    console.error("Gemini API error", response.status, await response.text());
    return aiFallbackLine;
  }

  const payload = (await response.json()) as GeminiGenerateContentResponse;
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join(" ")
    .trim();

  return text || aiFallbackLine;
}

function buildPrompt(input: {
  mode: "general" | "self" | "group";
  messageText?: string;
  username?: string;
  chatContext?: Array<{ username: string; text: string }>;
}): string {
  if (input.mode === "general") {
    return [
      "Сделай одну короткую случайную шутку для общего чата.",
      "Шутка должна быть универсальной, без привязки к конкретному человеку.",
    ].join("\n");
  }

  if (input.mode === "self") {
    return [
      `Пользователь: @${input.username ?? "unknown"}.`,
      "Пользователь сам попросил подколку командой roastme.",
      "Сделай короткую добродушную самоироничную шутку про автора.",
    ].join("\n");
  }

  return [
    "Последние сообщения чата:",
    renderChatContext(input.chatContext ?? []),
    `Автор сообщения: @${input.username ?? "unknown"}.`,
    `Текст сообщения: "${input.messageText ?? ""}".`,
    "Сделай короткую смешную реакцию на текущий разговор для общего чата.",
    "Можно опираться на контекст последних сообщений, но не выбирай конкретного человека как цель шутки.",
    "Реагируй на формулировку, тему или общий вайб диалога, без унижения автора.",
  ].join("\n");
}

function rememberMessage(chatId: number, message: { username: string; text: string }): void {
  const messages = recentMessagesByChat.get(chatId) ?? [];
  messages.push({
    username: message.username,
    text: message.text.slice(0, 280),
  });

  if (messages.length > maxContextMessages) {
    messages.splice(0, messages.length - maxContextMessages);
  }

  recentMessagesByChat.set(chatId, messages);
}

function renderChatContext(messages: Array<{ username: string; text: string }>): string {
  if (messages.length === 0) {
    return "Контекст пока пустой.";
  }

  return messages
    .map((message) => `@${message.username}: ${message.text}`)
    .join("\n");
}

function getChatLogInfo(chat: {
  id: number;
  type: string;
  title?: string;
  username?: string;
}): {
  id: number;
  type: string;
  title: string | null;
  username: string | null;
} {
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title ?? null,
    username: chat.username ?? null,
  };
}

function getUserLogInfo(user: {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}): {
  id: number;
  isBot: boolean;
  firstName: string;
  lastName: string | null;
  username: string | null;
} {
  return {
    id: user.id,
    isBot: user.is_bot,
    firstName: user.first_name,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
  };
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};
