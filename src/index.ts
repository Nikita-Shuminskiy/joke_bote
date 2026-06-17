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
const targetUsernames = new Set(
  (process.env.TARGET_USERNAMES ?? "")
    .split(",")
    .map((value) => value.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean),
);

const aiFallbackLine = "Сегодня даже нейросеть взяла паузу. Считай, это редкий комплимент.";

const helpText = [
  "/start - краткая справка",
  "/help - список команд",
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
const geminiSystemPrompt = [
  "Ты пишешь на русском.",
  "Сгенерируй одну короткую, смешную и добродушную шутку в сухом пафосном стиле.",
  "Стиль: сдержанный, ироничный, псевдо-мудрый вайб боевиков без прямого копирования чьих-либо цитат.",
  "Не используй оскорбления, угрозы, хейт, мат, сексуальный контент, темы внешности, здоровья, расы, религии или унижения.",
  "Отвечай одной фразой длиной до 25 слов.",
].join(" ");

console.log("Bot config loaded", {
  botUsername: process.env.BOT_USERNAME || null,
  hasBotToken: Boolean(token),
  hasGeminiApiKey: Boolean(geminiApiKey),
  geminiModel,
  targetUserIdsCount: targetUserIds.size,
  targetUsernames: [...targetUsernames],
  roastCooldownMs,
  replyChancePercent,
});

bot.start((ctx) => ctx.reply(helpText));
bot.help((ctx) => ctx.reply(helpText));

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
  const now = Date.now();
  const lastReplyAt = lastReplyAtByChat.get(chatId) ?? 0;

  if (now - lastReplyAt < roastCooldownMs) {
    return;
  }

  const username = ctx.from.username?.toLowerCase() ?? "";
  const isTargetUser = targetUserIds.has(ctx.from.id) || targetUsernames.has(username);
  const shouldReply = isTargetUser || roll(replyChancePercent);

  if (!shouldReply) {
    return;
  }

  if (isTargetUser) {
    console.log("Target user message matched", {
      chatId,
      fromId: ctx.from.id,
      username: ctx.from.username ?? null,
      messageId: ctx.message.message_id,
      textPreview: text.slice(0, 120),
    });
  }

  const line = isTargetUser
    ? await generateAiJoke({
        mode: "target",
        messageText: text,
        username: ctx.from.username,
      })
    : await generateAiJoke({
        mode: "group",
        messageText: text,
        username: ctx.from.username,
      });
  lastReplyAtByChat.set(chatId, now);

  await ctx.reply(line, {
    reply_parameters: {
      message_id: ctx.message.message_id,
    },
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
  mode: "general" | "self" | "group" | "target";
  messageText?: string;
  username?: string;
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
  mode: "general" | "self" | "group" | "target";
  messageText?: string;
  username?: string;
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

  if (input.mode === "target") {
    return [
      `Автор сообщения: @${input.username ?? "unknown"}.`,
      `Текст сообщения: "${input.messageText ?? ""}".`,
      "Сделай короткую добродушную подколку по содержанию сообщения, а не по личным качествам человека.",
    ].join("\n");
  }

  return [
    `Автор сообщения: @${input.username ?? "unknown"}.`,
    `Текст сообщения: "${input.messageText ?? ""}".`,
    "Сделай короткую смешную реакцию на сообщение для общего чата.",
    "Реагируй на формулировку или смысл сообщения, без унижения автора.",
  ].join("\n");
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
