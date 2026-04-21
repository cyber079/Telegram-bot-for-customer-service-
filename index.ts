/**
 * Generator Service Bot — index.ts
 *
 * ─── DB changes required ─────────────────────────────────────────────────────
 *
 *  1. ALTER TABLE service_logs ADD COLUMN IF NOT EXISTS pending_eta_tech_id TEXT;
 *
 *  2. CREATE TABLE IF NOT EXISTS tech_sessions (
 *       user_id        TEXT PRIMARY KEY,
 *       pending_log_id TEXT,
 *       updated_at     TIMESTAMPTZ DEFAULT now()
 *     );
 *
 * ─── Tech phone registration (automated) ─────────────────────────────────────
 *
 *  OLD: tech manually types /register 09xxx
 *
 *  NEW: tech taps Acknowledge → bot checks phone on record
 *    → phone exists   → normal ETA flow (unchanged)
 *    → phone missing  → bot DMs tech privately: "share your contact"
 *                     → tech_sessions row stores pending_log_id
 *                     → tech taps share contact button in their DM
 *                     → bot saves phone, resumes acknowledge on that job
 *                     → customer never sees any of this
 *
 * ─── Custom ETA flow ─────────────────────────────────────────────────────────
 *
 *  Tech taps [Custom ✍️]
 *    → service_logs row gets pending_eta_tech_id = tech's Telegram user_id
 *    → bot sends a plain prompt in the group (no ForceReply)
 *  Tech types any plain message in the group
 *    → bot queries pending_eta_tech_id
 *    → found  → apply ETA, clear flag, notify customer
 *    → not found → normal group message, ignored
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// Types
// ============================================================
type TgUser = {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramUpdate = {
  message?: {
    message_id?: number;
    text?: string;
    contact?: { phone_number?: string };
    from?: TgUser;
    chat?: { id?: number; type?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number } };
    from?: TgUser;
  };
};

type ConversationState =
  | "waiting_name"
  | "waiting_location"
  | "waiting_issue"
  | "waiting_phone"
  | "confirming"
  | "submitted";

type Session = {
  user_id: string;
  state: ConversationState;
  temp_name?: string;
  temp_location?: string;
  temp_issue?: string;
  temp_phone?: string;
};

type TechSession = {
  user_id: string;
  pending_log_id: string | null;
};

type ServiceLog = {
  id: string;
  customer_id: string;
  customer_name: string;
  location: string;
  issue_text: string;
  ai_summary: string;
  priority: "High" | "Low";
  status: "Pending" | "Acknowledged" | "Completed";
  customer_phone?: string;
  technician_name?: string;
  eta?: string;
  telegram_msg_id?: number;
  pending_eta_tech_id?: string;
};

type Technician = { user_id: string; name: string; phone: string };

// ============================================================
// Config
// ============================================================
const BOT_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN")        ?? "";
const GROUP_ID   = Deno.env.get("TELEGRAM_GROUP_ID")         ?? "";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")            ?? "";
const SB_URL     = Deno.env.get("SUPABASE_URL")              ?? "";
const SB_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SB_URL, SB_KEY);

const ETA_OPTIONS = [
  { key: "30mins",   label: "၃၀ မိနစ်အတွင်း" },
  { key: "1hour",    label: "၁ နာရီအတွင်း"   },
  { key: "2hours",   label: "၂ နာရီအတွင်း"   },
  { key: "tomorrow", label: "မနက်ဖြန်"         },
];

// ============================================================
// Telegram helpers
// ============================================================
function tgPost(method: string, body: Record<string, unknown>) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type TgResult = {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
  parameters?: { migrate_to_chat_id?: number };
};

async function sendMsg(
  chatId: number | string,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<TgResult> {
  const res = await tgPost("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", ...extra,
  });
  return res.json() as Promise<TgResult>;
}

function editMsg(
  chatId: number | string, msgId: number, text: string,
  extra: Record<string, unknown> = {}
) {
  return tgPost("editMessageText", {
    chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", ...extra,
  });
}

function answerCb(id: string, text = "") {
  return tgPost("answerCallbackQuery", { callback_query_id: id, text });
}

function deleteMsg(chatId: number | string, msgId: number) {
  return tgPost("deleteMessage", { chat_id: chatId, message_id: msgId });
}

function getName(u?: TgUser): string {
  return (
    [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() ||
    u?.username || "Unknown"
  );
}

// Tech DM: ask to share contact
function requestTechContactKeyboard() {
  return {
    keyboard: [[{ text: "📱 ဖုန်းနံပါတ် မျှဝေမည်", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

// Customer DM: ask to share contact
function requestContactKeyboard() {
  return {
    keyboard: [[{ text: "📱 ဖုန်းနံပါတ် ပေးပို့မည်", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

// ============================================================
// Customer session helpers
// ============================================================
async function getSession(userId: string): Promise<Session | null> {
  const { data } = await supabase
    .from("user_sessions").select("*").eq("user_id", userId).single();
  return (data as Session) ?? null;
}
async function setSession(userId: string, patch: Partial<Session>) {
  await supabase.from("user_sessions").upsert({
    user_id: userId, updated_at: new Date().toISOString(), ...patch,
  });
}
async function clearSession(userId: string) {
  await supabase.from("user_sessions").delete().eq("user_id", userId);
}

// ============================================================
// Tech session helpers
// pending_log_id = the job being held while we wait for their phone
// ============================================================
async function getTechSession(userId: string): Promise<TechSession | null> {
  const { data } = await supabase
    .from("tech_sessions").select("*").eq("user_id", userId).single();
  return (data as TechSession) ?? null;
}
async function setTechSession(userId: string, pendingLogId: string) {
  await supabase.from("tech_sessions").upsert({
    user_id: userId, pending_log_id: pendingLogId,
    updated_at: new Date().toISOString(),
  });
}
async function clearTechSession(userId: string) {
  await supabase.from("tech_sessions").delete().eq("user_id", userId);
}

// ============================================================
// Technician helpers
// ============================================================
async function getTechPhone(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("technicians").select("phone").eq("user_id", userId).single();
  return (data as { phone?: string } | null)?.phone ?? null;
}
async function upsertTechnician(tech: Technician) {
  await supabase.from("technicians").upsert({
    ...tech, updated_at: new Date().toISOString(),
  });
}

// ============================================================
// Gemini summarization
// ============================================================
async function summarize(
  issueText: string
): Promise<{ aiSummary: string; priority: "High" | "Low" }> {
  if (!GEMINI_KEY) return { aiSummary: issueText, priority: "Low" };
  try {
    const prompt =
      `Summarize this generator issue in 1 clear English sentence. ` +
      `If Burmese, translate first. Assign priority High or Low.\n\n` +
      `Issue: "${issueText}"\n\nFormat:\nSummary: <one sentence>\nPriority: <High|Low>`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
        }),
      }
    );
    const data = await res.json();
    const raw: string =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text ?? "")
        .join("\n") ?? "";
    const lines        = raw.split("\n").map((l: string) => l.trim());
    const summaryLine  = lines.find((l) => /^summary\s*:/i.test(l));
    const priorityLine = lines.find((l) => /^priority\s*:/i.test(l));
    const aiSummary = summaryLine
      ? summaryLine.replace(/^summary\s*:\s*/i, "").trim() : issueText;
    const p = priorityLine
      ? priorityLine.replace(/^priority\s*:\s*/i, "").trim().toLowerCase() : "low";
    return { aiSummary, priority: p === "high" ? "High" : "Low" };
  } catch {
    return { aiSummary: issueText, priority: "Low" };
  }
}

// ============================================================
// Card + keyboards
// ============================================================
function buildCard(opts: {
  name: string; location: string; summary: string; priority: "High" | "Low";
  status?: "Pending" | "Acknowledged" | "Completed";
  customerPhone?: string; techName?: string; techPhone?: string; eta?: string;
}): string {
  const { name, location, summary, priority, status = "Pending",
          customerPhone, techName, techPhone, eta } = opts;
  const pTag = priority === "High" ? "🔴 High" : "🟢 Low";
  const sTag =
    status === "Completed"    ? "✅ ပြီးဆုံး"   :
    status === "Acknowledged" ? "🆗 လက်ခံပြီး" : "⏳ စောင့်ဆိုင်း";
  const lines = [
    "🚨 <b>Job အသစ်</b>",
    `👤 Customer:   ${name}`,
    `📞 ဖုန်း:       ${customerPhone ?? "မပေး"}`,
    `📍 နေရာ:       ${location}`,
    `🔧 ပြဿနာ:     ${summary}`,
    `🔥 Priority:   ${pTag}`,
    `📌 Status:     ${sTag}`,
  ];
  if (techName)  lines.push(`👷 ဆောင်ရွက်သူ:      ${techName}`);
  if (techPhone) lines.push(`📲 Tech ဖုန်း:       ${techPhone}`);
  if (eta)       lines.push(`⏰ ရောက်မည့်အချိန်: ${eta}`);
  return lines.join("\n");
}

function jobKeyboard(logId: string) {
  return { inline_keyboard: [[
    { text: "Acknowledge 🆗", callback_data: `ack_${logId}` },
    { text: "Complete ✅",    callback_data: `done_${logId}` },
  ]]};
}

function etaKeyboard(logId: string) {
  return { inline_keyboard: [
    [
      { text: "၃၀ မိနစ်", callback_data: `eta_${logId}_30mins`   },
      { text: "၁ နာရီ",   callback_data: `eta_${logId}_1hour`    },
    ],
    [
      { text: "၂ နာရီ",    callback_data: `eta_${logId}_2hours`   },
      { text: "မနက်ဖြန်", callback_data: `eta_${logId}_tomorrow` },
    ],
    [{ text: "Custom ✍️", callback_data: `eta_${logId}_custom` }],
  ]};
}

// ============================================================
// Shared ETA apply
// ============================================================
async function applyEta(opts: {
  logId: string; eta: string; techName: string;
  techUserId: string; cbChatId: number | undefined; msgId: number;
}) {
  const { logId, eta, techName, techUserId, cbChatId, msgId } = opts;
  const techPhone = await getTechPhone(techUserId);

  await supabase.from("service_logs")
    .update({
      eta,
      technician_name:     techName,
      status:              "Acknowledged",
      pending_eta_tech_id: null,
    })
    .eq("id", logId);

  const { data: log } = await supabase
    .from("service_logs").select("*").eq("id", logId).single() as
    { data: ServiceLog | null };

  if (log) {
    if (cbChatId && msgId) {
      await editMsg(cbChatId, msgId, buildCard({
        name: log.customer_name, location: log.location,
        summary: log.ai_summary, priority: log.priority,
        status: "Acknowledged", customerPhone: log.customer_phone,
        techName, techPhone: techPhone ?? undefined, eta,
      }), { reply_markup: { inline_keyboard: [[
        { text: "Complete ✅", callback_data: `done_${logId}` }
      ]]}});
    }
    // Customer only sees: tech name, tech phone, ETA
    await sendMsg(log.customer_id,
      `🆗 <b>သင့်ပြဿနာ လက်ခံပြီးပါပြီ!</b>\n\n` +
      `👷 ဆောင်ရွက်သူ: <b>${techName}</b>\n` +
      (techPhone ? `📲 ဆက်သွယ်ရန် ဖုန်း: <b>${techPhone}</b>\n` : "") +
      `⏰ ရောက်မည့်အချိန်: <b>${eta}</b>\n\n` +
      `မေးမြန်းလိုပါက တိုက်ရိုက် ဆက်သွယ်နိုင်ပါသည်။`
    );
  }
}

// ============================================================
// doAcknowledge — update job card + show ETA keyboard
// Called both from callback (phone already known) and after
// tech shares their contact (phone just saved).
// ============================================================
async function doAcknowledge(opts: {
  logId: string; techName: string; techUserId: string;
  techPhone: string; cbChatId: number; msgId: number; cbId?: string;
}) {
  const { logId, techName, techUserId, techPhone, cbChatId, msgId, cbId } = opts;

  const { data: log } = await supabase
    .from("service_logs")
    .select("customer_name, location, ai_summary, priority, customer_phone")
    .eq("id", logId).single() as { data: ServiceLog | null };

  await supabase.from("service_logs")
    .update({ status: "Acknowledged", technician_name: techName }).eq("id", logId);

  const cardText = (log
    ? buildCard({
        name: log.customer_name, location: log.location,
        summary: log.ai_summary, priority: log.priority,
        status: "Acknowledged", customerPhone: log.customer_phone,
        techName, techPhone,
      })
    : "Job Acknowledged"
  ) + "\n\n🕐 <b>ရောက်မည့်အချိန် ရွေးပါ:</b>";

  await editMsg(cbChatId, msgId, cardText, { reply_markup: etaKeyboard(logId) });
  if (cbId) await answerCb(cbId, "ETA ရွေးပါ");
}

// ============================================================
// Main handler
// ============================================================
serve(async (req) => {
  if (!BOT_TOKEN || !GROUP_ID || !SB_URL || !SB_KEY)
    return new Response("Missing env vars", { status: 500 });

  const update = (await req.json()) as TelegramUpdate;

  // ──────────────────────────────────────────────────────────
  // A. CALLBACK QUERIES
  // ──────────────────────────────────────────────────────────
  if (update.callback_query) {
    const { id: cbId, data: cbData = "", from, message } = update.callback_query;
    const cbChatId   = message?.chat?.id;
    const msgId      = message?.message_id!;
    const techName   = getName(from);
    const techUserId = String(from?.id ?? "");

    // ── A1. Customer confirms ──────────────────────────────
    const confirmMatch = cbData.match(/^confirm_(\d+)$/);
    if (confirmMatch) {
      const userId  = confirmMatch[1];
      const session = await getSession(userId);
      if (!session || session.state !== "confirming") {
        await answerCb(cbId, "Session မရှိပါ။ /start နှိပ်ပါ။");
        return new Response("ok");
      }

      const name     = session.temp_name     ?? "Unknown";
      const location = session.temp_location ?? "Unknown";
      const issue    = session.temp_issue    ?? "";
      const phone    = session.temp_phone    ?? null;

      await answerCb(cbId, "တင်ပြနေသည်...");
      if (cbChatId && msgId)
        await editMsg(cbChatId, msgId, "⏳ တင်ပြနေသည်… ခဏစောင့်ပါ။");

      const { aiSummary, priority } = await summarize(issue);

      const { data: log, error: insertErr } = await supabase
        .from("service_logs")
        .insert({
          customer_id: userId, customer_name: name, location,
          issue_text: issue, ai_summary: aiSummary, priority,
          status: "Pending", customer_phone: phone,
        })
        .select("id").single();

      if (insertErr || !log) {
        await sendMsg(Number(userId), "❌ ပြဿနာ တင်ပြ၍မရပါ။ /start နှိပ်ပြီး ထပ်မံကြိုးစားပါ။");
        return new Response("ok");
      }

      const tgResult = await sendMsg(
        GROUP_ID,
        buildCard({ name, location, summary: aiSummary, priority, customerPhone: phone ?? undefined }),
        { reply_markup: jobKeyboard(log.id) }
      );

      if (!tgResult.ok) {
        const newChatId = tgResult.parameters?.migrate_to_chat_id;
        if (newChatId) {
          const retry = await sendMsg(newChatId,
            buildCard({ name, location, summary: aiSummary, priority, customerPhone: phone ?? undefined }),
            { reply_markup: jobKeyboard(log.id) }
          );
          if (retry.ok) {
            if (retry.result?.message_id)
              await supabase.from("service_logs")
                .update({ telegram_msg_id: retry.result.message_id }).eq("id", log.id);
            await sendMsg(newChatId,
              `⚙️ <b>Admin:</b> Group upgraded. Update TELEGRAM_GROUP_ID to <code>${newChatId}</code>`);
            await clearSession(userId);
            await setSession(userId, { state: "submitted" });
            if (cbChatId && msgId)
              await editMsg(cbChatId, msgId,
                `✅ <b>တင်ပြပြီးပါပြီ!</b>\n\n📝 "${aiSummary}"\n\nကျွန်ုပ်တို့ မကြာမီ ဆက်သွယ်ပါမည်။ 🙏`);
            return new Response("ok");
          }
        }
        await supabase.from("service_logs")
          .update({ ai_summary: `[GROUP SEND FAILED] ${aiSummary}` }).eq("id", log.id);
        if (cbChatId && msgId)
          await editMsg(cbChatId, msgId,
            `⚠️ DB သိမ်းဆည်းပြီး၊ ဝန်ဆောင်မှုအဖွဲ့သို့ မပေးပို့နိုင်ပါ။\n❗ ${tgResult.description ?? "unknown"}`);
        return new Response("ok");
      }

      if (tgResult.result?.message_id)
        await supabase.from("service_logs")
          .update({ telegram_msg_id: tgResult.result.message_id }).eq("id", log.id);

      await clearSession(userId);
      await setSession(userId, { state: "submitted" });
      if (cbChatId && msgId)
        await editMsg(cbChatId, msgId,
          `✅ <b>တင်ပြပြီးပါပြီ!</b>\n\n📝 "${aiSummary}"\n\nကျွန်ုပ်တို့ မကြာမီ ဆက်သွယ်ပါမည်။ 🙏`);
      return new Response("ok");
    }

    // ── A2. Customer restarts ──────────────────────────────
    const restartMatch = cbData.match(/^restart_(\d+)$/);
    if (restartMatch) {
      const userId = restartMatch[1];
      await clearSession(userId);
      await setSession(userId, { state: "waiting_name" });
      await answerCb(cbId, "ပြန်စသည်");
      if (cbChatId && msgId)
        await editMsg(cbChatId, msgId, "🔄 ပြန်လည်စတင်ပါမည်။\n\n<b>သင့်နာမည်ကို ရိုက်ထည့်ပါ။</b>");
      return new Response("ok");
    }

    // ── A3. Acknowledge ────────────────────────────────────
    const ackMatch = cbData.match(/^ack_(.+)$/);
    if (ackMatch) {
      const logId     = ackMatch[1];
      const techPhone = await getTechPhone(techUserId);

      if (!techPhone) {
        // No phone on record → DM the tech to share their contact.
        // Store the job ID so we can resume once the contact arrives.
        await setTechSession(techUserId, logId);
        await answerCb(cbId, "ဖုန်းနံပါတ် တစ်ကြိမ်သာ မျှဝေပေးပါ 📱");
        await sendMsg(Number(techUserId),
          `👋 <b>${techName}</b>\n\n` +
          `Job လက်ခံရန် ဖုန်းနံပါတ် တစ်ကြိမ်သာ မျှဝေပေးပါ။\n` +
          `ပြီးရင် အလိုအလျောက် ဆက်လက်ဆောင်ရွက်ပါမည်။`,
          { reply_markup: requestTechContactKeyboard() }
        );
        return new Response("ok");
      }

      // Phone already saved — go straight to ETA selection
      await doAcknowledge({
        logId, techName, techUserId, techPhone,
        cbChatId: cbChatId!, msgId, cbId,
      });
      return new Response("ok");
    }

    // ── A4. ETA selection ──────────────────────────────────
    const etaMatch = cbData.match(/^eta_(.+?)_(.+)$/);
    if (etaMatch) {
      const [, logId, etaKey] = etaMatch;

      // ── A4a. Custom ETA ──────────────────────────────────
      if (etaKey === "custom") {
        await supabase.from("service_logs")
          .update({ pending_eta_tech_id: techUserId })
          .eq("id", logId);

        await sendMsg(cbChatId!,
          `✍️ <b>${techName}</b>\n` +
          `ရောက်မည့်အချိန်ကို group ထဲ ရိုက်ထည့်ပြီး send လိုက်ပါ။\n` +
          `<i>(ဥပမာ: ၄၅ မိနစ်၊ ၃ နာရီ၊ မနက် ၉ နာရီ)</i>\n\n` +
          `⚠️ <i>နောက်တစ်ကြိမ် ရိုက်သည့် မက်ဆေ့ကို ETA အဖြစ် သတ်မှတ်မည်။</i>`
        );

        await answerCb(cbId, "Group ထဲ အချိန် ရိုက်ထည့်ပါ ✍️");
        return new Response("ok");
      }

      // ── A4b. Preset ETA ──────────────────────────────────
      const eta = ETA_OPTIONS.find((o) => o.key === etaKey)?.label ?? etaKey;
      await applyEta({ logId, eta, techName, techUserId, cbChatId, msgId });
      await answerCb(cbId, `ETA: ${eta}`);
      return new Response("ok");
    }

    // ── A5. Complete ───────────────────────────────────────
    const doneMatch = cbData.match(/^done_(.+)$/);
    if (doneMatch) {
      const logId     = doneMatch[1];
      const techPhone = await getTechPhone(techUserId);

      await supabase.from("service_logs")
        .update({ status: "Completed", technician_name: techName }).eq("id", logId);

      const { data: log } = await supabase
        .from("service_logs").select("*").eq("id", logId).single() as
        { data: ServiceLog | null };

      if (log) {
        if (cbChatId && msgId)
          await editMsg(cbChatId, msgId, buildCard({
            name: log.customer_name, location: log.location,
            summary: log.ai_summary, priority: log.priority,
            status: "Completed", customerPhone: log.customer_phone,
            techName, techPhone: techPhone ?? undefined, eta: log.eta,
          }));
        // Customer only sees: tech name, tech phone — nothing about registration
        await sendMsg(log.customer_id,
          `✅ <b>ပြဿနာ ဖြေရှင်းပြီးပါပြီ!</b>\n\n` +
          `👷 ဆောင်ရွက်သူ: <b>${techName}</b>\n` +
          (techPhone ? `📲 ဆက်သွယ်ရန် ဖုန်း: <b>${techPhone}</b>\n` : "") +
          `\nကျေးဇူးတင်ပါသည်! 🙏\n` +
          `ပြဿနာအသစ် တင်ပြရန် /start နှိပ်ပါ။`
        );
      }
      await answerCb(cbId, "Completed! ✅");
      return new Response("ok");
    }

    await answerCb(cbId, "OK");
    return new Response("ok");
  }

  // ──────────────────────────────────────────────────────────
  // B. MESSAGES
  // ──────────────────────────────────────────────────────────
  const msg = update.message;
  if (!msg?.from?.id) return new Response("ignored");

  const userId     = String(msg.from.id);
  const chatId     = msg.from.id;
  const text       = (msg.text ?? "").trim();
  const isGroupMsg = msg.chat?.type === "group" || msg.chat?.type === "supergroup";

  // ── B0. Custom ETA intercept (group only) ─────────────
  if (isGroupMsg && text) {
    const { data: pendingLog } = await supabase
      .from("service_logs")
      .select("id, telegram_msg_id")
      .eq("pending_eta_tech_id", userId)
      .limit(1)
      .single() as { data: { id: string; telegram_msg_id?: number } | null };

    if (pendingLog) {
      await supabase.from("service_logs")
        .update({ pending_eta_tech_id: null })
        .eq("id", pendingLog.id);

      if (msg.message_id)
        await deleteMsg(msg.chat!.id!, msg.message_id);

      await applyEta({
        logId:      pendingLog.id,
        eta:        text,
        techName:   getName(msg.from),
        techUserId: userId,
        cbChatId:   msg.chat?.id,
        msgId:      pendingLog.telegram_msg_id ?? 0,
      });

      return new Response("ok");
    }
  }

  // ── Group commands ─────────────────────────────────────────
  if (isGroupMsg) {
    if (text === "/checksetup") {
      const probe = await sendMsg(GROUP_ID,
        `🔧 <b>Setup စစ်ဆေးချက်</b>\nBot: ✅\nGroup ID: <code>${GROUP_ID}</code>`);
      await sendMsg(chatId, probe.ok
        ? "✅ Group ID မှန်ကန်သည်။"
        : `❌ Group မပို့နိုင်ပါ!\n${probe.description ?? "unknown"}`);
      return new Response("ok");
    }
    // /register removed — phone collection is now fully automatic
    return new Response("ok");
  }

  // ── DM messages only below ─────────────────────────────────

  // ── B1. Contact shared (DM) ───────────────────────────────
  if (msg.contact?.phone_number) {
    const phone = msg.contact.phone_number;

    // Check tech session first — tech sharing phone to resume an ack
    const techSession = await getTechSession(userId);
    if (techSession?.pending_log_id) {
      const logId    = techSession.pending_log_id;
      const techName = getName(msg.from);

      // Persist phone
      await upsertTechnician({ user_id: userId, name: techName, phone });
      await clearTechSession(userId);

      // Dismiss the contact-share keyboard
      await sendMsg(chatId, "✅ မှတ်သားပြီးပါပြီ! Job ဆက်လက်လက်ခံနေသည်…",
        { reply_markup: { remove_keyboard: true } });

      // Look up the group message to update the card
      const { data: log } = await supabase
        .from("service_logs")
        .select("telegram_msg_id")
        .eq("id", logId).single() as { data: { telegram_msg_id?: number } | null };

      await doAcknowledge({
        logId,
        techName,
        techUserId: userId,
        techPhone:  phone,
        cbChatId:   Number(GROUP_ID),
        msgId:      log?.telegram_msg_id ?? 0,
      });

      return new Response("ok");
    }

    // Otherwise — customer sharing their contact
    const session = await getSession(userId);
    if (session?.state === "waiting_phone") {
      const name     = session.temp_name     ?? "Unknown";
      const location = session.temp_location ?? "Unknown";
      const issue    = session.temp_issue    ?? "";

      await setSession(userId, { state: "confirming", temp_phone: phone });
      await sendMsg(chatId, "📞 ဖုန်းနံပါတ် လက်ခံပြီးပါပြီ!",
        { reply_markup: { remove_keyboard: true } });
      await sendMsg(chatId,
        `📋 <b>သင့်တင်ပြချက် စစ်ဆေးပါ:</b>\n\n` +
        `👤 နာမည်:       <b>${name}</b>\n` +
        `📍 နေရာ:        <b>${location}</b>\n` +
        `🔧 ပြဿနာ:      <b>${issue}</b>\n` +
        `📞 ဖုန်းနံပါတ်: <b>${phone}</b>\n\n<b>မှန်ကန်ပါသလား?</b>`,
        { reply_markup: { inline_keyboard: [[
          { text: "✅ တင်ပြမည်", callback_data: `confirm_${userId}` },
          { text: "🔄 ပြင်မည်", callback_data: `restart_${userId}` },
        ]]}});
    }
    return new Response("ok");
  }

  if (!text) return new Response("ignored");

  // ── B2. /start / /restart ─────────────────────────────────
  if (text === "/start" || text === "/restart") {
    await clearSession(userId);
    await setSession(userId, { state: "waiting_name" });
    await sendMsg(chatId,
      "မင်္ဂလာပါ! 👋\n\n  ပြဿနာ တင်ပြရန် ကူညီပေးပါမည်။\n\n<b>သင့်ဧ။်နာမည်ကို ရိုက်ထည့်ပါ။</b>");
    return new Response("ok");
  }

  // ── B3. Customer conversation state machine ───────────────
  const session = await getSession(userId);
  if (!session) {
    await sendMsg(chatId, "မင်္ဂလာပါ! 👋\n/start နှိပ်ပြီး စတင်ပါ။");
    return new Response("ok");
  }

  switch (session.state) {
    case "waiting_name": {
      await setSession(userId, { state: "waiting_location", temp_name: text });
      await sendMsg(chatId,
        `မင်္ဂလာပါ <b>${text}</b>! 😊\n\n📍 <b> တည်နေရာ (လိပ်စာ) ကို ရိုက်ထည့်ပါ။</b>`);
      break;
    }
    case "waiting_location": {
      await setSession(userId, { state: "waiting_issue", temp_location: text });
      await sendMsg(chatId,
        "✅ နေရာ မှတ်သားပြီးပါပြီ!\n\n🔧 <b> ဘယ်လိုပြဿနာ ဖြစ်နေသလဲ ပြောပြပေးပါ။</b>\n" +
        "<i>(ဥပမာ: မီးမလင်းတော့ဘူး ၊ အသံဆူနေသည် ၊ စက်မနိုးပါ)</i>");
      break;
    }
    case "waiting_issue": {
      await setSession(userId, { state: "waiting_phone", temp_issue: text });
      await sendMsg(chatId,
        "✅ ပြဿနာ မှတ်သားပြီးပါပြီ!\n\n📞 <b>ဆက်သွယ်ရန် ဖုန်းနံပါတ် ပေးပို့ပါ။</b>\n" +
        "<i>အောက်ခြေမှ ခလုတ်ကို နှိပ်ပြီး ပေးပို့နိုင်သည်။</i>",
        { reply_markup: requestContactKeyboard() });
      break;
    }
    case "waiting_phone": {
      await sendMsg(chatId,
        "📱 ကျေးဇူးပြု၍ <b>\"📱 ဖုန်းနံပါတ် ပေးပို့မည်\"</b> ခလုတ်ကို နှိပ်ပြီး ပေးပို့ပါ။",
        { reply_markup: requestContactKeyboard() });
      break;
    }
    case "confirming":
    case "submitted": {
      await sendMsg(chatId,
        "သင့်ဧ။်ပြဿနာကို တင်ပြပြီးပါပြီ။ ကျွန်ုပ်တို့ဘက်မှ အမြန်ဆုံး ဆောင်ရွက်နေပါသည်။ 🔧\n\n" +
        "ပြဿနာအသစ် တင်ပြရန် /start နှိပ်ပါ။");
      break;
    }
    default:
      await sendMsg(chatId, "/start နှိပ်ပြီး စတင်ပါ။");
  }

  return new Response("ok");
});