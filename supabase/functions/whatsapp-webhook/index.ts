import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendText, sendImage, sendButtons, extractPhone, downloadMediaBase64, resolveLidToPhone } from "../_shared/evolution.ts";
import { generateExpenseChartUrl } from "../_shared/chart.ts";
import { syncGoogleCalendar, syncGoogleSheets, syncNotion, createCalendarEventWithMeet } from "../_shared/integrations.ts";
import {
  chat,
  extractTransactions,
  extractEvent,
  parseAgendaQuery,
  extractAgendaEdit,
  assistantChat,
  transcribeAudio,
  extractReceiptFromImage,
  extractStatementFromImage,
  parseReminderIntent,
  analyzeForwardedContent,
  type ChatMessage,
  type ExtractedEvent,
  type StatementExtraction,
  type ShadowAnalysis,
} from "../_shared/openai.ts";
import { logError, fromThrown } from "../_shared/logger.ts";
import { type Intent, classifyIntent, isReminderDecline, isReminderAtTime, isReminderAccept, parseMinutes } from "../_shared/classify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ─────────────────────────────────────────────
// LOCALIZATION HELPERS
// ─────────────────────────────────────────────

/** Retorna o offset UTC do fuso (ex: "-03:00") calculado em runtime */
function getTzOffset(tz: string): string {
  const now = new Date();
  const utcMs = now.getTime();
  const tzMs = new Date(now.toLocaleString("en-US", { timeZone: tz })).getTime();
  const totalMins = Math.round((tzMs - utcMs) / 60000);
  const sign = totalMins >= 0 ? "+" : "-";
  const abs = Math.abs(totalMins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Retorna a data de hoje (YYYY-MM-DD) no fuso do usuário */
function todayInTz(tz: string): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz });
}

function langToLocale(lang: string): string {
  const map: Record<string, string> = { "pt-BR": "pt-BR", "en": "en-US", "es": "es-ES" };
  return map[lang] ?? "pt-BR";
}

function fmtDateLong(dateStr: string, lang: string): string {
  const locale = langToLocale(lang);
  const d = new Date(dateStr + "T12:00:00");
  const raw = d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function fmtTimeLang(timeStr: string, lang: string): string {
  const [h, m] = timeStr.split(":");
  if (lang === "en") {
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? "PM" : "AM";
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  }
  return `${h.padStart(2, "0")}:${m}`;
}

function fmtAdvanceLabel(minutes: number, lang: string): string {
  if (minutes >= 60) {
    const hrs = minutes / 60;
    const rounded = Math.round(hrs * 10) / 10;
    if (lang === "en") return `${rounded} hour${rounded !== 1 ? "s" : ""}`;
    if (lang === "es") return `${rounded} hora${rounded !== 1 ? "s" : ""}`;
    return `${rounded} hora${rounded !== 1 ? "s" : ""}`;
  }
  if (lang === "en") return `${minutes} min`;
  if (lang === "es") return `${minutes} min`;
  return `${minutes} min`;
}

/** Translates a response text to the target language if needed (non-pt-BR). */
async function translateIfNeeded(text: string, lang: string): Promise<string> {
  if (!text || lang === "pt-BR") return text;
  const targetLang = lang === "en" ? "English" : "Spanish";
  try {
    const result = await chat(
      [{
        role: "user",
        content: `Translate the following WhatsApp message to ${targetLang}. Rules:\n- Keep ALL emojis exactly as they are\n- Keep WhatsApp formatting (*bold*, _italic_) exactly as is\n- Only translate the text content\n- Return ONLY the translated message, nothing else\n\n${text}`,
      }],
      `You are an expert translator. Translate accurately to ${targetLang}. Never add explanations or notes.`,
    );
    return result?.trim() || text;
  } catch {
    return text; // fallback to original on error
  }
}

/** Enfileira mensagem para retry quando o Evolution API falha */
async function queueMessage(phone: string, content: string, userId?: string): Promise<void> {
  try {
    await supabase.from("message_queue").insert({
      user_id: userId ?? null,
      phone,
      message_type: "text",
      content,
      status: "pending",
      next_attempt_at: new Date().toISOString(),
    });
    console.log(`[message_queue] Enqueued for ${phone}`);
  } catch (err) {
    console.error("[message_queue] Failed to queue:", err);
  }
}

// ─────────────────────────────────────────────
// MODULE GATE — mensagem quando módulo está off
// ─────────────────────────────────────────────

type ModuleMap = { finance: boolean; agenda: boolean; notes: boolean; chat: boolean };

function getModuleDisabledMsg(
  intent: Intent,
  lang: string,
  modules: ModuleMap
): string {
  const INTENT_TO_MODULE: Partial<Record<Intent, keyof ModuleMap>> = {
    finance_record:    "finance",
    finance_report:    "finance",
    budget_set:        "finance",
    budget_query:      "finance",
    recurring_create:  "finance",
    // habit_create e habit_checkin nao mapeados = sempre disponivel
    agenda_create:   "agenda",
    agenda_query:    "agenda",
    agenda_lookup:   "agenda",
    agenda_edit:     "agenda",
    agenda_delete:   "agenda",
    event_followup:  "agenda",
    notes_save:      "notes",
    reminder_set:    "notes",
    reminder_list:   "notes",
    reminder_cancel: "notes",
    reminder_edit:   "notes",
    reminder_snooze: "notes",
    ai_chat:         "chat",
  };

  const module = INTENT_TO_MODULE[intent] ?? "chat";

  // Monta lista dos módulos ativos para mostrar no "chat desativado"
  const activeLabels = {
    "pt-BR": [
      modules.finance && "💰 Financeiro",
      modules.agenda  && "📅 Agenda",
      modules.notes   && "📝 Anotações e Lembretes",
    ],
    "en": [
      modules.finance && "💰 Finances",
      modules.agenda  && "📅 Agenda",
      modules.notes   && "📝 Notes & Reminders",
    ],
    "es": [
      modules.finance && "💰 Finanzas",
      modules.agenda  && "📅 Agenda",
      modules.notes   && "📝 Notas y Recordatorios",
    ],
  };
  const lk = (["pt-BR","en","es"].includes(lang) ? lang : "pt-BR") as "pt-BR"|"en"|"es";
  const activeList = (activeLabels[lk].filter(Boolean) as string[]).join(", ");

  const path = {
    "pt-BR": "Painel → *Config. do Agente* → *Módulos ativos*",
    "en":    "Dashboard → *Agent Config* → *Active Modules*",
    "es":    "Panel → *Config. del Agente* → *Módulos activos*",
  }[lk];

  const noneLabel = {
    "pt-BR": "nenhum módulo ativo",
    "en":    "no modules are currently active",
    "es":    "no hay módulos activos en este momento",
  }[lk];

  const MSGS: Record<"pt-BR"|"en"|"es", Record<keyof ModuleMap, string>> = {
    "pt-BR": {
      finance: `💰 O módulo *Financeiro* está desativado.\nNão consigo registrar gastos ou receitas agora.\n\n➡️ Para ativar acesse: ${path} e ligue o *Financeiro*.`,
      agenda:  `📅 O módulo *Agenda* está desativado.\nNão consigo gerenciar compromissos ou lembretes de eventos agora.\n\n➡️ Para ativar acesse: ${path} e ligue a *Agenda*.`,
      notes:   `📝 O módulo *Anotações e Lembretes* está desativado.\nNão consigo salvar notas nem criar lembretes agora.\n\n➡️ Para ativar acesse: ${path} e ligue as *Anotações*.`,
      chat:    `💬 A *Conversa livre* está desativada.\nPosso te ajudar com: ${activeList || noneLabel}.\n\n➡️ Para ativar acesse: ${path} e ligue a *Conversa livre*.`,
    },
    "en": {
      finance: `💰 The *Finance* module is disabled.\nI can't record expenses or income right now.\n\n➡️ To enable it, go to: ${path} and turn on *Finance*.`,
      agenda:  `📅 The *Agenda* module is disabled.\nI can't manage your calendar or event reminders right now.\n\n➡️ To enable it, go to: ${path} and turn on *Agenda*.`,
      notes:   `📝 The *Notes & Reminders* module is disabled.\nI can't save notes or create reminders right now.\n\n➡️ To enable it, go to: ${path} and turn on *Notes*.`,
      chat:    `💬 *Free Conversation* is disabled.\nI can help you with: ${activeList || noneLabel}.\n\n➡️ To enable it, go to: ${path} and turn on *Free Conversation*.`,
    },
    "es": {
      finance: `💰 El módulo *Financiero* está desactivado.\nNo puedo registrar gastos ni ingresos ahora.\n\n➡️ Para activarlo ve a: ${path} y activa el *Financiero*.`,
      agenda:  `📅 El módulo *Agenda* está desactivado.\nNo puedo gestionar tu calendario ni recordatorios de eventos ahora.\n\n➡️ Para activarlo ve a: ${path} y activa la *Agenda*.`,
      notes:   `📝 El módulo *Notas y Recordatorios* está desactivado.\nNo puedo guardar notas ni crear recordatorios ahora.\n\n➡️ Para activarlo ve a: ${path} y activa las *Notas*.`,
      chat:    `💬 La *Conversación libre* está desactivada.\nPuedo ayudarte con: ${activeList || noneLabel}.\n\n➡️ Para activarla ve a: ${path} y activa la *Conversación libre*.`,
    },
  };

  return MSGS[lk][module];
}

// ─────────────────────────────────────────────
// RATE LIMITER — max 20 msgs/min, 200 msgs/hour
// ─────────────────────────────────────────────
const RATE_LIMIT_PER_MINUTE = 20;
const RATE_LIMIT_PER_HOUR   = 200;
const BLOCK_DURATION_MS     = 60 * 60 * 1000; // 1h block after burst

async function checkRateLimit(phone: string): Promise<{ allowed: boolean; reason?: string }> {
  const now = new Date();
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();

  const { data: row } = await supabase
    .from("rate_limits")
    .select("count, hour_count, window_start, hour_window_start, blocked_until")
    .eq("phone_number", phone)
    .maybeSingle();

  // Blocked?
  if (row?.blocked_until && new Date(row.blocked_until) > now) {
    return { allowed: false, reason: "blocked" };
  }

  // Contadores por minuto
  const windowStart = row?.window_start ?? now.toISOString();
  const isNewMinuteWindow = !row || new Date(windowStart) < new Date(minuteAgo);
  const minuteCount = isNewMinuteWindow ? 1 : (row?.count ?? 0) + 1;

  // Contadores por hora
  const hourWindowStart = row?.hour_window_start ?? now.toISOString();
  const isNewHourWindow = !row?.hour_window_start || new Date(hourWindowStart) < new Date(hourAgo);
  const hourCount = isNewHourWindow ? 1 : (row?.hour_count ?? 0) + 1;

  // Bloqueia se excedeu minuto OU hora
  if (minuteCount > RATE_LIMIT_PER_MINUTE || hourCount > RATE_LIMIT_PER_HOUR) {
    const blockedUntil = new Date(now.getTime() + BLOCK_DURATION_MS).toISOString();
    await supabase.from("rate_limits").upsert({
      phone_number: phone,
      count: minuteCount,
      window_start: isNewMinuteWindow ? now.toISOString() : windowStart,
      hour_count: hourCount,
      hour_window_start: isNewHourWindow ? now.toISOString() : hourWindowStart,
      blocked_until: blockedUntil,
    }, { onConflict: "phone_number" });
    return { allowed: false, reason: "rate_exceeded" };
  }

  // Atualiza contadores
  await supabase.from("rate_limits").upsert({
    phone_number: phone,
    count: minuteCount,
    window_start: isNewMinuteWindow ? now.toISOString() : windowStart,
    hour_count: hourCount,
    hour_window_start: isNewHourWindow ? now.toISOString() : hourWindowStart,
    blocked_until: null,
  }, { onConflict: "phone_number" });

  return { allowed: true };
}

// ─────────────────────────────────────────────
// Intent classification and parser helpers are imported from ../_shared/classify.ts

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────

function applyTemplate(template: string, vars: Record<string, string>): string {
  let result = Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, v),
    template
  );
  // Converte \n literal (vindo do banco) em newline real
  result = result.replace(/\\n/g, "\n");
  return result;
}

// ─────────────────────────────────────────────
// HABIT HANDLERS
// ─────────────────────────────────────────────

async function handleHabitCreate(userId: string, phone: string, message: string, userTz = "America/Sao_Paulo"): Promise<string> {
  const prompt = `Extraia de uma frase em português os dados para criar um hábito diário.
Retorne JSON puro: {"name":"nome curto","description":"descricao","reminder_time":"HH:MM","icon":"emoji"}

Exemplos:
- "quero criar habito de beber agua a cada 2h" → {"name":"Beber agua","description":"Beber agua regularmente","reminder_time":"08:00","icon":"💧"}
- "habito de exercicio todo dia as 7h" → {"name":"Exercicio","description":"Treino diario","reminder_time":"07:00","icon":"🏃"}
- "criar rotina de leitura" → {"name":"Leitura","description":"Ler todos os dias","reminder_time":"21:00","icon":"📚"}

Frase: "${message}"`;

  const aiResponse = await chat([{ role: "user", content: prompt }], "Voce extrai dados de habitos. Responda APENAS com JSON valido.");
  let parsed: any;
  try {
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON");
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return "Nao entendi. Exemplo: *quero habito de exercicio todo dia as 7h*";
  }

  if (!parsed.name) return "Nao consegui identificar o habito. Exemplo: *habito de beber agua*";

  const { error, data } = await supabase
    .from("habits")
    .insert({
      user_id: userId,
      name: parsed.name,
      description: parsed.description || null,
      reminder_times: JSON.stringify([parsed.reminder_time || "08:00"]),
      target_days: JSON.stringify([0, 1, 2, 3, 4, 5, 6]),
      icon: parsed.icon || "🎯",
      color: "#6366f1",
      is_active: true,
      current_streak: 0,
      best_streak: 0,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Habit create error:", error);
    return "Erro ao criar habito. Tente novamente.";
  }

  // Cria lembrete recorrente diario para o habito (respeita timezone do usuario)
  const [hours, mins] = (parsed.reminder_time || "08:00").split(":").map(Number);
  // Calcula send_at no timezone do usuario convertendo para UTC
  const todayLocal = new Date().toLocaleDateString("sv-SE", { timeZone: userTz });
  const tzOff = getTzOffset(userTz);
  const sendAt = new Date(`${todayLocal}T${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00${tzOff}`);
  if (sendAt <= new Date()) sendAt.setDate(sendAt.getDate() + 1);

  await supabase.from("reminders").insert({
    user_id: userId,
    whatsapp_number: phone,
    title: `Habito: ${parsed.name}`,
    message: `${parsed.icon || "🎯"} Hora do habito: *${parsed.name}*!\n\nQuando terminar, responda *feito* para registrar.`,
    send_at: sendAt.toISOString(),
    recurrence: "daily",
    source: "habit",
    status: "pending",
  });

  return `✅ *Habito criado!*\n\n${parsed.icon || "🎯"} *${parsed.name}*\n${parsed.description ? `📝 ${parsed.description}\n` : ""}⏰ Lembrete diario as ${parsed.reminder_time || "08:00"}\n\nQuando completar, responda *feito* e eu registro seu progresso!`;
}

async function handleHabitCheckin(userId: string, message: string, userTz = "America/Sao_Paulo"): Promise<string> {
  // Usa timezone do usuario para determinar "hoje" corretamente
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: userTz });

  // Busca habitos ativos do usuario
  const { data: habits } = await supabase
    .from("habits")
    .select("id, name, icon, current_streak, best_streak")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (!habits?.length) {
    return "Voce nao tem habitos ativos. Crie um: *quero habito de exercicio todo dia as 7h*";
  }

  // Verifica quais ainda nao foram feitos hoje
  const { data: todayLogs } = await supabase
    .from("habit_logs")
    .select("habit_id")
    .eq("user_id", userId)
    .eq("logged_date", today);

  const doneIds = new Set((todayLogs ?? []).map((l: any) => l.habit_id));
  const pending = habits.filter((h: any) => !doneIds.has(h.id));

  if (pending.length === 0) {
    return "🎉 Todos os habitos de hoje ja foram registrados! Continue assim!";
  }

  // Registra o primeiro habito pendente
  const habit = pending[0] as any;
  const { error } = await supabase.from("habit_logs").insert({
    habit_id: habit.id,
    user_id: userId,
    logged_date: today,
  });

  if (error) {
    if (error.code === "23505") return "Ja registrado hoje! 👍";
    console.error("Habit checkin error:", error);
    return "Erro ao registrar. Tente novamente.";
  }

  // Verifica se o dia anterior tinha check-in para validar streak consecutivo
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString("sv-SE", { timeZone: userTz });
  const { data: yesterdayLog } = await (supabase.from("habit_logs") as any)
    .select("id")
    .eq("habit_id", habit.id)
    .eq("logged_date", yesterdayStr)
    .maybeSingle();

  // Se ontem nao teve check-in, reseta streak para 1; senao incrementa
  const newStreak = yesterdayLog ? (habit.current_streak || 0) + 1 : 1;
  const bestStreak = Math.max(newStreak, habit.best_streak || 0);
  await supabase.from("habits").update({
    current_streak: newStreak,
    best_streak: bestStreak,
  }).eq("id", habit.id);

  // Mensagem motivacional baseada no streak
  let motivation = "";
  if (newStreak === 1) motivation = "\n\n💪 Primeiro dia! O começo de algo grande.";
  else if (newStreak === 7) motivation = "\n\n🔥 *1 semana seguida!* Incrivel!";
  else if (newStreak === 30) motivation = "\n\n🏆 *30 dias!* Voce e uma maquina!";
  else if (newStreak === 100) motivation = "\n\n👑 *100 DIAS!* Lendario!";
  else if (newStreak % 10 === 0) motivation = `\n\n🎯 *${newStreak} dias seguidos!* Impressionante!`;
  else if (newStreak >= 3) motivation = `\n\n🔥 ${newStreak} dias seguidos!`;

  const remaining = pending.length - 1;
  const remainingText = remaining > 0 ? `\n\n📋 Ainda ${remaining === 1 ? "falta 1 habito" : `faltam ${remaining} habitos`} hoje.` : "\n\n🎉 *Todos os habitos de hoje concluidos!*";

  return `✅ *${habit.icon} ${habit.name}* — registrado!${motivation}${remainingText}`;
}

// ─────────────────────────────────────────────
// RECURRING TRANSACTION HANDLER
// ─────────────────────────────────────────────

async function handleRecurringCreate(userId: string, message: string): Promise<string> {
  // Usa IA pra extrair dados da mensagem
  const prompt = `Extraia de uma frase em português os dados de uma transação financeira recorrente.
Retorne JSON puro (sem markdown): {"description":"nome curto","amount":número,"type":"expense"|"income","category":"alimentacao"|"transporte"|"moradia"|"saude"|"lazer"|"educacao"|"trabalho"|"outros","frequency":"daily"|"weekly"|"monthly"|"yearly","day_of_month":número|null}

Exemplos:
- "aluguel 1500 todo dia 5" → {"description":"Aluguel","amount":1500,"type":"expense","category":"moradia","frequency":"monthly","day_of_month":5}
- "salário 8000 todo mês" → {"description":"Salário","amount":8000,"type":"income","category":"trabalho","frequency":"monthly","day_of_month":1}
- "netflix 55.90 mensal" → {"description":"Netflix","amount":55.90,"type":"expense","category":"lazer","frequency":"monthly","day_of_month":null}

Frase: "${message}"`;

  const aiResponse = await chat([{ role: "user", content: prompt }], "Voce extrai dados de transacoes recorrentes. Responda APENAS com JSON valido.");
  let parsed: any;
  try {
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON");
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return "Não entendi. Exemplo: *aluguel 1500 todo dia 5* ou *Netflix 55 reais mensal*";
  }

  if (!parsed.amount || parsed.amount <= 0) {
    return "Não consegui identificar o valor. Exemplo: *aluguel 1500 todo dia 5*";
  }

  // Calcula próxima data
  const now = new Date();
  let nextDate: string;
  if (parsed.frequency === "monthly" && parsed.day_of_month) {
    const day = Math.min(parsed.day_of_month, 28);
    const month = now.getDate() > day ? now.getMonth() + 1 : now.getMonth();
    const next = new Date(now.getFullYear(), month, day);
    nextDate = next.toISOString().split("T")[0];
  } else if (parsed.frequency === "weekly") {
    const next = new Date(now);
    next.setDate(now.getDate() + (7 - now.getDay()) % 7 || 7);
    nextDate = next.toISOString().split("T")[0];
  } else if (parsed.frequency === "yearly") {
    const next = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
    nextDate = next.toISOString().split("T")[0];
  } else {
    // daily ou fallback
    const next = new Date(now);
    next.setDate(now.getDate() + 1);
    nextDate = next.toISOString().split("T")[0];
  }

  const { error } = await supabase.from("recurring_transactions").insert({
    user_id: userId,
    description: parsed.description || "Recorrente",
    amount: parsed.amount,
    type: parsed.type || "expense",
    category: parsed.category || "outros",
    frequency: parsed.frequency || "monthly",
    next_date: nextDate,
    active: true,
  });

  if (error) {
    console.error("Recurring create error:", error);
    return "⚠️ Erro ao criar transação recorrente. Tente novamente.";
  }

  const freqLabels: Record<string, string> = { daily: "diária", weekly: "semanal", monthly: "mensal", yearly: "anual" };
  const emoji = parsed.type === "income" ? "🟢" : "🔴";
  const typeLabel = parsed.type === "income" ? "Receita" : "Gasto";
  const nextFormatted = new Date(nextDate + "T12:00:00").toLocaleDateString("pt-BR", { day: "numeric", month: "long" });

  return `✅ *${typeLabel} recorrente criado!*\n\n${emoji} ${parsed.description}\n💰 R$ ${parsed.amount.toFixed(2).replace(".", ",")}\n🔁 Frequência: ${freqLabels[parsed.frequency] || parsed.frequency}\n📅 Próxima cobrança: ${nextFormatted}\n\nSerá registrado automaticamente. Gerencie no app Minha Maya.`;
}

// ─────────────────────────────────────────────
// BUDGET HANDLERS
// ─────────────────────────────────────────────

async function handleBudgetSet(userId: string, message: string): Promise<string> {
  const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Extrai valor
  const valueMatch = m.match(/(\d+[\.,]?\d*)\s*(reais|real|r\$|conto|pila)?/);
  if (!valueMatch) return "Não entendi o valor. Exemplo: *quero gastar no máximo 2000 em alimentação*";
  const amount = parseFloat(valueMatch[1].replace(",", "."));
  if (amount <= 0) return "O valor precisa ser positivo.";

  // Extrai categoria
  const catSynonyms: Record<string, string[]> = {
    alimentacao: ["alimentacao", "alimentação", "comida", "restaurante", "mercado", "alimento"],
    transporte: ["transporte", "gasolina", "uber", "onibus", "combustivel"],
    moradia: ["moradia", "aluguel", "casa", "condominio", "luz", "agua"],
    saude: ["saude", "saúde", "remedio", "farmacia", "medico", "hospital"],
    lazer: ["lazer", "diversao", "cinema", "bar", "viagem", "entretenimento"],
    educacao: ["educacao", "educação", "curso", "faculdade", "livro", "escola"],
    trabalho: ["trabalho", "escritorio", "material", "ferramenta"],
    outros: ["outros", "geral"],
  };
  let category = "outros";
  for (const [cat, synonyms] of Object.entries(catSynonyms)) {
    if (synonyms.some(s => m.includes(s))) { category = cat; break; }
  }

  // Upsert no banco
  const { error } = await supabase
    .from("budgets")
    .upsert({
      user_id: userId,
      category,
      amount_limit: amount,
      period: "monthly",
      alert_at_percent: 80,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,category,period" });

  if (error) {
    console.error("Budget set error:", error);
    return "⚠️ Erro ao salvar orçamento. Tente novamente.";
  }

  const catEmojis: Record<string, string> = {
    alimentacao: "🍔", transporte: "🚗", moradia: "🏠", saude: "💊",
    lazer: "🎮", educacao: "📚", trabalho: "💼", outros: "📦",
  };
  const emoji = catEmojis[category] ?? "📌";
  const catName = category.charAt(0).toUpperCase() + category.slice(1);

  return `✅ *Meta definida!*\n\n${emoji} *${catName}*: máximo *R$ ${amount.toFixed(2).replace(".", ",")}* por mês\n\nVou te avisar quando atingir 80% do limite.`;
}

async function handleBudgetQuery(userId: string, message: string): Promise<string> {
  const { data: budgets } = await supabase
    .from("budgets")
    .select("*")
    .eq("user_id", userId)
    .order("category");

  if (!budgets?.length) {
    return "📊 Você ainda não definiu nenhuma meta de gastos.\n\nExemplo: *quero gastar no máximo 2000 em alimentação*";
  }

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const catEmojis: Record<string, string> = {
    alimentacao: "🍔", transporte: "🚗", moradia: "🏠", saude: "💊",
    lazer: "🎮", educacao: "📚", trabalho: "💼", outros: "📦",
  };

  let report = "📊 *Seus orçamentos — este mês*\n";

  for (const b of budgets) {
    const { data: monthTx } = await supabase
      .from("transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "expense")
      .eq("category", b.category)
      .gte("transaction_date", monthStart);

    const spent = (monthTx ?? []).reduce((s: number, t: any) => s + Number(t.amount), 0);
    const limit = Number(b.amount_limit);
    const pct = limit > 0 ? (spent / limit) * 100 : 0;
    const remaining = limit - spent;
    const emoji = catEmojis[b.category] ?? "📌";
    const catName = b.category.charAt(0).toUpperCase() + b.category.slice(1);

    const bar = pct >= 100 ? "🔴" : pct >= 80 ? "🟡" : "🟢";
    report += `\n${emoji} *${catName}*: R$ ${spent.toFixed(2).replace(".", ",")} / R$ ${limit.toFixed(2).replace(".", ",")} ${bar}`;
    if (remaining > 0) {
      report += `\n   Resta: R$ ${remaining.toFixed(2).replace(".", ",")} (${pct.toFixed(0)}%)`;
    } else {
      report += `\n   Estourou: +R$ ${Math.abs(remaining).toFixed(2).replace(".", ",")}`;
    }
  }

  return report;
}

// ─────────────────────────────────────────────
// BUDGET ALERTS — Verifica orçamentos após registrar gasto
// ─────────────────────────────────────────────
async function checkBudgetAlerts(
  userId: string,
  phone: string,
  newTransactions: Array<{ amount: number; type: string; category: string }>
): Promise<void> {
  // Só verifica gastos (não receitas)
  const expenseCategories = [...new Set(newTransactions.filter(t => t.type === "expense").map(t => t.category))];
  if (expenseCategories.length === 0) return;

  // Busca budgets do usuário para as categorias afetadas
  const { data: budgets } = await supabase
    .from("budgets")
    .select("*")
    .eq("user_id", userId)
    .in("category", expenseCategories);

  if (!budgets?.length) return;

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const todayStr = now.toISOString().split("T")[0];

  for (const budget of budgets) {
    // Não enviar alerta repetido no mesmo dia
    if (budget.last_alert_date === todayStr) continue;

    // Total gasto no mês nessa categoria
    const { data: monthTx } = await supabase
      .from("transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "expense")
      .eq("category", budget.category)
      .gte("transaction_date", monthStart);

    const totalSpent = (monthTx ?? []).reduce((s: number, t: any) => s + Number(t.amount), 0);
    const limit = Number(budget.amount_limit);
    const pct = limit > 0 ? (totalSpent / limit) * 100 : 0;
    const alertThreshold = Number(budget.alert_at_percent) || 80;

    const catEmojis: Record<string, string> = {
      alimentacao: "🍔", transporte: "🚗", moradia: "🏠", saude: "💊",
      lazer: "🎮", educacao: "📚", trabalho: "💼", outros: "📦",
    };
    const emoji = catEmojis[budget.category] ?? "📌";
    const catName = budget.category.charAt(0).toUpperCase() + budget.category.slice(1);

    let alertMsg = "";
    if (pct >= 100) {
      const excess = totalSpent - limit;
      alertMsg = `🚨 *Orçamento estourado!*\n\n${emoji} *${catName}*: R$ ${totalSpent.toFixed(2).replace(".", ",")} de R$ ${limit.toFixed(2).replace(".", ",")}\n💸 Excedeu *R$ ${excess.toFixed(2).replace(".", ",")}*\n\nConsidere ajustar seus gastos ou a meta no app.`;
    } else if (pct >= alertThreshold) {
      const remaining = limit - totalSpent;
      alertMsg = `⚠️ *Atenção com o orçamento!*\n\n${emoji} *${catName}*: R$ ${totalSpent.toFixed(2).replace(".", ",")} de R$ ${limit.toFixed(2).replace(".", ",")} (*${pct.toFixed(0)}%*)\n💰 Resta *R$ ${remaining.toFixed(2).replace(".", ",")}* este mês.`;
    }

    if (alertMsg) {
      await sendText(phone, alertMsg);
      // Marca que já alertou hoje para não repetir
      await supabase
        .from("budgets")
        .update({ last_alert_date: todayStr })
        .eq("id", budget.id);
    }
  }
}

async function handleFinanceRecord(
  userId: string,
  phone: string,
  message: string,
  config: Record<string, unknown> | null
): Promise<string> {
  const transactions = await extractTransactions(message);

  if (!transactions.length) {
    return "Não consegui identificar os valores. Pode repetir? Ex: *gastei 200 reais de gasolina*";
  }

  // Usa data de Brasília para garantir que "hoje" na query bata com o registro
  const todayBRT = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

  const inserts = transactions.map((t) => ({
    user_id: userId,
    description: t.description,
    amount: t.amount,
    type: t.type,
    category: t.category,
    source: "whatsapp",
    transaction_date: todayBRT,
  }));

  const { error, data: insertedRows } = await supabase.from("transactions").insert(inserts).select("id, user_id, transaction_date");
  console.log(`[finance_record] userId=${userId} todayBRT=${todayBRT} inserted=${JSON.stringify(insertedRows)} error=${JSON.stringify(error)}`);
  if (error) throw error;

  // Sync Google Sheets (fire-and-forget, sem bloquear resposta)
  const today = new Date().toISOString().split("T")[0];
  for (const t of transactions) {
    syncGoogleSheets(userId, {
      date: today,
      description: t.description,
      amount: t.amount,
      type: t.type,
      category: t.category,
    }).catch(() => {}); // ignora erros de sync
  }

  // ── Verifica orçamentos e envia alertas proativos (fire-and-forget) ──
  checkBudgetAlerts(userId, phone, transactions).catch(err =>
    console.error("[budget-alert] Error:", err)
  );

  if (transactions.length === 1) {
    const t = transactions[0];
    const tpl = t.type === "expense"
      ? (config?.template_expense as string) ?? "🔴 *Gasto registrado{{name_tag}}!*\n📝 {{description}}\n💰 R$ {{amount}}"
      : (config?.template_income as string) ?? "🟢 *Receita registrada{{name_tag}}!*\n📝 {{description}}\n💰 R$ {{amount}}";
    const nick = (config?.user_nickname as string) || "";
    return applyTemplate(tpl, {
      description: t.description,
      amount: t.amount.toFixed(2).replace(".", ","),
      category: t.category,
      type: t.type,
      user_name: nick,
      name_tag: nick ? `, ${nick}` : "",
    });
  }

  const lines = transactions.map((t) => {
    const emoji = t.type === "expense" ? "🔴" : "🟢";
    return `${emoji} ${t.description}: *R$ ${t.amount.toFixed(2).replace(".", ",")}*`;
  });
  const total = transactions
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount, 0);

  const tplMulti = (config?.template_expense_multi as string)
    ?? "✅ *{{count}} gastos registrados{{name_tag}}!*\n\n{{lines}}\n\n💸 *Total: R$ {{total}}*";

  const nickMulti = (config?.user_nickname as string) || "";
  return applyTemplate(tplMulti, {
    count: String(transactions.length),
    lines: lines.join("\n"),
    total: total.toFixed(2).replace(".", ","),
    name_tag: nickMulti ? `, ${nickMulti}` : "",
  });
}

// Mapa de sinônimos para categorias
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  alimentacao: ["almoco", "almoço", "comida", "lanche", "janta", "jantar", "cafe", "café", "cafezinho", "restaurante", "mercado", "supermercado", "padaria", "pizza", "hamburguer", "acai", "açaí", "ifood", "delivery", "refeicao", "refeição", "marmita", "sushi", "churrasco", "snack"],
  transporte: ["gasolina", "combustivel", "combustível", "uber", "99", "taxi", "táxi", "onibus", "ônibus", "metro", "metrô", "estacionamento", "pedagio", "pedágio", "carro", "moto", "bicicleta", "patinete"],
  moradia: ["aluguel", "condominio", "condomínio", "luz", "energia", "agua", "água", "internet", "gas", "gás", "iptu", "reforma", "reparo", "faxina"],
  saude: ["remedio", "remédio", "farmacia", "farmácia", "medico", "médico", "consulta", "dentista", "academia", "gym", "plano de saude", "plano", "hospital", "exame"],
  lazer: ["cinema", "netflix", "spotify", "youtube", "jogo", "game", "viagem", "passeio", "show", "teatro", "festa", "bar", "balada", "streaming", "disney", "hbo"],
  educacao: ["escola", "faculdade", "curso", "livro", "material", "apostila", "udemy", "alura", "mensalidade"],
  trabalho: ["escritorio", "escritório", "ferramenta", "equipamento", "software", "assinatura"],
};

function detectCategory(m: string): string | null {
  // Normaliza e tokeniza pra evitar falsos positivos (ex: "moto" != "moradia")
  const normalized = m
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const tokens = normalized.split(/\s+/);

  for (const [cat, keywords] of Object.entries(CATEGORY_SYNONYMS)) {
    const normalizedKeywords = keywords.map((k) =>
      k.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    );
    // Multi-word keywords: substring match. Single-word: exact token match.
    const found = normalizedKeywords.some((k) =>
      k.includes(" ")
        ? normalized.includes(k)
        : tokens.includes(k)
    );
    if (found) return cat;
  }
  return null;
}

async function handleFinanceReport(
  userId: string,
  message: string,
  userTz = "America/Sao_Paulo"
): Promise<{ text: string; chartUrl: string | null }> {
  const m = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Detecta categoria específica na pergunta
  const filterCategory = detectCategory(m);

  // Determina período — sempre em BRT para bater com transaction_date salvo
  let startDate: string;
  let endDate: string | null = null;
  let periodLabel: string;
  const now = new Date();
  const nowBRT = now.toLocaleDateString("sv-SE", { timeZone: userTz }); // YYYY-MM-DD em BRT

  if (/hoje/.test(m)) {
    startDate = nowBRT;
    endDate = nowBRT;
    periodLabel = "hoje";
  } else if (/semana/.test(m)) {
    // Início da semana atual em BRT
    const startOfWeek = new Date(now);
    const dayOfWeek = parseInt(now.toLocaleDateString("en-US", { timeZone: userTz, weekday: "numeric" as any }), 10) || now.getDay();
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    startDate = startOfWeek.toLocaleDateString("sv-SE", { timeZone: userTz });
    periodLabel = "esta semana";
  } else if (/mes|mês/.test(m)) {
    const [year, month] = nowBRT.split("-");
    startDate = `${year}-${month}-01`;
    periodLabel = "este mês";
  } else {
    const [year, month] = nowBRT.split("-");
    startDate = `${year}-${month}-01`;
    periodLabel = "este mês";
  }

  let query = supabase
    .from("transactions")
    .select("*")
    .eq("user_id", userId)
    .gte("transaction_date", startDate)
    .order("transaction_date", { ascending: false });

  // Para "hoje" usa limite superior exato para evitar trazer datas futuras
  if (endDate) {
    query = query.lte("transaction_date", endDate);
  }

  if (filterCategory) {
    query = query.eq("category", filterCategory);
  }

  const { data: transactions, error } = await query;

  console.log(`[finance_report] userId=${userId} startDate=${startDate} endDate=${endDate} filterCat=${filterCategory} rows=${transactions?.length ?? "ERR"} error=${JSON.stringify(error)}`);

  if (error) throw error;

  // Se filtrou por categoria e não achou, mostra categorias que têm dados
  if (!transactions || transactions.length === 0) {
    if (filterCategory) {
      const { data: allTx } = await supabase
        .from("transactions")
        .select("category, amount")
        .eq("user_id", userId)
        .gte("transaction_date", startDate);

      const cats = [...new Set((allTx ?? []).map((t) => t.category))];
      const catEmojis: Record<string, string> = { alimentacao: "🍔", transporte: "🚗", moradia: "🏠", saude: "💊", lazer: "🎮", educacao: "📚", trabalho: "💼", outros: "📦" };

      if (cats.length === 0) {
        return { text: `📊 Nenhum gasto registrado para *${periodLabel}* ainda.`, chartUrl: null };
      }
      const catList = cats.map((c) => `${catEmojis[c] ?? "📌"} ${c}`).join(", ");
      return { text: `📊 Não encontrei gastos com *${filterCategory}* em *${periodLabel}*.\n\nCategorias que você tem registros: ${catList}`, chartUrl: null };
    }
    return { text: `📊 Nenhum registro encontrado para *${periodLabel}*.`, chartUrl: null };
  }

  // Relatório de categoria específica
  if (filterCategory) {
    const total = transactions.reduce((s, t) => s + Number(t.amount), 0);
    const catEmoji: Record<string, string> = { alimentacao: "🍔", transporte: "🚗", moradia: "🏠", saude: "💊", lazer: "🎮", educacao: "📚", trabalho: "💼", outros: "📦" };
    const emoji = catEmoji[filterCategory] ?? "📌";
    const lines = transactions.slice(0, 5).map((t) =>
      `• ${t.description}: *R$ ${Number(t.amount).toFixed(2).replace(".", ",")}*`
    );
    let r = `${emoji} *${filterCategory.charAt(0).toUpperCase() + filterCategory.slice(1)} — ${periodLabel}*\n\n`;
    r += lines.join("\n");
    if (transactions.length > 5) r += `\n_...e mais ${transactions.length - 5} registro(s)_`;
    r += `\n\n💸 *Total: R$ ${total.toFixed(2).replace(".", ",")}*`;
    return { text: r, chartUrl: null };
  }

  const expenses = transactions.filter((t) => t.type === "expense");
  const incomes = transactions.filter((t) => t.type === "income");

  const totalExpense = expenses.reduce((s, t) => s + Number(t.amount), 0);
  const totalIncome = incomes.reduce((s, t) => s + Number(t.amount), 0);

  // Agrupa por categoria
  const byCategory: Record<string, number> = {};
  for (const t of expenses) {
    byCategory[t.category] = (byCategory[t.category] ?? 0) + Number(t.amount);
  }

  const categoryEmojis: Record<string, string> = {
    alimentacao: "🍔",
    transporte: "🚗",
    moradia: "🏠",
    saude: "💊",
    lazer: "🎮",
    educacao: "📚",
    trabalho: "💼",
    outros: "📦",
  };

  const catLines = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([cat, val]) =>
        `${categoryEmojis[cat] ?? "📌"} ${cat}: *R$ ${val.toFixed(2).replace(".", ",")}*`
    )
    .join("\n");

  let report =
    `📊 *Relatório — ${periodLabel}*\n\n` +
    `🔴 Total de gastos: *R$ ${totalExpense.toFixed(2).replace(".", ",")}*\n`;

  if (totalIncome > 0) {
    report += `🟢 Total de receitas: *R$ ${totalIncome.toFixed(2).replace(".", ",")}*\n`;
    const balance = totalIncome - totalExpense;
    const balanceSign = balance >= 0 ? "+" : "";
    report += `💰 Saldo: *${balanceSign}R$ ${balance.toFixed(2).replace(".", ",")}*\n`;
  }

  if (catLines) {
    report += `\n📂 *Por categoria:*\n${catLines}`;
  }

  // Adiciona status de orçamentos (se houver)
  try {
    const { data: userBudgets } = await supabase
      .from("budgets")
      .select("category, amount_limit")
      .eq("user_id", userId);

    if (userBudgets?.length) {
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      let budgetLines = "";
      for (const b of userBudgets) {
        const spent = byCategory[b.category] ?? 0;
        if (spent <= 0) continue;
        const limit = Number(b.amount_limit);
        const pct = limit > 0 ? (spent / limit) * 100 : 0;
        const bar = pct >= 100 ? "🔴" : pct >= 80 ? "🟡" : "🟢";
        budgetLines += `\n${bar} ${b.category}: ${pct.toFixed(0)}% do limite`;
      }
      if (budgetLines) {
        report += `\n\n🎯 *Orçamentos:*${budgetLines}`;
      }
    }
  } catch { /* silently skip budget info */ }

  report += `\n\n📱 Ver detalhes completos no app Minha Maya`;

  // Gera URL do grafico doughnut (nao-bloqueante: se falhar, envia so texto)
  let chartUrl: string | null = null;
  try {
    chartUrl = await generateExpenseChartUrl({
      byCategory,
      periodLabel,
      totalExpense,
    });
  } catch (err) {
    console.error("Chart generation failed:", err);
  }

  return { text: report, chartUrl };
}

// Mapa de cores por tipo de evento
const EVENT_TYPE_COLORS: Record<string, string> = {
  compromisso: "#3b82f6",
  reuniao: "#8b5cf6",
  consulta: "#22c55e",
  evento: "#f97316",
  tarefa: "#14b8a6",
};

// Mapa de emojis por tipo de evento
const EVENT_TYPE_EMOJIS: Record<string, string> = {
  compromisso: "📌",
  reuniao: "🤝",
  consulta: "🏥",
  evento: "🎉",
  tarefa: "✏️",
};

// Detecta recorrência a partir de texto normalizado (sem acentos, lowercase)
// Retorna { recurrence, recurrence_value } ou null se não detectar
function detectRecurrenceFromText(
  normMsg: string,
  remindAt: Date
): { recurrence: string; recurrence_value: number | null } | null {
  if (/todo dia\b|todos os dias|diariamente|cada dia|sempre que|todo dia de/.test(normMsg))
    return { recurrence: "daily", recurrence_value: null };
  if (/toda segunda|toda segunda.feira/.test(normMsg)) return { recurrence: "weekly", recurrence_value: 1 };
  if (/toda terca|toda terca.feira/.test(normMsg)) return { recurrence: "weekly", recurrence_value: 2 };
  if (/toda quarta|toda quarta.feira/.test(normMsg)) return { recurrence: "weekly", recurrence_value: 3 };
  if (/toda quinta|toda quinta.feira/.test(normMsg)) return { recurrence: "weekly", recurrence_value: 4 };
  if (/toda sexta|toda sexta.feira/.test(normMsg)) return { recurrence: "weekly", recurrence_value: 5 };
  if (/todo sabado|todo fim de semana/.test(normMsg)) return { recurrence: "weekly", recurrence_value: 6 };
  if (/todo domingo/.test(normMsg)) return { recurrence: "weekly", recurrence_value: 0 };
  if (/toda semana|semanalmente|todas as semanas/.test(normMsg))
    return { recurrence: "weekly", recurrence_value: remindAt.getDay() };
  if (/todo mes|mensalmente|todos os meses/.test(normMsg)) {
    const dayMatch = normMsg.match(/dia (\d{1,2})/);
    if (dayMatch) return { recurrence: "day_of_month", recurrence_value: parseInt(dayMatch[1]) };
    return { recurrence: "monthly", recurrence_value: null };
  }
  const dayOfMonthMatch = normMsg.match(/todo dia (\d{1,2})\b/);
  if (dayOfMonthMatch) return { recurrence: "day_of_month", recurrence_value: parseInt(dayOfMonthMatch[1]) };
  // "a cada X horas" / "de X em X horas" / "todo X horas"
  const hourlyMatch = normMsg.match(/a cada (\d+)\s*hora|de (\d+) em \2\s*hora|todo (\d+)\s*hora|a cada hora\b/);
  if (hourlyMatch) {
    const hours = parseInt(hourlyMatch[1] ?? hourlyMatch[2] ?? hourlyMatch[3] ?? "1");
    return { recurrence: "hourly", recurrence_value: isNaN(hours) ? 1 : hours };
  }
  return null;
}

// isReminderDecline, isReminderAtTime, isReminderAccept, parseMinutes imported from ../_shared/classify.ts

// Converte "HH:MM" em minutos totais desde meia-noite
function timeToMinutes(time: string): number {
  const parts = time.slice(0, 5).split(":");
  return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
}

// Verifica se há conflito de horário com eventos existentes
async function checkTimeConflict(
  userId: string,
  date: string,
  time: string,
  endTime: string | null | undefined
): Promise<{ title: string; event_time: string } | null> {
  const { data: existing } = await supabase
    .from("events")
    .select("id, title, event_time, end_time, event_type")
    .eq("user_id", userId)
    .eq("event_date", date)
    .eq("status", "pending")
    .not("event_time", "is", null);

  if (!existing || existing.length === 0) return null;

  const newStart = timeToMinutes(time);
  // Assume 60 min de duração se end_time não fornecido
  const newEnd = endTime ? timeToMinutes(endTime) : newStart + 60;

  for (const ev of existing) {
    const evStart = timeToMinutes(ev.event_time.slice(0, 5));
    const evEnd = ev.end_time ? timeToMinutes(ev.end_time.slice(0, 5)) : evStart + 60;

    // Verificação de sobreposição: start1 < end2 AND start2 < end1
    if (newStart < evEnd && evStart < newEnd) {
      return { title: ev.title, event_time: ev.event_time.slice(0, 5) };
    }
  }

  return null;
}

// Detecta se o usuário quer um evento recorrente ("todo dia", "toda segunda", etc.)
function detectEventRecurrence(msg: string): { type: string; weekday?: number } | null {
  const m = msg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/todo(s)?\s*(os)?\s*dia(s)?|diariamente|todo\s+dia/.test(m)) return { type: "daily" };
  const weekdayMap: Record<string, number> = {
    domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
  };
  for (const [day, num] of Object.entries(weekdayMap)) {
    if (new RegExp(`toda(s)?\\s*(as)?\\s*${day}`).test(m)) return { type: "weekly", weekday: num };
  }
  if (/toda\s+semana|semanalmente/.test(m)) return { type: "weekly" };
  if (/todo\s+mes|mensalmente/.test(m)) return { type: "monthly" };
  return null;
}

// Gera as datas de ocorrência futuras para um evento recorrente
function generateRecurrenceDates(startDate: string, type: string, weekday?: number, count = 1): string[] {
  const dates: string[] = [];
  const start = new Date(startDate + "T12:00:00");

  if (type === "daily") {
    for (let i = 1; i <= 29; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      dates.push(d.toISOString().split("T")[0]);
    }
  } else if (type === "weekly") {
    const targetDay = weekday ?? start.getDay();
    let d = new Date(start);
    d.setDate(start.getDate() + 7);
    for (let i = 0; i < 7; i++) {
      // Ensure correct weekday
      while (d.getDay() !== targetDay) d.setDate(d.getDate() + 1);
      dates.push(d.toISOString().split("T")[0]);
      d = new Date(d);
      d.setDate(d.getDate() + 7);
    }
  } else if (type === "monthly") {
    for (let i = 1; i <= 3; i++) {
      const d = new Date(start);
      d.setMonth(start.getMonth() + i);
      dates.push(d.toISOString().split("T")[0]);
    }
  }
  return dates;
}

async function handleAgendaCreate(
  userId: string,
  phone: string,
  message: string,
  session: Record<string, unknown> | null,
  language = "pt-BR",
  userNickname: string | null = null,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  const today = todayInTz(userTz);

  // Recupera contexto pendente de follow-up
  const context = (session?.pending_context as Record<string, unknown>) ?? {};
  const partial = (context.partial as Record<string, unknown>) ?? {};
  const step = (context.step as string) ?? null;

  // ─── STEP: waiting_reminder_answer ───
  // Usuário está respondendo à oferta de lembrete
  if (step === "waiting_reminder_answer") {
    const recurrenceFromCtx = context._recurrence ? { type: context._recurrence as string, weekday: context._recurrence_weekday as number | undefined } : undefined;
    const msgLowRem = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

    // Mapeamento de button IDs para minutos (agenda)
    const agendaButtonMap: Record<string, number | null> = {
      "button:advance_15min": 15,
      "button:advance_30min": 30,
      "button:advance_1h":    60,
      "button:advance_confirm_no": 0,   // "Só na hora"
      "1": 15, "2": 30, "3": 60,        // fallback para texto numerado (Baileys)
    };
    if (agendaButtonMap[msgLowRem] !== undefined) {
      const mins = agendaButtonMap[msgLowRem];
      const finalDataBtn = { ...partial, reminder_minutes: mins } as unknown as ExtractedEvent;
      return await createEventAndConfirm(userId, phone, finalDataBtn, recurrenceFromCtx, language, userNickname, userTz);
    }
    if (msgLowRem === "button:advance_confirm_yes" || msgLowRem === "1" || isReminderAccept(message)) {
      // Aceitou — envia botões de tempo
      sendButtons(
        phone,
        "Com quanto tempo antes? ⏱️",
        `Lembrete para: "${(partial as Record<string,unknown>).title ?? "evento"}"`,
        [
          { id: "advance_15min", text: "15 minutos" },
          { id: "advance_30min", text: "30 minutos" },
          { id: "advance_1h",    text: "1 hora" },
        ]
      ).catch(() => {});
      return {
        response: "",
        pendingAction: "agenda_create",
        pendingContext: { partial, step: "waiting_reminder_minutes" },
      };
    }
    // "só na hora" ou "não precisa"
    if (isReminderAtTime(message)) {
      const finalData = { ...partial, reminder_minutes: 0 } as unknown as ExtractedEvent;
      return await createEventAndConfirm(userId, phone, finalData, recurrenceFromCtx, language, userNickname, userTz);
    }
    if (isReminderDecline(message)) {
      const finalData = { ...partial, reminder_minutes: null } as unknown as ExtractedEvent;
      return await createEventAndConfirm(userId, phone, finalData, recurrenceFromCtx, language, userNickname, userTz);
    }
    // Já veio com tempo especificado (ex: "30 minutos antes", "2 horas antes")
    const minutesInAnswer = parseMinutes(message);
    if (minutesInAnswer !== null && message.match(/\d|hora|minuto|meia/)) {
      const finalData = { ...partial, reminder_minutes: minutesInAnswer } as unknown as ExtractedEvent;
      return await createEventAndConfirm(userId, phone, finalData, recurrenceFromCtx, language, userNickname, userTz);
    }
    // Resposta ambígua — reenvia botões
    sendButtons(
      phone,
      "Quer que eu te lembre antes? ⏱️",
      `Evento: "${(partial as Record<string,unknown>).title ?? "evento"}"`,
      [
        { id: "advance_confirm_yes", text: "⏰ Sim, me avisa" },
        { id: "advance_confirm_no",  text: "✅ Só na hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "agenda_create",
      pendingContext: { partial, step: "waiting_reminder_answer" },
    };
  }

  // ─── STEP: waiting_reminder_minutes ───
  // Usuário está informando com quanto tempo de antecedência quer o lembrete
  if (step === "waiting_reminder_minutes") {
    const msgLowMin = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const buttonMinMap: Record<string, number> = {
      "button:advance_15min": 15,
      "button:advance_30min": 30,
      "button:advance_1h":    60,
      "button:advance_2h":    120,
      "1": 15, "2": 30, "3": 60,   // fallback para texto numerado (Baileys)
    };
    const btnMin = buttonMinMap[msgLowMin];
    if (btnMin !== undefined) {
      const recurrenceFromCtxMin2 = context._recurrence ? { type: context._recurrence as string, weekday: context._recurrence_weekday as number | undefined } : undefined;
      const finalDataBtn2 = { ...partial, reminder_minutes: btnMin } as unknown as ExtractedEvent;
      return await createEventAndConfirm(userId, phone, finalDataBtn2, recurrenceFromCtxMin2, language, userNickname, userTz);
    }
    const minutes = parseMinutes(message);
    if (minutes !== null) {
      const recurrenceFromCtxMin = context._recurrence ? { type: context._recurrence as string, weekday: context._recurrence_weekday as number | undefined } : undefined;
      const finalData = { ...partial, reminder_minutes: minutes } as unknown as ExtractedEvent;
      return await createEventAndConfirm(userId, phone, finalData, recurrenceFromCtxMin, language, userNickname, userTz);
    }
    // Não entendeu — reenvia botões
    sendButtons(
      phone,
      "Com quanto tempo antes? ⏱️",
      `Lembrete para: "${(partial as Record<string,unknown>).title ?? "evento"}"`,
      [
        { id: "advance_15min", text: "15 minutos" },
        { id: "advance_30min", text: "30 minutos" },
        { id: "advance_1h",    text: "1 hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "agenda_create",
      pendingContext: { partial, step: "waiting_reminder_minutes" },
    };
  }

  // ─── STEP: waiting_title ───
  // Usuário está fornecendo o título do evento
  if (step === "waiting_title") {
    const titleProvided = message.trim();
    if (!titleProvided || titleProvided.length < 2) {
      return {
        response: "Preciso de um nome para o evento. Ex: _Reunião com João_, _Dentista_, _Academia_",
        pendingAction: "agenda_create",
        pendingContext: { partial, step: "waiting_title" },
      };
    }
    // Injeta o título no partial e prossegue com a criação
    const recurrenceFromCtxTitle = context._recurrence
      ? { type: context._recurrence as string, weekday: context._recurrence_weekday as number | undefined }
      : undefined;
    const dataWithTitle = { ...partial, title: titleProvided } as unknown as ExtractedEvent;
    // Se ainda falta horário, pede
    if (!dataWithTitle.time) {
      return {
        response: `Certo! *${titleProvided}* — qual o horário? ⏰\n_Ex: 14h, 14:30, às 15h_`,
        pendingAction: "agenda_create",
        pendingContext: {
          partial: dataWithTitle,
          step: "waiting_time",
          _recurrence: recurrenceFromCtxTitle?.type,
          _recurrence_weekday: recurrenceFromCtxTitle?.weekday,
        },
      };
    }
    // Verifica conflito antes de criar
    const conflict = await checkTimeConflict(userId, dataWithTitle.date, dataWithTitle.time, dataWithTitle.end_time);
    if (conflict) {
      return {
        response: `⚠️ *Conflito de horário!*\nVocê já tem *${conflict.title}* às ${conflict.event_time}.\n\nO que prefere?\n1️⃣ Marcar assim mesmo\n2️⃣ Mudar o horário\n3️⃣ Cancelar`,
        pendingAction: "agenda_create",
        pendingContext: { partial: dataWithTitle, step: "conflict_resolution" },
      };
    }
    return await createEventAndConfirm(userId, phone, dataWithTitle, recurrenceFromCtxTitle, language, userNickname, userTz);
  }

  // ─── STEP: conflict_resolution ───
  // Usuário está resolvendo um conflito de horário
  if (step === "conflict_resolution") {
    const savedPartial = context.partial as ExtractedEvent;
    const m = message
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

    // Opção 1: Marcar assim mesmo
    if (/^1$|marcar assim|deixa assim|pode marcar|cria assim|manter|sim|claro|pode/.test(m)) {
      // Se ainda precisa perguntar sobre lembrete
      if (context.reminder_pending) {
        sendButtons(
          phone,
          "Quer que eu te lembre antes? ⏱️",
          `Evento: "${(savedPartial as Record<string,unknown>).title ?? "evento"}"`,
          [
            { id: "advance_confirm_yes", text: "⏰ Sim, me avisa antes" },
            { id: "advance_confirm_no",  text: "✅ Só na hora" },
          ]
        ).catch(() => {});
        return {
          response: "",
          pendingAction: "agenda_create",
          pendingContext: { partial: savedPartial, step: "waiting_reminder_answer" },
        };
      }
      return await createEventAndConfirm(userId, phone, savedPartial, undefined, language, userNickname, userTz);
    }

    // Opção 2: Mudar horário
    if (/^2$|mudar|trocar|outro hor|alterar hor|novo hor|muda|troca/.test(m)) {
      return {
        response: "Qual o novo horário? ⏰\n_Ex: 15:00 ou 15h30_",
        pendingAction: "agenda_create",
        pendingContext: {
          partial: { ...savedPartial, time: undefined, end_time: undefined },
          step: "waiting_time",
          reminder_pending: context.reminder_pending,
        },
      };
    }

    // Opção 3: Cancelar
    if (/^3$|^nao$|^não$|^cancelar?$|^desist|^nao quero/.test(m)) {
      return { response: "Ok! Evento não criado. Se quiser agendar outro horário, é só me dizer. 👍" };
    }

    // Usuário digitou um horário diretamente
    const timeMatch = message.match(/(\d{1,2})[h:](\d{0,2})/);
    if (timeMatch) {
      const hh = timeMatch[1].padStart(2, "0");
      const mm = (timeMatch[2] || "00").padStart(2, "0");
      const newTime = `${hh}:${mm}`;
      const newData = { ...savedPartial, time: newTime, end_time: undefined } as ExtractedEvent;

      // Verifica conflito para o novo horário também
      const conflict = await checkTimeConflict(userId, newData.date, newTime, null);
      if (conflict) {
        return {
          response: `⚠️ Esse horário também conflita com *${conflict.title}* às ${conflict.event_time}.\n\nQuer:\n1️⃣ Marcar assim mesmo\n2️⃣ Tentar outro horário\n3️⃣ Cancelar`,
          pendingAction: "agenda_create",
          pendingContext: { partial: newData, step: "conflict_resolution", reminder_pending: context.reminder_pending },
        };
      }

      if (context.reminder_pending) {
        sendButtons(
          phone,
          "Horário atualizado! Quer que eu te lembre? ⏱️",
          `Evento: "${(newData as Record<string,unknown>).title ?? "evento"}"`,
          [
            { id: "advance_confirm_yes", text: "⏰ Sim, me avisa antes" },
            { id: "advance_confirm_no",  text: "✅ Só na hora" },
          ]
        ).catch(() => {});
        return {
          response: "",
          pendingAction: "agenda_create",
          pendingContext: { partial: newData, step: "waiting_reminder_answer" },
        };
      }
      return await createEventAndConfirm(userId, phone, newData, undefined, language, userNickname, userTz);
    }

    // Resposta ambígua
    return {
      response: "Por favor escolha:\n1️⃣ Marcar assim mesmo\n2️⃣ Mudar o horário\n3️⃣ Cancelar",
      pendingAction: "agenda_create",
      pendingContext: { ...context },
    };
  }

  // ─── EXTRAÇÃO PRINCIPAL (step null ou waiting_time) ───
  // Detecta recorrência da mensagem original (apenas no step inicial)
  const recurrence = step === null ? detectEventRecurrence(message) : (
    context._recurrence ? { type: context._recurrence as string, weekday: context._recurrence_weekday as number | undefined } : null
  );

  // Combina contexto parcial com nova mensagem para a IA
  let combinedMessage: string;
  if (Object.keys(partial).length > 0) {
    combinedMessage = `Dados parciais já extraídos: ${JSON.stringify(partial)}\nResposta do usuário: ${message}`;
  } else {
    combinedMessage = message;
  }

  let extracted: Awaited<ReturnType<typeof extractEvent>>;
  try {
    extracted = await extractEvent(combinedMessage, today, language);
  } catch (err) {
    console.error("extractEvent failed:", err);
    return {
      response: "Não consegui entender o evento. Pode repetir com mais detalhes?\n\nEx: _Reunião amanhã às 15h_ ou _Médico dia 10 às 9h_",
    };
  }

  // Se a IA pede clarificação de título ou horário → continua o fluxo
  if (extracted.needs_clarification && extracted.clarification_type === "title") {
    return {
      response: extracted.needs_clarification,
      pendingAction: "agenda_create",
      pendingContext: { partial: extracted, step: "waiting_title" },
    };
  }

  if (extracted.needs_clarification && extracted.clarification_type === "time") {
    return {
      response: extracted.needs_clarification,
      pendingAction: "agenda_create",
      pendingContext: { partial: extracted, step: "waiting_time" },
    };
  }

  // ─── Verificação de conflito de horário ───
  if (extracted.date && extracted.time && step !== "conflict_resolution") {
    const conflict = await checkTimeConflict(userId, extracted.date, extracted.time, extracted.end_time);
    if (conflict) {
      const reminderPending = !extracted.needs_clarification
        ? false
        : extracted.clarification_type === "reminder_offer";
      return {
        response: `⚠️ *Conflito de horário!*\nVocê já tem *${conflict.title}* às ${conflict.event_time}.\n\nO que prefere?\n1️⃣ Marcar assim mesmo\n2️⃣ Mudar o horário\n3️⃣ Cancelar`,
        pendingAction: "agenda_create",
        pendingContext: { partial: extracted, step: "conflict_resolution", reminder_pending: reminderPending },
      };
    }
  }

  // Se a IA oferece lembrete (horário já existe, lembrete não discutido)
  if (extracted.needs_clarification && extracted.clarification_type === "reminder_offer") {
    sendButtons(
      phone,
      "Quer que eu te lembre antes? ⏱️",
      `Evento: "${extracted.title ?? "evento"}"`,
      [
        { id: "advance_confirm_yes", text: "⏰ Sim, me avisa antes" },
        { id: "advance_confirm_no",  text: "✅ Só na hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "agenda_create",
      pendingContext: { partial: extracted, step: "waiting_reminder_answer", _recurrence: recurrence?.type, _recurrence_weekday: recurrence?.weekday },
    };
  }

  // Se a IA pede quantidade de minutos para lembrete
  if (extracted.needs_clarification && extracted.clarification_type === "reminder_minutes") {
    return {
      response: extracted.needs_clarification,
      pendingAction: "agenda_create",
      pendingContext: { partial: extracted, step: "waiting_reminder_minutes", _recurrence: recurrence?.type, _recurrence_weekday: recurrence?.weekday },
    };
  }

  // Tudo preenchido — criar evento
  return await createEventAndConfirm(userId, phone, extracted, recurrence ?? undefined, language, userNickname, userTz);
}

/** Cria o evento no banco e retorna a confirmação formatada */
async function createEventAndConfirm(
  userId: string,
  phone: string,
  extracted: ExtractedEvent,
  recurrence?: { type: string; weekday?: number },
  lang = "pt-BR",
  userNickname: string | null = null,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string }> {
  const tzOffset = getTzOffset(userTz);
  const color = EVENT_TYPE_COLORS[extracted.event_type] ?? "#3b82f6";
  const emoji = EVENT_TYPE_EMOJIS[extracted.event_type] ?? "📌";

  const eventData: Record<string, unknown> = {
    user_id: userId,
    title: extracted.title,
    event_date: extracted.date,
    event_time: extracted.time,
    end_time: extracted.end_time ?? null,
    location: extracted.location ?? null,
    event_type: extracted.event_type ?? "compromisso",
    priority: extracted.priority ?? "media",
    color,
    source: "whatsapp",
    status: "pending",
  };

  if (extracted.reminder_minutes != null) {
    eventData.reminder = true;
    eventData.reminder_minutes_before = extracted.reminder_minutes;
  }

  const { data: event, error } = await supabase
    .from("events")
    .insert(eventData)
    .select()
    .single();

  if (error) throw error;

  // Sync Google Calendar (fire-and-forget)
  syncGoogleCalendar(userId, extracted.title, extracted.date, extracted.time).catch(() => {});

  // Cria lembrete se solicitado (reminder_minutes >= 0 significa lembrete ativo)
  if (extracted.reminder_minutes != null && extracted.time) {
    // Interpreta o horário no fuso do usuário usando offset dinâmico
    const timeStr = extracted.time.length === 5 ? extracted.time : extracted.time.slice(0, 5);
    const eventDateTime = new Date(`${extracted.date}T${timeStr}:00${tzOffset}`);
    const reminderTime = new Date(
      eventDateTime.getTime() - extracted.reminder_minutes * 60 * 1000
    );

    const reminderMsgPt = extracted.reminder_minutes === 0
      ? `⏰ *Hora do seu compromisso!*\n${emoji} *${extracted.title}* está marcado agora às ${extracted.time}`
      : `⏰ *Lembrete!*\nEm ${extracted.reminder_minutes} min você tem: *${extracted.title}* às ${extracted.time}`;
    const reminderMsgEn = extracted.reminder_minutes === 0
      ? `⏰ *It's time!*\n${emoji} *${extracted.title}* is now at ${fmtTimeLang(extracted.time!, lang)}`
      : `⏰ *Reminder!*\nIn ${extracted.reminder_minutes} min you have: *${extracted.title}* at ${fmtTimeLang(extracted.time!, lang)}`;
    const reminderMsgEs = extracted.reminder_minutes === 0
      ? `⏰ *¡Es la hora!*\n${emoji} *${extracted.title}* está programado ahora a las ${fmtTimeLang(extracted.time!, lang)}`
      : `⏰ *¡Recordatorio!*\nEn ${extracted.reminder_minutes} min tienes: *${extracted.title}* a las ${fmtTimeLang(extracted.time!, lang)}`;
    const reminderMsg = lang === "en" ? reminderMsgEn : lang === "es" ? reminderMsgEs : reminderMsgPt;

    if (reminderTime > new Date()) {
      await supabase.from("reminders").insert({
        user_id: userId,
        event_id: event.id,
        whatsapp_number: phone,
        title: extracted.title,
        message: reminderMsg,
        send_at: reminderTime.toISOString(),
        recurrence: "none",
        source: "whatsapp",
        status: "pending",
      });
    }
  }

  // ─── Cria ocorrências futuras se evento for recorrente ───
  const RECURRENCE_LABELS_EVENT: Record<string, string> = {
    daily: "todo dia",
    weekly: "toda semana",
    monthly: "todo mês",
  };
  if (recurrence) {
    const futureDates = generateRecurrenceDates(extracted.date, recurrence.type, recurrence.weekday);
    const futureInserts = futureDates.map(d => ({
      user_id: userId,
      title: extracted.title,
      event_date: d,
      event_time: extracted.time ?? null,
      end_time: extracted.end_time ?? null,
      location: extracted.location ?? null,
      event_type: extracted.event_type ?? "compromisso",
      priority: extracted.priority ?? "media",
      color,
      source: "whatsapp",
      status: "pending",
      reminder: extracted.reminder_minutes != null,
      reminder_minutes_before: extracted.reminder_minutes ?? null,
      recurrence_parent_id: event.id,
    }));
    if (futureInserts.length > 0) {
      await supabase.from("events").insert(futureInserts);
    }
  }

  // ─── Cria lembrete pós-evento (followup) para eventos que precisam de confirmação ───
  const FOLLOWUP_TYPES = ["consulta", "reuniao", "compromisso"];
  const eventType = extracted.event_type ?? "compromisso";
  if (FOLLOWUP_TYPES.includes(eventType) && extracted.time && !recurrence) {
    const timeStr = extracted.time.length === 5 ? extracted.time : extracted.time.slice(0, 5);
    const eventDateTime = new Date(`${extracted.date}T${timeStr}:00${tzOffset}`);
    const followupTime = new Date(eventDateTime.getTime() + 15 * 60 * 1000); // 15 min após o evento

    if (followupTime > new Date()) {
      const followupMessages: Record<string, string> = {
        consulta: `🏥 Sua *${extracted.title}* era agora! Conseguiu ir?\n\nResponda:\n✅ *sim* — marco como feito\n🔄 *adiar* — reagendo pra outro dia`,
        reuniao: `🤝 *${extracted.title}* era agora! A reunião aconteceu?\n\nResponda:\n✅ *aconteceu* — marco como concluída\n🔄 *adiar* — vamos reagendar`,
        compromisso: `📌 *${extracted.title}* era agora! Deu certo?\n\nResponda:\n✅ *feito* — marco como concluído\n🔄 *adiar* — me diz o novo horário`,
      };
      const followupMsg = followupMessages[eventType] ?? followupMessages.compromisso;

      await supabase.from("reminders").insert({
        user_id: userId,
        event_id: event.id,
        whatsapp_number: phone,
        title: extracted.title,
        message: followupMsg,
        send_at: followupTime.toISOString(),
        recurrence: "none",
        source: "event_followup",
        status: "pending",
      });
    }
  }

  const dateFormatted = fmtDateLong(extracted.date, lang);
  const nameGreet = userNickname ? `, ${userNickname}` : "";

  let response = `✅ *Agendado${nameGreet}!*\n${emoji} ${extracted.title}\n🗓 ${dateFormatted}`;
  if (extracted.time) response += `\n⏰ ${extracted.time}`;
  if (extracted.end_time) response += ` - ${extracted.end_time}`;
  if (extracted.location) response += `\n📍 ${extracted.location}`;
  if (extracted.reminder_minutes === 0) {
    response += `\n🔔 Te aviso na hora do evento`;
  } else if (extracted.reminder_minutes != null && extracted.reminder_minutes > 0) {
    const mins = extracted.reminder_minutes;
    const reminderLabel = mins >= 60
      ? `${mins / 60 === Math.floor(mins / 60) ? mins / 60 + " hora" + (mins / 60 > 1 ? "s" : "") : mins + " min"}`
      : `${mins} min`;
    response += `\n🔔 Te lembro ${reminderLabel} antes`;
  }

  if (recurrence) {
    const recLabel = recurrence.type === "weekly" && recurrence.weekday != null
      ? `toda ${["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"][recurrence.weekday]}`
      : RECURRENCE_LABELS_EVENT[recurrence.type] ?? recurrence.type;
    response += `\n🔁 *Recorrente:* ${recLabel}`;
  }

  return { response };
}

// ─────────────────────────────────────────────
// AGENDA LOOKUP — encontra um evento específico
// ─────────────────────────────────────────────

async function handleAgendaLookup(
  userId: string,
  message: string,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  const today = todayInTz(userTz);

  // Extrai palavra-chave usando padrões contextuais (meu X, do X, sobre X, etc.)
  const msgNorm = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  let keyword = "";

  // Tenta padrão contextual primeiro: "meu/minha/do/da/o/a/sobre X"
  const contextMatch = msgNorm.match(
    /(meu|minha|do|da|de|o|a|sobre)\s+([a-z\s]{2,30}?)(?:\s+dia|\s+no|\s+na|\s*\?|$)/i
  );
  if (contextMatch) {
    keyword = contextMatch[2].trim();
  }

  // Fallback: remove stopwords e usa o primeiro token longo restante
  if (!keyword) {
    keyword = msgNorm
      .replace(/voce lembra|lembra|do|da|de|meu|minha|tem|qual|e|quando|marcado|agendado|dia|no|para|sobre|esta|esse|essa/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((w) => w.length > 2)[0] ?? "";
  }

  // Tenta extrair um intervalo de datas da mensagem (ignora fallback de 7 dias genérico)
  let startDate: string | null = null;
  let endDate: string | null = null;
  try {
    const parsed = await parseAgendaQuery(message, today);
    // Só usa o intervalo se parecer uma data específica (start diferente de hoje)
    if (parsed.start_date && parsed.end_date && parsed.start_date !== today) {
      startDate = parsed.start_date;
      endDate = parsed.end_date;
    }
  } catch {
    // ignora — fará busca só por keyword
  }

  // Monta query combinando keyword + datas; exclui apenas cancelados
  let query = supabase
    .from("events")
    .select("*")
    .eq("user_id", userId)
    .neq("status", "cancelled")
    .order("event_date", { ascending: true })
    .limit(3);

  if (keyword && startDate && endDate) {
    query = query.or(
      `title.ilike.%${keyword}%,and(event_date.gte.${startDate},event_date.lte.${endDate})`
    );
  } else if (keyword) {
    query = query.ilike("title", `%${keyword}%`);
  } else if (startDate && endDate) {
    query = query.gte("event_date", startDate).lte("event_date", endDate);
  }

  const { data: events, error } = await query;
  if (error) throw error;

  if (!events || events.length === 0) {
    return {
      response: "Não encontrei nenhum compromisso com esse nome. 🔍 Quer ver sua agenda completa?",
    };
  }

  if (events.length === 1) {
    const e = events[0];
    const dateStr = new Date(e.event_date + "T12:00:00").toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const dateFormatted = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    const typeEmoji = EVENT_TYPE_EMOJIS[e.event_type] ?? "📌";
    const statusLabel = e.status === "done" ? " ✅ *Concluído*" : "";

    let response = `${typeEmoji} *${e.title}*${statusLabel}\n🗓 ${dateFormatted}`;
    if (e.event_time) response += `\n⏰ ${e.event_time.slice(0, 5)}`;
    if (e.end_time) response += ` - ${e.end_time.slice(0, 5)}`;
    if (e.location) response += `\n📍 ${e.location}`;

    // Verifica se há lembrete real pendente na tabela reminders
    if (e.reminder && e.reminder_minutes_before != null) {
      const reminderLabel = e.reminder_minutes_before === 0
        ? "na hora do evento"
        : `${e.reminder_minutes_before} min antes`;

      const { data: activeReminder } = await supabase
        .from("reminders")
        .select("status, send_at")
        .eq("event_id", e.id)
        .eq("user_id", userId)
        .eq("status", "pending")
        .maybeSingle();

      if (activeReminder) {
        response += `\n🔔 Lembrete: ${reminderLabel} _(ativo)_`;
      } else {
        response += `\n🔔 Lembrete: ${reminderLabel} _(já disparado ou removido)_`;
      }
    }

    if (e.status !== "done") {
      response += `\n\nQuer fazer alguma alteração? Pode me dizer a nova data, horário, ou "cancela" se quiser excluir.`;
    }

    return {
      response,
      pendingAction: e.status !== "done" ? "agenda_edit" : undefined,
      pendingContext: e.status !== "done" ? {
        event_id: e.id,
        event_title: e.title,
        event_date: e.event_date,
        event_time: e.event_time ?? null,
        reminder_minutes: e.reminder_minutes_before ?? null,
        step: "awaiting_change",
      } : undefined,
    };
  }

  // Múltiplos eventos — lista e pede confirmação
  const lines = events.map((e, i) => {
    const dateStr = new Date(e.event_date + "T12:00:00").toLocaleDateString("pt-BR", {
      day: "numeric",
      month: "short",
    });
    const time = e.event_time ? ` às ${e.event_time.slice(0, 5)}` : "";
    const doneTag = e.status === "done" ? " ✅" : "";
    return `${i + 1}. *${e.title}*${doneTag} — ${dateStr}${time}`;
  });

  return {
    response: `Encontrei ${events.length} compromissos:\n\n${lines.join("\n")}\n\nQual deles você quer ver ou editar?`,
  };
}

// ─────────────────────────────────────────────
// APPLY EVENT UPDATE — aplica alterações no BD
// ─────────────────────────────────────────────

async function applyEventUpdate(
  userId: string,
  phone: string,
  eventId: string,
  updates: { event_date?: string; event_time?: string; end_time?: string },
  reminderMinutes: number | null | undefined,
  originalData: {
    title: string;
    event_date: string;
    event_time: string | null;
    reminder_minutes: number | null;
  },
  userTz = "America/Sao_Paulo"
): Promise<string> {
  // 1. Atualiza o evento
  const { error: updateErr } = await supabase
    .from("events")
    .update(updates)
    .eq("id", eventId)
    .eq("user_id", userId);

  if (updateErr) throw updateErr;

  // 2. Cancela lembretes pendentes se reminderMinutes foi explicitamente informado
  if (reminderMinutes !== undefined) {
    await supabase
      .from("reminders")
      .update({ status: "cancelled" })
      .eq("event_id", eventId)
      .eq("status", "pending");
  }

  // 3. Cria novo lembrete se solicitado
  if (reminderMinutes != null && reminderMinutes >= 0) {
    const finalDate = updates.event_date ?? originalData.event_date;
    const finalTime = updates.event_time ?? originalData.event_time;

    if (finalTime) {
      // Interpreta o horário no fuso do usuário
      const finalTimeStr = finalTime.length >= 5 ? finalTime.slice(0, 5) : finalTime;
      const tzOffsetEdit = getTzOffset(userTz);
      const eventDt = new Date(`${finalDate}T${finalTimeStr}:00${tzOffsetEdit}`);
      const remindDt = new Date(eventDt.getTime() - reminderMinutes * 60 * 1000);

      if (remindDt > new Date()) {
        const reminderMsg = reminderMinutes === 0
          ? `⏰ *Hora do seu compromisso!*\n📌 *${originalData.title}* está marcado agora às ${finalTime.slice(0, 5)}`
          : `⏰ *Lembrete!*\nEm ${reminderMinutes} min você tem: *${originalData.title}* às ${finalTime.slice(0, 5)}`;

        await supabase.from("reminders").insert({
          user_id: userId,
          event_id: eventId,
          whatsapp_number: phone,
          title: originalData.title,
          message: reminderMsg,
          send_at: remindDt.toISOString(),
          recurrence: "none",
          source: "whatsapp",
          status: "pending",
        });
      }
    }
  }

  // 4. Sync Google Calendar (fire-and-forget)
  const gcalDate = updates.event_date ?? originalData.event_date;
  const gcalTime = updates.event_time ?? originalData.event_time;
  syncGoogleCalendar(userId, originalData.title, gcalDate, gcalTime ?? null).catch(() => {});

  // 5. Formata confirmação
  const dateStr = new Date(gcalDate + "T12:00:00").toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const dateFormatted = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

  let response = `✅ *Compromisso atualizado!*\n📌 ${originalData.title}\n🗓 ${dateFormatted}`;
  if (gcalTime) response += `\n⏰ ${gcalTime.slice(0, 5)}`;
  if (reminderMinutes === 0) {
    response += `\n🔔 Te aviso na hora do evento`;
  } else if (reminderMinutes != null && reminderMinutes > 0) {
    const label = reminderMinutes >= 60
      ? `${reminderMinutes / 60 === Math.floor(reminderMinutes / 60) ? reminderMinutes / 60 + " hora" + (reminderMinutes / 60 > 1 ? "s" : "") : reminderMinutes + " min"}`
      : `${reminderMinutes} min`;
    response += `\n🔔 Te lembro ${label} antes`;
  }

  return response;
}

// ─────────────────────────────────────────────
// AGENDA EDIT — edita evento via conversa
// ─────────────────────────────────────────────

async function handleAgendaEdit(
  userId: string,
  phone: string,
  message: string,
  session: Record<string, unknown> | null,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  const today = todayInTz(userTz);
  const ctx = (session?.pending_context as Record<string, unknown>) ?? {};
  const step = (ctx.step as string) ?? "awaiting_change";

  // ─── STEP: waiting_time ───
  if (step === "waiting_time") {
    const timeMatch = message.match(/(\d{1,2})[h:](\d{0,2})/);
    let newTime: string | null = null;
    if (timeMatch) {
      const hh = timeMatch[1].padStart(2, "0");
      const mm = (timeMatch[2] || "00").padStart(2, "0");
      newTime = `${hh}:${mm}`;
    } else {
      return {
        response: "Não entendi o horário. Pode me dizer no formato *14:00* ou *14h30*? 🕐",
        pendingAction: "agenda_edit",
        pendingContext: ctx,
      };
    }

    return await offerReminderAfterEdit(userId, phone, {
      ...(ctx as Record<string, unknown>),
      pending_new_time: newTime,
    }, userTz);
  }

  // ─── STEP: waiting_reminder_answer (followup/edit) ───
  if (step === "waiting_reminder_answer") {
    const msgLowFU = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const fuBtnMap: Record<string, number | null> = {
      "button:advance_15min": 15, "button:advance_30min": 30,
      "button:advance_1h": 60,   "button:advance_confirm_no": 0,
      "1": 15, "2": 30, "3": 60,  // fallback para texto numerado (Baileys)
    };
    if (fuBtnMap[msgLowFU] !== undefined) {
      return await finalizeEdit(userId, phone, ctx, fuBtnMap[msgLowFU], userTz);
    }
    if (msgLowFU === "button:advance_confirm_yes" || msgLowFU === "1" || isReminderAccept(message)) {
      sendButtons(
        phone,
        "Com quanto tempo antes? ⏱️",
        `Evento: "${(ctx as Record<string,unknown>).event_title ?? "evento"}"`,
        [
          { id: "advance_15min", text: "15 minutos" },
          { id: "advance_30min", text: "30 minutos" },
          { id: "advance_1h",    text: "1 hora" },
        ]
      ).catch(() => {});
      return {
        response: "",
        pendingAction: "agenda_edit",
        pendingContext: { ...ctx, step: "waiting_reminder_minutes" },
      };
    }
    if (isReminderAtTime(message)) {
      return await finalizeEdit(userId, phone, ctx, 0, userTz);
    }
    if (isReminderDecline(message)) {
      return await finalizeEdit(userId, phone, ctx, null, userTz);
    }
    const minutesInAnswer = parseMinutes(message);
    if (minutesInAnswer !== null && message.match(/\d|hora|minuto|meia/)) {
      return await finalizeEdit(userId, phone, ctx, minutesInAnswer, userTz);
    }
    // Reenvia botões
    sendButtons(
      phone,
      "Quer que eu te lembre antes? ⏱️",
      `Evento: "${(ctx as Record<string,unknown>).event_title ?? "evento"}"`,
      [
        { id: "advance_confirm_yes", text: "⏰ Sim, me avisa antes" },
        { id: "advance_confirm_no",  text: "✅ Só na hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "agenda_edit",
      pendingContext: { ...ctx, step: "waiting_reminder_answer" },
    };
  }

  // ─── STEP: waiting_reminder_minutes (followup/edit) ───
  if (step === "waiting_reminder_minutes") {
    const msgLowMinFU = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const fuMinMap: Record<string, number> = {
      "button:advance_15min": 15, "button:advance_30min": 30,
      "button:advance_1h": 60,   "button:advance_2h": 120,
      "1": 15, "2": 30, "3": 60,  // fallback para texto numerado (Baileys)
    };
    const btnMinFU = fuMinMap[msgLowMinFU];
    if (btnMinFU !== undefined) return await finalizeEdit(userId, phone, ctx, btnMinFU, userTz);
    const minutes = parseMinutes(message);
    if (minutes !== null) {
      return await finalizeEdit(userId, phone, ctx, minutes, userTz);
    }
    sendButtons(
      phone,
      "Com quanto tempo antes? ⏱️",
      `Evento: "${(ctx as Record<string,unknown>).event_title ?? "evento"}"`,
      [
        { id: "advance_15min", text: "15 minutos" },
        { id: "advance_30min", text: "30 minutos" },
        { id: "advance_1h",    text: "1 hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "agenda_edit",
      pendingContext: { ...ctx, step: "waiting_reminder_minutes" },
    };
  }

  // ─── STEP: awaiting_change (ou direto sem sessão anterior) ───

  // Se não há event_id na sessão, tenta encontrar evento pelo texto
  if (!ctx.event_id) {
    const keyword = message
      .toLowerCase()
      .replace(/mudei|muda|mude|alterei|altera|altere|remarca|remarcar|atualiza|cancela|cancelar|excluir|deletar|mover|dia|hora|horario|data|evento|compromisso|reuniao|consulta|para|pro|pra|o|a/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((w) => w.length > 2)[0] ?? "";

    if (keyword) {
      const { data: found } = await supabase
        .from("events")
        .select("id, title, event_date, event_time, reminder_minutes_before")
        .eq("user_id", userId)
        .eq("status", "pending")
        .ilike("title", `%${keyword}%`)
        .order("event_date", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!found) {
        return {
          response: `Não encontrei nenhum compromisso com "${keyword}". 🔍\n\nComo está o nome do compromisso que você quer editar?`,
        };
      }
      // Encontrou — usa como contexto e continua para extração de edição
      ctx.event_id = found.id;
      ctx.event_title = found.title;
      ctx.event_date = found.event_date;
      ctx.event_time = found.event_time ?? null;
      ctx.reminder_minutes = found.reminder_minutes_before ?? null;
    } else {
      return {
        response: "Qual compromisso você quer editar? 📅",
      };
    }
  }

  // Extrai o que mudou
  let edit: Awaited<ReturnType<typeof extractAgendaEdit>>;
  try {
    edit = await extractAgendaEdit(message, today);
  } catch (err) {
    console.error("extractAgendaEdit failed:", err);
    return {
      response: "Não entendi o que alterar. Pode repetir?\n\nEx: _muda para dia 15 às 10h_ ou _cancela esse evento_",
    };
  }

  // Cancelamento
  if (edit.cancel) {
    const { error } = await supabase
      .from("events")
      .update({ status: "cancelled" })
      .eq("id", ctx.event_id as string)
      .eq("user_id", userId);
    if (error) throw error;

    // Cancela lembretes pendentes
    await supabase
      .from("reminders")
      .update({ status: "cancelled" })
      .eq("event_id", ctx.event_id as string)
      .eq("status", "pending");

    return { response: `🗑️ Compromisso *${ctx.event_title}* cancelado. ✅` };
  }

  // Nada identificado
  if (edit.fields_changed.length === 0 && !edit.needs_clarification) {
    return {
      response: "Não entendi o que você quer mudar. Pode me dizer a nova data, novo horário, ou \"cancela\"? 📝",
      pendingAction: "agenda_edit",
      pendingContext: { ...ctx, step: "awaiting_change" },
    };
  }

  // Precisa de esclarecimento (ex: deu data mas não horário e evento tinha horário)
  const hasOriginalTime = !!(ctx.event_time as string | null);
  if (edit.new_date && !edit.new_time && hasOriginalTime && edit.needs_clarification) {
    return {
      response: edit.needs_clarification,
      pendingAction: "agenda_edit",
      pendingContext: {
        ...ctx,
        pending_new_date: edit.new_date,
        step: "waiting_time",
      },
    };
  }

  // Tem tudo para aplicar — oferece lembrete antes
  return await offerReminderAfterEdit(userId, phone, {
    ...ctx,
    pending_new_date: edit.new_date ?? ctx.event_date,
    pending_new_time: edit.new_time ?? ctx.event_time,
  }, userTz);
}

/** Depois de coletar data/hora novos, oferece atualização de lembrete */
async function offerReminderAfterEdit(
  userId: string,
  phone: string,
  ctx: Record<string, unknown>,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  // Se o evento tinha lembrete, pergunta se quer manter/alterar
  const hadReminder = (ctx.reminder_minutes as number | null) != null;
  if (hadReminder) {
    sendButtons(
      phone,
      "Quer atualizar o lembrete? ⏱️",
      `Evento: "${(ctx as Record<string,unknown>).event_title ?? "evento"}"`,
      [
        { id: "advance_confirm_yes", text: "⏰ Sim, me avisa antes" },
        { id: "advance_confirm_no",  text: "✅ Só na hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "agenda_edit",
      pendingContext: { ...ctx, step: "waiting_reminder_answer" },
    };
  }

  // Sem lembrete anterior — aplica direto sem perguntar
  return await finalizeEdit(userId, phone, ctx, undefined, userTz);
}

/** Aplica as alterações acumuladas e retorna a mensagem de confirmação */
async function finalizeEdit(
  userId: string,
  phone: string,
  ctx: Record<string, unknown>,
  reminderMinutes: number | null | undefined,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string }> {
  const updates: { event_date?: string; event_time?: string } = {};
  if (ctx.pending_new_date && ctx.pending_new_date !== ctx.event_date) {
    updates.event_date = ctx.pending_new_date as string;
  }
  if (ctx.pending_new_time !== undefined && ctx.pending_new_time !== ctx.event_time) {
    updates.event_time = (ctx.pending_new_time as string | null) ?? undefined;
  }

  const response = await applyEventUpdate(
    userId,
    phone,
    ctx.event_id as string,
    updates,
    reminderMinutes,
    {
      title: ctx.event_title as string,
      event_date: ctx.event_date as string,
      event_time: (ctx.event_time as string | null) ?? null,
      reminder_minutes: (ctx.reminder_minutes as number | null) ?? null,
    },
    userTz
  );

  return { response };
}

// ─────────────────────────────────────────────
// AGENDA DELETE — cancela/exclui evento direto
// ─────────────────────────────────────────────

async function handleAgendaDelete(
  userId: string,
  message: string
): Promise<string> {
  // Extrai palavra-chave do pedido de exclusão
  const msgNorm = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Remove verbos de exclusão e artigos para isolar o nome do evento
  const keyword = msgNorm
    .replace(/cancela|exclui|apaga|deleta|remove|desmarca|nao vou mais|vou mais|o evento|a reuniao|o compromisso|a consulta|meu|minha|o\b|a\b|ao\b|para o|para a/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 3)
    .join(" ");

  if (!keyword) {
    return "Qual compromisso você quer cancelar? Me diga o nome.";
  }

  // Busca o evento por keyword (somente pending — não faz sentido cancelar done)
  const { data: found, error } = await supabase
    .from("events")
    .select("id, title")
    .eq("user_id", userId)
    .eq("status", "pending")
    .ilike("title", `%${keyword}%`)
    .order("event_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  if (!found) {
    return `Não encontrei nenhum compromisso pendente com "${keyword}". Qual você quer cancelar?`;
  }

  // Cancela o evento
  const { error: updateErr } = await supabase
    .from("events")
    .update({ status: "cancelled" })
    .eq("id", found.id)
    .eq("user_id", userId);

  if (updateErr) throw updateErr;

  // Cancela lembretes pendentes associados
  await supabase
    .from("reminders")
    .update({ status: "cancelled" })
    .eq("event_id", found.id)
    .eq("status", "pending");

  return `✅ *${found.title}* cancelado e removido da sua agenda.`;
}

async function handleAgendaQuery(userId: string, message: string, userTz = "America/Sao_Paulo"): Promise<string> {
  const today = todayInTz(userTz);

  // Usa IA para interpretar o período desejado
  let startDate: string;
  let endDate: string;
  let periodDescription: string;

  try {
    const parsed = await parseAgendaQuery(message, today);
    startDate = parsed.start_date;
    endDate = parsed.end_date;
    periodDescription = parsed.description;
  } catch {
    // Fallback: próximos 7 dias
    startDate = today;
    endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    periodDescription = "próximos 7 dias";
  }

  const { data: events, error } = await supabase
    .from("events")
    .select("*")
    .eq("user_id", userId)
    .gte("event_date", startDate)
    .lte("event_date", endDate)
    .neq("status", "cancelled")
    .order("event_date", { ascending: true })
    .order("event_time", { ascending: true });

  if (error) throw error;

  if (!events || events.length === 0) {
    return `📅 Nenhum compromisso para *${periodDescription}*!`;
  }

  // Agrupa eventos por data
  const grouped: Record<string, typeof events> = {};
  for (const e of events) {
    const dateKey = e.event_date;
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(e);
  }

  const sections: string[] = [];

  for (const [dateKey, dayEvents] of Object.entries(grouped)) {
    const dateStr = new Date(dateKey + "T12:00:00").toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

    // Capitaliza primeira letra do dia da semana
    const dateHeader = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    const lines: string[] = [`📆 *${dateHeader}*`];

    for (const e of dayEvents) {
      const typeEmoji = EVENT_TYPE_EMOJIS[e.event_type] ?? "📌";
      const time = e.event_time ? `${e.event_time.slice(0, 5)}` : "Sem horário";
      const endTime = e.end_time ? ` - ${e.end_time.slice(0, 5)}` : "";
      const location = e.location ? `\n   📍 ${e.location}` : "";
      const reminder = e.reminder ? " 🔔" : "";
      const statusLabel = e.status === "done" ? " ✅" : "";
      lines.push(`  ${typeEmoji} *${e.title}*${statusLabel}\n   🕐 ${time}${endTime}${reminder}${location}`);
    }

    sections.push(lines.join("\n"));
  }

  const doneCount = events.filter((e) => e.status === "done").length;
  const totalCount = events.length;
  const countLabel = totalCount === 1 ? "1 compromisso" : `${totalCount} compromissos`;
  const doneNote = doneCount > 0 ? ` _(${doneCount} concluído${doneCount > 1 ? "s" : ""} ✅)_` : "";

  return `📅 *Sua agenda — ${periodDescription}*\n_(${countLabel})_${doneNote}\n\n${sections.join("\n\n")}`;
}

// ─────────────────────────────────────────────
// SMART NOTE PROCESSING — classifica e limpa com IA
// ─────────────────────────────────────────────

interface NoteAnalysis {
  cleanContent: string;
  suggestedTitle: string;
  looksLikeEvent: boolean;
  needsMoreInfo: boolean;
  moreInfoQuestion: string | null;
}

async function analyzeNoteContent(rawMessage: string): Promise<NoteAnalysis> {
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
  const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-4-5-20251001";

  const prompt = `Analise esta mensagem de WhatsApp enviada para uma assistente pessoal: "${rawMessage}"

Responda SOMENTE com JSON válido (sem texto extra):
{
  "cleanContent": "conteúdo limpo sem verbos como 'anota'/'salva'/'registra' e sem 'pra mim que'/'que'/'isso'. Corrija capitalização.",
  "suggestedTitle": "título curto e objetivo (máx 50 chars)",
  "looksLikeEvent": true ou false (contém médico/dentista/reunião/consulta + data ou horário específico?),
  "needsMoreInfo": true ou false (é consulta médica/dentista onde perguntar especialidade ou local seria útil?),
  "moreInfoQuestion": "pergunta natural para obter especialidade/local/mais detalhes se needsMoreInfo=true, caso contrário null"
}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 250,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text ?? "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {
    // fallback
  }

  // Fallback: limpeza básica por regex
  const cleanContent = rawMessage
    .replace(/^(anota|anotacao|anote|salva|escreve|registra|guarda|cria (uma )?nota)[\s:,]+(pra mim que|pra mim|que\s+)?/i, "")
    .replace(/^(preciso lembrar|lembrar de)[\s:,]+/i, "")
    .replace(/^(pra mim que|pra mim|que)\s+/i, "")
    .trim();

  return {
    cleanContent: cleanContent || rawMessage,
    suggestedTitle: cleanContent.slice(0, 50),
    looksLikeEvent: false,
    needsMoreInfo: false,
    moreInfoQuestion: null,
  };
}

async function handleNotesSave(
  userId: string,
  phone: string,
  message: string,
  session: Record<string, unknown> | null,
  config: Record<string, unknown> | null = null,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  const userNickname = (config?.user_nickname as string) || "";
  const noteLang = (config?.language as string) || "pt-BR";
  const tplNote = (config?.template_note as string) || '📝 *Anotado, {{user_name}}!*\n"{{content}}"';
  const buildNoteResponse = (content: string): string => {
    const noteLine = applyTemplate(tplNote, { content, user_name: userNickname });
    return `${noteLine}\n\nQuer que eu te lembre sobre isso mais tarde? ⏰\n_Diga o horário ou "não precisa"_`;
  };
  const ctx = (session?.pending_context as Record<string, unknown>) ?? {};
  const step = (ctx.step as string) ?? null;

  // ─── STEP: note_or_reminder_choice ───
  // Usuário respondendo "anotações" ou "lembrete" à pergunta de disambiguação
  if (step === "note_or_reminder_choice") {
    const m2 = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const cleanContent = ctx.cleanContent as string;
    const suggestedTitle = ctx.suggestedTitle as string;

    const wantsReminder =
      /^2$|^lembrete|^lembrar|^avisa|^aviso|^lembre|^quero lembrete|^criar lembrete/.test(m2) ||
      m2 === "button:note_reminder";

    if (wantsReminder) {
      // Guarda o conteúdo e pede o horário
      return {
        response: `⏰ *Certo!* Em qual momento você quer ser lembrado sobre:\n_"${cleanContent}"_?\n\n_Ex: amanhã às 14h, sexta às 10h, daqui 2 horas_`,
        pendingAction: "notes_save",
        pendingContext: {
          step: "note_reminder_time_pending",
          cleanContent,
          suggestedTitle,
        },
      };
    }

    // Escolheu anotações (ou qualquer outra resposta = padrão)
    const { error: noteErr } = await supabase.from("notes").insert({
      user_id: userId,
      title: suggestedTitle || null,
      content: cleanContent,
      source: "whatsapp",
    });
    if (noteErr) throw noteErr;
    syncNotion(userId, cleanContent).catch(() => {});

    return {
      response: buildNoteResponse(cleanContent),
      pendingAction: "notes_save",
      pendingContext: { step: "note_reminder_offer", noteTitle: suggestedTitle || cleanContent.slice(0, 40) },
    };
  }

  // ─── STEP: note_reminder_time_pending ───
  // Usuário escolheu "lembrete" e está informando o horário
  if (step === "note_reminder_time_pending") {
    const cleanContent = ctx.cleanContent as string;
    const suggestedTitle = ctx.suggestedTitle as string;
    const tzOff2 = getTzOffset(userTz);
    const nowIso2 = new Date().toLocaleString("sv-SE", { timeZone: userTz }).replace(" ", "T") + tzOff2;
    const parsed2 = await parseReminderIntent(message, nowIso2, noteLang);

    if (!parsed2) {
      return {
        response: `Não entendi o horário. Pode repetir?\n\n_Ex: amanhã às 14h, sexta às 10h, daqui 2 horas_`,
        pendingAction: "notes_save",
        pendingContext: ctx,
      };
    }

    const remindAt2 = new Date(parsed2.remind_at);
    if (isNaN(remindAt2.getTime()) || remindAt2 <= new Date()) {
      return {
        response: `Esse horário já passou ou não entendi. Tente novamente:\n\n_Ex: amanhã às 14h, próxima sexta às 9h_`,
        pendingAction: "notes_save",
        pendingContext: ctx,
      };
    }

    const { data: profileRow2 } = await supabase.from("profiles").select("phone_number").eq("id", userId).maybeSingle();
    const reminderPhone = phone || profileRow2?.phone_number || "";

    await supabase.from("reminders").insert({
      user_id: userId,
      whatsapp_number: reminderPhone,
      title: suggestedTitle || cleanContent.slice(0, 60),
      message: `🔔 *Lembrete!*\n📋 ${suggestedTitle || cleanContent.slice(0, 60)}`,
      send_at: remindAt2.toISOString(),
      recurrence: "none",
      source: "whatsapp",
      status: "pending",
    });

    const timeStr2 = remindAt2.toLocaleTimeString("pt-BR", { timeZone: userTz, hour: "2-digit", minute: "2-digit" });
    const dateStr2 = remindAt2.toLocaleDateString("pt-BR", { timeZone: userTz, weekday: "long", day: "numeric", month: "long" });
    const greetName = userNickname ? `, ${userNickname}` : "";

    return {
      response: `⏰ *Lembrete criado${greetName}!*\nVou te avisar sobre _"${suggestedTitle || cleanContent.slice(0, 60)}"_ em ${dateStr2} às ${timeStr2}. ✅`,
    };
  }

  // ─── STEP: note_or_event_choice ───
  if (step === "note_or_event_choice") {
    const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const cleanContent = ctx.cleanContent as string;
    const suggestedTitle = ctx.suggestedTitle as string;
    const needsMoreInfo = ctx.needsMoreInfo as boolean;
    const moreInfoQuestion = ctx.moreInfoQuestion as string | null;
    const originalMessage = ctx.originalMessage as string;

    // Cancelar
    if (m === "button:note_cancel" || /^(cancelar?|nao|nope|desistir|esquece)$/.test(m)) {
      return { response: "Ok, descartado! Qualquer coisa é só me chamar. 😊" };
    }

    // Usuário quer colocar na agenda
    if (/^1$|^agenda$|^agendar|^marcar|^compromisso|^sim$|^quero agenda/.test(m) || m === "button:note_agenda") {
      if (needsMoreInfo && moreInfoQuestion) {
        return {
          response: moreInfoQuestion,
          pendingAction: "notes_save",
          pendingContext: { ...ctx, step: "agenda_more_info" },
        };
      }
      // Redireciona para criação de evento com a mensagem original
      return await handleAgendaCreate(userId, phone, originalMessage, null, noteLang, userNickname || null, userTz);
    }

    // Usuário quer salvar como nota (opção 2, ou qualquer outra resposta = fallback)
    // Salva a nota com conteúdo limpo
    const { error } = await supabase.from("notes").insert({
      user_id: userId,
      title: suggestedTitle || null,
      content: cleanContent,
      source: "whatsapp",
    });
    if (error) throw error;
    syncNotion(userId, cleanContent).catch(() => {});

    return {
      response: buildNoteResponse(cleanContent),
      pendingAction: "notes_save",
      pendingContext: { step: "note_reminder_offer", noteTitle: suggestedTitle || cleanContent.slice(0, 40) },
    };
  }

  // ─── STEP: agenda_more_info ───
  if (step === "agenda_more_info") {
    // Combina detalhes extras com a mensagem original e cria evento
    const originalMessage = ctx.originalMessage as string;
    const combinedMessage = `${originalMessage} — ${message}`;
    return await handleAgendaCreate(userId, phone, combinedMessage, null, noteLang, userNickname || null, userTz);
  }

  // ─── STEP: note_extra_info ───
  // Usuário respondeu à pergunta de mais detalhes (especialidade, local, etc.)
  if (step === "note_extra_info") {
    const noteTitle = ctx.noteTitle as string;
    const cleanContent = ctx.cleanContent as string;
    const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

    // Se recusou dar mais info → vai direto para oferecer lembrete
    if (/^(nao|não|n|dispenso|nao precisa|ta bom|tudo bem|sem detalhes|pula|pular)$/.test(m)) {
      return {
        response: `Ok! Nota salva como: _"${cleanContent}"_\n\nQuer que eu te lembre sobre isso mais tarde? ⏰\n_Diga o horário ou "não precisa"_`,
        pendingAction: "notes_save",
        pendingContext: { step: "note_reminder_offer", noteTitle },
      };
    }

    // Enriquece o título com a info extra
    const enrichedTitle = `${noteTitle} — ${message.trim()}`;

    // Atualiza a nota mais recente do usuário (a que acabou de ser salva)
    const { data: lastNote } = await supabase
      .from("notes")
      .select("id")
      .eq("user_id", userId)
      .eq("source", "whatsapp")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastNote?.id) {
      await supabase.from("notes")
        .update({ title: enrichedTitle.slice(0, 100) })
        .eq("id", lastNote.id);
    }

    return {
      response: `Perfeito! Anotei: _"${enrichedTitle}"_ 📝\n\nQuer que eu te lembre sobre isso mais tarde? ⏰\n_Diga o horário ou "não precisa"_`,
      pendingAction: "notes_save",
      pendingContext: { step: "note_reminder_offer", noteTitle: enrichedTitle.slice(0, 60) },
    };
  }

  // ─── STEP: note_reminder_offer ───
  if (step === "note_reminder_offer") {
    const noteTitle = ctx.noteTitle as string;
    const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

    if (isReminderDecline(m) || /^(nao|não|n|dispenso|nao precisa|ta bom|tudo bem)$/.test(m)) {
      return {
        response: `Ok! A anotação está salva. 📝\nQuando precisar é só pedir: _"busca minha anotação sobre ${noteTitle}"_ 🔍`,
      };
    }

    // Tenta extrair horário diretamente da resposta
    const noteTzOff = getTzOffset(userTz);
    const nowIso = new Date().toLocaleString("sv-SE", { timeZone: userTz }).replace(" ", "T") + noteTzOff;
    const parsed = await parseReminderIntent(message, nowIso);
    if (parsed) {
      const remindAt = new Date(parsed.remind_at);
      if (!isNaN(remindAt.getTime()) && remindAt > new Date()) {
        const { data: profileRow } = await supabase.from("profiles").select("phone_number").eq("id", userId).maybeSingle();
        const whatsappPhone = phone || profileRow?.phone_number || "";
        await supabase.from("reminders").insert({
          user_id: userId,
          whatsapp_number: whatsappPhone,
          title: noteTitle,
          message: `⏰ *Lembrete!*\n📝 ${noteTitle}`,
          send_at: remindAt.toISOString(),
          recurrence: "none",
          source: "whatsapp",
          status: "pending",
        });
        const timeStr = remindAt.toLocaleTimeString("pt-BR", { timeZone: userTz, hour: "2-digit", minute: "2-digit" });
        const dateStr = remindAt.toLocaleDateString("pt-BR", { timeZone: userTz, weekday: "long", day: "numeric", month: "long" });
        const noteNameGreet = userNickname ? `, ${userNickname}` : "";
        return { response: `⏰ *Lembrete criado${noteNameGreet}!*\nVou te avisar sobre _"${noteTitle}"_ em ${dateStr} às ${timeStr}. ✅` };
      }
    }

    // Usuário disse sim mas sem horário — pede quando
    if (isReminderAccept(m)) {
      return {
        response: `Quando você quer ser lembrado? 📅\n\n_Ex: amanhã às 10h, sexta às 15h, daqui 2 horas_`,
        pendingAction: "notes_save",
        pendingContext: { step: "note_reminder_offer", noteTitle },
      };
    }

    // Não entendeu — segue sem lembrete
    return {
      response: `Ok, nota salva! Quando quiser ser lembrado é só dizer: _"me lembra de ${noteTitle} às Xh"_ 📝`,
    };
  }

  // ─── FLUXO PRINCIPAL ───
  // Analisa e classifica a nota com IA
  const analysis = await analyzeNoteContent(message);

  // Detecta se a mensagem tem referência de tempo (indica lembrete)
  const hasTimeRef = /\b(amanha|amanhã|hoje|às \d|as \d|dia \d|\d+h\b|\d+ horas|proxim[ao]|semana|mes|daqui \d|em \d+ (min|hora|dia)|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/i.test(message);

  // Se não tem referência de tempo e não parece evento → pergunta notas ou lembrete
  if (!hasTimeRef && !analysis.looksLikeEvent) {
    const pendingCtx = {
      step: "note_or_reminder_choice",
      cleanContent: analysis.cleanContent,
      suggestedTitle: analysis.suggestedTitle,
      originalMessage: message,
    };
    // Envia botões interativos (fire-and-forget; resposta vazia para não duplicar sendText)
    sendButtons(
      phone,
      "Salvar como...",
      `"${analysis.cleanContent.slice(0, 80)}"`,
      [
        { id: "note_note",     text: "📝 Anotação" },
        { id: "note_reminder", text: "🔔 Lembrete" },
        { id: "note_cancel",   text: "❌ Cancelar" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "notes_save",
      pendingContext: pendingCtx,
    };
  }

  // Se parece um evento → pergunta o que fazer
  if (analysis.looksLikeEvent) {
    const pendingCtxEvent = {
      step: "note_or_event_choice",
      cleanContent: analysis.cleanContent,
      suggestedTitle: analysis.suggestedTitle,
      needsMoreInfo: analysis.needsMoreInfo,
      moreInfoQuestion: analysis.moreInfoQuestion,
      originalMessage: message,
    };
    sendButtons(
      phone,
      "Isso parece um compromisso! 📅",
      `"${analysis.suggestedTitle || analysis.cleanContent.slice(0, 60)}"`,
      [
        { id: "note_agenda",  text: "📅 Adicionar à agenda" },
        { id: "note_note",    text: "📝 Salvar como nota" },
        { id: "note_cancel",  text: "❌ Cancelar" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "notes_save",
      pendingContext: pendingCtxEvent,
    };
  }

  // Se precisa de mais info mas é nota mesmo → salva e pergunta detalhes
  const { error } = await supabase.from("notes").insert({
    user_id: userId,
    title: analysis.suggestedTitle || null,
    content: analysis.cleanContent,
    source: "whatsapp",
  });
  if (error) throw error;
  syncNotion(userId, analysis.cleanContent).catch(() => {});

  // Pergunta se quer lembrete (usando template personalizado do usuário)
  let responseText = buildNoteResponse(analysis.cleanContent);

  // Se tem mais info a perguntar, adiciona após confirmar lembrete
  if (analysis.needsMoreInfo && analysis.moreInfoQuestion) {
    const noteLine = applyTemplate(tplNote, { content: analysis.cleanContent, user_name: userNickname });
    responseText = `${noteLine}\n\n${analysis.moreInfoQuestion}\n\n_Ou diga "não precisa" para pular_`;
    // Vai aguardar resposta de mais info e depois oferecer lembrete
    return {
      response: responseText,
      pendingAction: "notes_save",
      pendingContext: {
        step: "note_extra_info",
        noteId: null, // already saved
        noteTitle: analysis.suggestedTitle || analysis.cleanContent.slice(0, 40),
        cleanContent: analysis.cleanContent,
      },
    };
  }

  return {
    response: responseText,
    pendingAction: "notes_save",
    pendingContext: {
      step: "note_reminder_offer",
      noteTitle: analysis.suggestedTitle || analysis.cleanContent.slice(0, 40),
    },
  };
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ── Validação de origem: Evolution API envia seu apikey no header ────────
  const incomingKey = req.headers.get("apikey") ?? "";
  const evolutionKey = Deno.env.get("EVOLUTION_API_KEY") ?? "";
  if (evolutionKey && incomingKey && incomingKey !== evolutionKey) {
    console.warn("[webhook] Rejected request with invalid apikey header");
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Apenas mensagens recebidas (não enviadas pelo bot)
  const event = body.event as string;
  if (event !== "messages.upsert") {
    return new Response("OK");
  }

  // Suporta data como objeto ou array (diferentes versões do Evolution API)
  const rawData = body.data;
  const data = (Array.isArray(rawData) ? rawData[0] : rawData) as Record<string, unknown>;
  const key = data?.key as Record<string, unknown>;

  if (key?.fromMe) {
    return new Response("OK");
  }

  // ── Deduplicação atômica ─────────────────────────────────────────────────
  // Usa INSERT com PRIMARY KEY para garantir que apenas UMA invocação processa
  // o mesmo messageId, mesmo que o Evolution/Baileys dispare o webhook 2x
  // simultaneamente (race condition que o antigo SELECT+UPSERT não cobria).
  const messageId = key?.id as string;
  if (messageId) {
    const { error: dedupErr } = await (supabase as any)
      .from("processed_messages")
      .insert({ message_id: messageId });

    if (dedupErr) {
      // Código 23505 = unique_violation → mensagem já foi processada
      if (dedupErr.code === "23505") {
        console.log("[dedup] messageId já processado, ignorando:", messageId);
        return new Response("OK");
      }
      // Outro erro de DB — loga mas não bloqueia (evita perder mensagens)
      console.warn("[dedup] erro ao inserir processed_message:", dedupErr.message);
    }
  }

  const remoteJid = key?.remoteJid as string;
  if (!remoteJid || remoteJid.endsWith("@g.us")) {
    return new Response("OK");
  }

  // ── Rate Limiting ────────────────────────────────────────────────────────
  const phoneForLimit = remoteJid.replace(/@.*$/, "");
  const rateCheck = await checkRateLimit(phoneForLimit);
  if (!rateCheck.allowed) {
    if (rateCheck.reason === "rate_exceeded") {
      // Send one-time warning (fire-and-forget, don't await to avoid loop)
      sendText(remoteJid, "⚠️ Muitas mensagens em pouco tempo. Sua conta foi temporariamente limitada por 1 hora.").catch(() => {});
      await logError({
        context: "whatsapp-webhook/rate-limit",
        message: `Rate limit exceeded for ${phoneForLimit}`,
        phone_number: phoneForLimit,
      });
    }
    return new Response("OK"); // silent drop for "blocked" state
  }

  // Determina o identificador: LID (@lid) ou telefone (@s.whatsapp.net)
  const isLid = remoteJid.endsWith("@lid");
  const lid = isLid ? remoteJid : null;
  // Para enviar respostas, usamos o remoteJid direto (Evolution aceita LID no sendText)
  const replyTo = remoteJid;

  const messageData = data?.message as Record<string, unknown>;

  // Detecta resposta de botao interativo (buttonsResponseMessage do Evolution API v2)
  const buttonResp = messageData?.buttonsResponseMessage as Record<string, unknown> | undefined;
  const buttonId = buttonResp?.selectedButtonId as string | undefined;

  const extTextMsg = messageData?.extendedTextMessage as Record<string, unknown> | undefined;
  const text =
    (buttonId ? `BUTTON:${buttonId}` : null) ||
    (messageData?.conversation as string) ||
    (extTextMsg?.text as string);

  const pushName = (data?.pushName as string) || "";

  // ─── Detecção de tipos de mídia ─────────────────────────────────────────
  // Evolution API v2 pode empacotar imagens em viewOnceMessage, viewOnceMessageV2 etc.
  // Estratégia: tenta messageData.imageMessage direto primeiro, depois desembrulha wrappers
  const _imgDirect = messageData?.imageMessage as Record<string, unknown> | undefined;
  const _viewOnce = (messageData?.viewOnceMessage as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
  const _viewOnceV2 = ((messageData?.viewOnceMessageV2 as Record<string, unknown>)?.message as Record<string, unknown>)?.imageMessage as Record<string, unknown> | undefined;
  const _ephemeral = (messageData?.ephemeralMessage as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
  const imgMsg =
    _imgDirect ??
    (_viewOnce?.imageMessage as Record<string, unknown> | undefined) ??
    _viewOnceV2 ??
    (_ephemeral?.imageMessage as Record<string, unknown> | undefined);

  // Fallback: Evolution API sinaliza tipo no campo messageType
  const _messageType = (data?.messageType as string | undefined) ?? "";
  const isImageByType = _messageType === "imageMessage" || _messageType === "viewOnceMessageV2";

  const audioMsgRaw = (messageData?.audioMessage ?? messageData?.pttMessage) as Record<string, unknown> | undefined;
  const docMsg = messageData?.documentMessage as Record<string, unknown> | undefined;

  const ctxInfo =
    (extTextMsg?.contextInfo as Record<string, unknown>) ??
    (imgMsg?.contextInfo as Record<string, unknown>) ??
    (audioMsgRaw?.contextInfo as Record<string, unknown>) ??
    (docMsg?.contextInfo as Record<string, unknown>);

  const isForwarded = !!(ctxInfo?.isForwarded) || ((ctxInfo?.forwardingScore as number ?? 0) > 0);

  // ─── Detecção de reply em mensagem cross-Maya ────────────────────────────
  // Quando um usuário Maya recebe msg enviada pela Maya de outro cliente e
  // responde via botão de reply, o quotedMessage vai conter nossa assinatura.
  const quotedMsg = ctxInfo?.quotedMessage as Record<string, unknown> | undefined;
  const quotedText: string =
    (quotedMsg?.conversation as string) ??
    ((quotedMsg?.extendedTextMessage as Record<string, unknown>)?.text as string) ??
    "";
  const isCrossMayaReply =
    quotedText.includes("minhamaya.com") ||
    quotedText.includes("assistente virtual do") ||
    quotedText.includes("assistente virtual de");

  if (isCrossMayaReply) {
    // Checa se o remetente é um usuário registrado da Minha Maya
    const { profile: senderProfile } = await resolveProfileForShadow(replyTo, lid);
    if (senderProfile) {
      // É um cliente Maya! Manda a mensagem especial e encerra sem processar como intent normal
      const firstName = pushName?.split(" ")[0] || "você";
      await sendText(replyTo,
        `Que coincidência, *${firstName}*! 😄\n\n` +
        `Você acabou de receber uma mensagem enviada pelo agente de outro cliente da *Minha Maya*! 🤖✨\n\n` +
        `Somos todos família por aqui! haha\n\n` +
        `Posso te ajudar com mais alguma coisa? 😊`
      );
      return new Response("OK");
    }
    // Não é usuário Maya → ignora silenciosamente (já é o comportamento padrão)
    return new Response("OK");
  }

  // ─── Áudio (ptt = push-to-talk / audioMessage) ───────────────────────────
  if (audioMsgRaw) {
    const media = await downloadMediaBase64(data);
    if (media) {
      let transcription = "";
      try {
        transcription = await transcribeAudio(media.base64, media.mimetype);
      } catch (e) {
        console.error("Transcription error:", e);
        await sendText(replyTo, "⚠️ Não consegui transcrever o áudio. Tente enviar uma mensagem de texto.");
        return new Response("OK");
      }
      if (!transcription) {
        await sendText(replyTo, "⚠️ Não entendi o áudio. Pode repetir por texto?");
        return new Response("OK");
      }

      // Se audio encaminhado → Modo Sombra: classificar via analyzeForwardedContent
      if (isForwarded) {
        const shadowResult = await handleShadowMode(replyTo, transcription, null, lid, messageId, pushName);
        return new Response(JSON.stringify({ ok: true, shadow: true, debug: shadowResult }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const debugResult = await processMessage(replyTo, transcription, lid, messageId, pushName, transcription);
      return new Response(JSON.stringify({ ok: true, transcription, debug: debugResult }), {
        headers: { "Content-Type": "application/json" },
      });
    } else {
      console.error("[audio] Failed to download media from Evolution API");
      await sendText(replyTo, "⚠️ Não consegui baixar o áudio. Pode tentar enviar de novo?");
    }
    return new Response("OK");
  }

  // ─── Imagem (nota fiscal / recibo / foto encaminhada) ────────────────────
  if (imgMsg || isImageByType) {
    console.log("[image] detected — imgMsg:", !!imgMsg, "isImageByType:", isImageByType, "messageType:", _messageType);
    const media = await downloadMediaBase64(data);
    if (media) {
      const caption = (imgMsg?.caption as string | undefined) || "";
      const debugResult = await processImageMessage(
        replyTo, media.base64, media.mimetype, lid, messageId, pushName, isForwarded, caption
      );
      return new Response(JSON.stringify({ ok: true, debug: debugResult }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // Download falhou — avisa o usuário em vez de silêncio
    console.error("[image] downloadMediaBase64 returned null for", replyTo, "messageType:", _messageType);
    await sendText(replyTo, "⚠️ Não consegui processar a imagem. Pode tentar enviar de novo? Se o problema persistir, descreva a transação por texto: _gastei R$X em Y_");
    return new Response("OK");
  }

  // ─── Documento (PDF / boleto) ────────────────────────────────────────────
  if (docMsg) {
    const debugResult = await handleDocumentMessage(replyTo, data, docMsg, lid, messageId, pushName, isForwarded);
    return new Response(JSON.stringify({ ok: true, debug: debugResult }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Contato vCard compartilhado ─────────────────────────────────────────
  const messageType = data?.messageType as string | undefined;
  const contactMsg = messageData?.contactMessage as Record<string, unknown> | undefined;
  const contactsArrayMsg = messageData?.contactsArrayMessage as Record<string, unknown> | undefined;

  // Log SEMPRE quando não tem texto — ajuda a diagnosticar tipos desconhecidos
  if (!text?.trim()) {
    console.log("[no-text] messageType:", messageType,
      "| keys:", Object.keys(messageData ?? {}),
      "| contactMsg:", !!contactMsg,
      "| contactsArrayMsg:", !!contactsArrayMsg,
      "| raw messageData:", JSON.stringify(messageData ?? {}).slice(0, 300));
  }

  const isContactMsg =
    !!contactMsg ||
    !!contactsArrayMsg ||
    messageType === "contactMessage" ||
    messageType === "contactsArrayMessage";

  if (isContactMsg) {
    const payload = contactMsg ?? contactsArrayMsg ?? messageData ?? {};
    console.log("[contact-detect] matched! payload keys:", Object.keys(payload));
    const debugResult = await handleContactMessage(payload, replyTo, lid);
    return new Response(JSON.stringify({ ok: true, contact: true, debug: debugResult }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!text?.trim()) {
    return new Response("OK");
  }

  // ─── Detecção de contato enviado como texto (Nome + número) ──────────────
  // Ex: "João Silva\n11 99999-9999" ou "Cibele: 11988887777"
  // Só dispara se a mensagem for curta (não é chat normal) e tiver nome + número
  if (!isForwarded && text.trim().length < 120) {
    const hasPhone = /\b\d[\d\s\-().]{7,}\d\b/.test(text);
    const hasName = /[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]{2,}/.test(text);
    const looksLikeContact = hasPhone && hasName &&
      !/\b(gasto|receita|pix|transferencia|reais|r\$|\d+:\d+|hoje|amanha|agenda|lembrete|tarefa)\b/i.test(text);

    if (looksLikeContact) {
      // Trata como contact_save — redireciona para processMessage que tem o handler
      const debugResult = await processMessage(replyTo, `salva o contato ${text.trim()}`, lid, messageId, pushName);
      return new Response(JSON.stringify({ ok: true, auto_contact: true, debug: debugResult }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ─── Modo Sombra: texto encaminhado ──────────────────────────────────────
  if (isForwarded && text.trim()) {
    // Se usuario encaminhou + digitou algo que classifyIntent reconhece → usa fluxo normal
    const forwardedIntent = classifyIntent(text.trim());
    if (forwardedIntent !== "ai_chat" && forwardedIntent !== "greeting") {
      // Usuario deu comando explicito junto com o encaminhamento → fluxo normal
      const debugResult = await processMessage(replyTo, text.trim(), lid, messageId, pushName);
      return new Response(JSON.stringify({ ok: true, debug: debugResult }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // Texto encaminhado puro → Modo Sombra
    const shadowResult = await handleShadowMode(replyTo, text.trim(), null, lid, messageId, pushName);
    return new Response(JSON.stringify({ ok: true, shadow: true, debug: shadowResult }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Processa e responde (síncrono para garantir execução)
  const debugResult = await processMessage(replyTo, text.trim(), lid, messageId, pushName);

  return new Response(JSON.stringify({ ok: true, debug: debugResult }), {
    headers: { "Content-Type": "application/json" },
  });
});

// ─────────────────────────────────────────────
// LISTAR LEMBRETES
// ─────────────────────────────────────────────
async function handleReminderList(
  userId: string,
  lang = "pt-BR",
  userTz = "America/Sao_Paulo"
): Promise<string> {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("id, title, message, send_at, recurrence, recurrence_value, status")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("send_at", { ascending: true })
    .limit(8);

  if (!reminders || reminders.length === 0) {
    return lang === "en"
      ? "📭 You have no pending reminders.\n\nTo create one: _\"remind me of X tomorrow at 10am\"_ ⏰"
      : "📭 Você não tem lembretes pendentes no momento.\n\nPara criar: _\"me lembra de X amanhã às 10h\"_ ⏰";
  }

  const locale = langToLocale(lang);
  const WEEKDAYS_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  const lines = reminders.map((r, i) => {
    const dt = new Date(r.send_at);
    const dateStr = dt.toLocaleDateString(locale, { timeZone: userTz, weekday: "short", day: "numeric", month: "short" });
    const timeStr = dt.toLocaleTimeString(locale, { timeZone: userTz, hour: "2-digit", minute: "2-digit" });
    const title = (r.title || r.message || "").slice(0, 50);
    let recLabel = "";
    if (r.recurrence === "daily") recLabel = " 🔁 todo dia";
    else if (r.recurrence === "weekly") recLabel = ` 🔁 toda ${r.recurrence_value != null ? WEEKDAYS_PT[r.recurrence_value] : "semana"}`;
    else if (r.recurrence === "monthly") recLabel = " 🔁 todo mês";
    else if (r.recurrence === "day_of_month") recLabel = ` 🔁 dia ${r.recurrence_value} do mês`;
    else if (r.recurrence === "hourly") recLabel = ` 🔁 a cada ${r.recurrence_value ?? 1}h`;
    return `${i + 1}. *${title}*\n   📅 ${dateStr} às ${timeStr}${recLabel}`;
  });

  const header = lang === "en" ? "⏰ *Your pending reminders:*\n\n" : "⏰ *Seus lembretes pendentes:*\n\n";
  const footer = lang === "en"
    ? "\n\n_To cancel: \"cancel reminder [name]\"_\n_To edit: \"change reminder [name] to [time]\"_"
    : "\n\n_Para cancelar: \"cancela o lembrete de [nome]\"_\n_Para editar: \"muda o lembrete de [nome] para [hora]\"_";
  return header + lines.join("\n\n") + footer;
}

// ─────────────────────────────────────────────
// CANCELAR LEMBRETE
// ─────────────────────────────────────────────
async function handleReminderCancel(
  userId: string,
  message: string,
  lang = "pt-BR"
): Promise<string> {
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const m = norm(message);

  // Extrai o que quer cancelar (tudo depois de "cancela o lembrete de ...")
  const searchMatch = m.match(
    /(?:cancela(?:r)?|remove(?:r)?|apaga(?:r)?|deleta(?:r)?|exclui(?:r)?)(?:\s+o)?(?:\s+lembrete)?(?:\s+d[eo])?\s+(.+)/
  );
  const searchTerm = searchMatch?.[1]?.trim();

  const { data: reminders } = await supabase
    .from("reminders")
    .select("id, title, message, send_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("send_at", { ascending: true });

  if (!reminders || reminders.length === 0) {
    return lang === "en"
      ? "📭 You have no pending reminders to cancel."
      : "📭 Você não tem lembretes pendentes para cancelar.";
  }

  if (!searchTerm) {
    const list = reminders.slice(0, 4).map(r => `• ${r.title || r.message.slice(0, 40)}`).join("\n");
    return `Qual lembrete quer cancelar? Seus lembretes pendentes:\n\n${list}\n\nEx: _"cancela o lembrete de pagar aluguel"_`;
  }

  // Busca melhor match por similaridade de texto
  const match = reminders.find(r => {
    const t = norm(r.title ?? r.message ?? "");
    return t.includes(searchTerm) || searchTerm.includes(t.slice(0, 12));
  });

  if (!match) {
    const list = reminders.slice(0, 4).map(r => `• ${r.title || r.message.slice(0, 40)}`).join("\n");
    return `Não encontrei esse lembrete. Seus pendentes:\n\n${list}\n\nTente o nome exato.`;
  }

  // Cancela este e todas as recorrências futuras com o mesmo título
  await supabase.from("reminders")
    .update({ status: "cancelled" })
    .eq("user_id", userId)
    .eq("title", match.title)
    .eq("status", "pending");

  const title = match.title || match.message.slice(0, 40);
  return lang === "en"
    ? `✅ Reminder *"${title}"* cancelled! All future recurrences were also removed.`
    : `✅ Lembrete *"${title}"* cancelado! Todas as recorrências futuras também foram removidas.`;
}

// ─────────────────────────────────────────────
// EDITAR LEMBRETE (mudar horário/dia)
// ─────────────────────────────────────────────
async function handleReminderEdit(
  userId: string,
  message: string,
  lang = "pt-BR",
  userTz = "America/Sao_Paulo"
): Promise<string> {
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  const tzOff = getTzOffset(userTz);
  const nowIso = new Date().toLocaleString("sv-SE", { timeZone: userTz, hour12: false }).replace(" ", "T") + tzOff;

  // Extrai o nome do lembrete e novo horário com IA
  const parsed = await parseReminderIntent(message, nowIso, lang);

  const { data: reminders } = await supabase
    .from("reminders")
    .select("id, title, message, send_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("send_at", { ascending: true });

  if (!reminders || reminders.length === 0) {
    return lang === "en"
      ? "📭 You have no pending reminders to edit."
      : "📭 Você não tem lembretes pendentes para editar.";
  }

  // Tenta achar o lembrete pelo título na mensagem
  const m = norm(message);
  let match = reminders.find(r => {
    const t = norm(r.title ?? r.message ?? "");
    return t.split(" ").some(word => word.length > 4 && m.includes(word));
  });
  // Fallback: o mais próximo em tempo
  if (!match) match = reminders[0];

  if (!parsed) {
    return `Não entendi o novo horário. Ex: _"muda o lembrete de ${match.title?.slice(0, 20) ?? "X"} para 19h"_`;
  }

  const newDate = new Date(parsed.remind_at);
  if (isNaN(newDate.getTime())) {
    return "Não consegui identificar o novo horário. Pode repetir?";
  }

  const { error } = await supabase.from("reminders")
    .update({ send_at: newDate.toISOString(), status: "pending" })
    .eq("id", match.id);

  if (error) throw error;

  const locale = langToLocale(lang);
  const dateStr = newDate.toLocaleDateString(locale, { timeZone: userTz, weekday: "long", day: "numeric", month: "long" });
  const timeStr = newDate.toLocaleTimeString(locale, { timeZone: userTz, hour: "2-digit", minute: "2-digit" });
  const title = match.title || match.message.slice(0, 40);

  return lang === "en"
    ? `✅ Reminder *"${title}"* rescheduled!\n📅 ${dateStr} at ${timeStr}`
    : `✅ Lembrete *"${title}"* reagendado!\n📅 ${dateStr} às ${timeStr}`;
}

// ─────────────────────────────────────────────
// LEMBRETE AVULSO (com recorrência)
// ─────────────────────────────────────────────
async function handleReminderSet(
  userId: string,
  phone: string,
  message: string,
  session: Record<string, unknown> | null = null,
  lang = "pt-BR",
  userNickname: string | null = null,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  const tzOff = getTzOffset(userTz);
  const nowIso = new Date().toLocaleString("sv-SE", {
    timeZone: userTz,
    hour12: false,
  }).replace(" ", "T") + tzOff;

  // ── Recupera contexto pendente (fluxo de antecedência) ──
  const ctx = (session?.pending_context as Record<string, unknown>) ?? {};
  const step = (ctx.step as string) ?? null;

  // ─── STEP: reminder_advance_confirm ───
  // Usuário respondeu ao botão "Quer que eu te avise antes?"
  if (step === "reminder_advance_confirm") {
    const parsed = ctx.parsed as Record<string, unknown>;
    const remindAt = new Date(parsed.remind_at as string);
    const msgLow = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

    const wantsAdvance =
      msgLow === "button:advance_confirm_yes" ||
      msgLow === "1" ||
      /^(sim|quero|pode|s|yes|claro|ok|confirma|obrigad)/.test(msgLow);
    // Note: "2" ("Só na hora") falls through naturally to saveReminder(0) below

    if (wantsAdvance) {
      // Envia botões de opções de tempo (fire-and-forget)
      sendButtons(
        phone,
        "Com quanto tempo antes?",
        `Vou te avisar antes de: "${parsed.title}"`,
        [
          { id: "advance_15min", text: "15 minutos" },
          { id: "advance_30min", text: "30 minutos" },
          { id: "advance_1h",    text: "1 hora" },
        ]
      ).catch(() => {});
      return {
        response: "",
        pendingAction: "reminder_set",
        pendingContext: { step: "reminder_advance", parsed },
      };
    }

    // Não quer aviso antecipado → salva na hora exata
    return await saveReminder(userId, phone, parsed, remindAt, 0, lang, userNickname, userTz);
  }

  // ─── STEP: reminder_advance ───
  // Usuário está respondendo com quanto tempo antes quer ser avisado
  if (step === "reminder_advance") {
    const parsed = ctx.parsed as Record<string, unknown>;
    const remindAt = new Date(parsed.remind_at as string);
    const msgLow = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

    // Mapeamento de button IDs para minutos
    const buttonAdvanceMap: Record<string, number> = {
      "button:advance_15min": 15,
      "button:advance_30min": 30,
      "button:advance_1h":    60,
      "button:advance_2h":    120,
      "1": 15, "2": 30, "3": 60,   // fallback para texto numerado (Baileys)
    };
    if (buttonAdvanceMap[msgLow] !== undefined) {
      const advMin = buttonAdvanceMap[msgLow];
      const advancedTime = new Date(remindAt.getTime() - advMin * 60 * 1000);
      return await saveReminder(userId, phone, parsed, advancedTime, advMin, lang, userNickname, userTz);
    }

    // ── Detecta se usuário está especificando recorrência na resposta ──
    const msgNorm = msgLow;
    const recurrenceUpdate = detectRecurrenceFromText(msgNorm, remindAt);
    if (recurrenceUpdate) {
      const updatedParsed = {
        ...parsed,
        recurrence: recurrenceUpdate.recurrence,
        recurrence_value: recurrenceUpdate.recurrence_value,
      };
      return await saveReminder(userId, phone, updatedParsed, remindAt, 0, lang, userNickname, userTz);
    }

    // "só na hora" / "na hora" → 0 min de antecedência (avisa exatamente no horário)
    if (isReminderAtTime(message)) {
      return await saveReminder(userId, phone, parsed, remindAt, 0, lang, userNickname, userTz);
    }
    // "não precisa" → avisa na hora mesmo (sem antecedência adicional)
    if (isReminderDecline(message)) {
      return await saveReminder(userId, phone, parsed, remindAt, 0, lang, userNickname, userTz);
    }
    // Tenta extrair minutos de antecedência
    const advanceMin = parseMinutes(message);
    if (advanceMin !== null && advanceMin > 0) {
      const advancedTime = new Date(remindAt.getTime() - advanceMin * 60 * 1000);
      return await saveReminder(userId, phone, parsed, advancedTime, advanceMin, lang, userNickname, userTz);
    }
    // Não entendeu → reenvia botões
    sendButtons(
      phone,
      "Com quanto tempo antes?",
      `Vou te avisar antes de: "${(parsed as Record<string, unknown>).title}"`,
      [
        { id: "advance_15min", text: "15 minutos" },
        { id: "advance_30min", text: "30 minutos" },
        { id: "advance_1h",    text: "1 hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "reminder_set",
      pendingContext: ctx,
    };
  }

  // ── Extrai intenção do lembrete com IA ──
  const parsed = await parseReminderIntent(message, nowIso, lang);

  if (!parsed) {
    return { response: "⚠️ Não entendi o lembrete. Tente: *me lembra de ligar pro João amanhã às 14h*" };
  }

  const remindAt = new Date(parsed.remind_at);
  if (isNaN(remindAt.getTime())) {
    return { response: "⚠️ Não consegui identificar a data/hora. Pode repetir com mais detalhes?" };
  }

  if (remindAt <= new Date()) {
    remindAt.setDate(remindAt.getDate() + 1);
  }

  // ── Garante que recorrência detectada via regex prevaleça sobre IA ──
  // Evita que o Haiku retorne "none" para mensagens recorrentes claras
  const msgNormFull = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const regexRecurrence = detectRecurrenceFromText(msgNormFull, remindAt);
  if (regexRecurrence && parsed.recurrence === "none") {
    parsed.recurrence = regexRecurrence.recurrence as typeof parsed.recurrence;
    parsed.recurrence_value = regexRecurrence.recurrence_value;
  }

  // ── Pergunta com quanto tempo de antecedência ──
  // Só pergunta se o lembrete NÃO é recorrente nem tem "na hora" explícito
  // Para recorrentes: salva direto sem perguntar (não faz sentido perguntar antecedência para lembrete diário)
  const msgLower = message.toLowerCase();
  const mentionedAdvance = /antes|antecedência|antecipado|minutos? antes|horas? antes/.test(msgLower);
  const atTimeNow = isReminderAtTime(msgLower);

  // Pergunta antecedência só se: sem recorrência, sem "na hora" explícito,
  // sem "antes" na mensagem, E o lembrete é para daqui mais de 45 minutos
  // (não faz sentido perguntar antecedência de "daqui 5 minutos")
  const minutesUntilReminder = (remindAt.getTime() - Date.now()) / 60000;
  const isSoonReminder = minutesUntilReminder < 45;

  if (!mentionedAdvance && !atTimeNow && !isSoonReminder && parsed.recurrence === "none") {
    const locale = langToLocale(lang);
    const timeStr = remindAt.toLocaleTimeString(locale, {
      timeZone: userTz,
      hour: "2-digit", minute: "2-digit",
    });
    const dateStr = remindAt.toLocaleDateString(locale, {
      timeZone: userTz,
      weekday: "long", day: "numeric", month: "long",
    });
    // Pergunta via botões: Quer aviso antecipado?
    sendButtons(
      phone,
      "Quer que eu te avise antes? ⏱️",
      `Lembrete: "${parsed.title}" — ${dateStr} às ${timeStr}`,
      [
        { id: "advance_confirm_yes", text: "⏰ Sim, me avisa antes" },
        { id: "advance_confirm_no",  text: "✅ Só na hora" },
      ]
    ).catch(() => {});
    return {
      response: "",
      pendingAction: "reminder_set",
      pendingContext: { step: "reminder_advance_confirm", parsed },
    };
  }

  // Tem antecedência explícita na mensagem → salva direto
  return await saveReminder(userId, phone, parsed, remindAt, 0, lang, userNickname, userTz);
}

/** Salva o lembrete no banco e retorna confirmação formatada */
async function saveReminder(
  userId: string,
  phone: string,
  parsed: Record<string, unknown>,
  remindAt: Date,
  advanceMin: number,
  lang = "pt-BR",
  userNickname: string | null = null,
  userTz = "America/Sao_Paulo"
): Promise<{ response: string }> {
  // ── Limite de lembretes pendentes por usuário (evita abuso) ──
  const { count: pendingCount } = await supabase
    .from("reminders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending") as any;

  if ((pendingCount ?? 0) >= 50) {
    return {
      response: lang === "en"
        ? "⚠️ You've reached the limit of 50 pending reminders. Cancel some before creating new ones.\n\nSay: _\"show my reminders\"_ to see them."
        : "⚠️ Você tem muitos lembretes pendentes (máximo 50). Cancele alguns antes de criar novos.\n\nDiga: _\"meus lembretes\"_ para ver a lista.",
    };
  }

  const { error } = await supabase.from("reminders").insert({
    user_id: userId,
    whatsapp_number: phone,
    title: parsed.title,
    message: parsed.message,
    send_at: remindAt.toISOString(),
    recurrence: parsed.recurrence,
    recurrence_value: parsed.recurrence_value,
    source: "whatsapp",
    status: "pending",
  });

  if (error) throw error;

  const locale = langToLocale(lang);
  const dateRaw = remindAt.toLocaleDateString(locale, {
    timeZone: userTz,
    weekday: "long", day: "numeric", month: "long",
  });
  const dateStr = dateRaw.charAt(0).toUpperCase() + dateRaw.slice(1);
  const timeStr = remindAt.toLocaleTimeString(locale, {
    timeZone: userTz,
    hour: "2-digit", minute: "2-digit",
  });

  const rv = parsed.recurrence_value as number | null;
  const recurrenceLabel: Record<string, string> = lang === "en" ? {
    none: "",
    hourly: `\n🔁 *Recurring:* every ${rv === 1 || rv == null ? "hour" : `${rv} hours`}`,
    daily: "\n🔁 *Recurring:* every day",
    weekly: "\n🔁 *Recurring:* every week",
    monthly: "\n🔁 *Recurring:* every month",
    day_of_month: `\n🔁 *Recurring:* every ${rv ?? ""} of the month`,
  } : lang === "es" ? {
    none: "",
    hourly: `\n🔁 *Recurrente:* cada ${rv === 1 || rv == null ? "hora" : `${rv} horas`}`,
    daily: "\n🔁 *Recurrente:* todos los días",
    weekly: "\n🔁 *Recurrente:* todas las semanas",
    monthly: "\n🔁 *Recurrente:* todos los meses",
    day_of_month: `\n🔁 *Recurrente:* cada día ${rv ?? ""} del mes`,
  } : {
    none: "",
    hourly: `\n🔁 *Recorrente:* a cada ${rv === 1 || rv == null ? "hora" : `${rv} horas`}`,
    daily: "\n🔁 *Recorrente:* todo dia",
    weekly: "\n🔁 *Recorrente:* toda semana",
    monthly: "\n🔁 *Recorrente:* todo mês",
    day_of_month: `\n🔁 *Recorrente:* todo dia ${rv ?? ""} do mês`,
  };

  const advanceNote = advanceMin > 0
    ? (lang === "en"
        ? `\n🔔 Alert ${fmtAdvanceLabel(advanceMin, lang)} before`
        : lang === "es"
        ? `\n🔔 Aviso ${fmtAdvanceLabel(advanceMin, lang)} antes`
        : `\n🔔 Aviso ${fmtAdvanceLabel(advanceMin, lang)} antes`)
    : (lang === "en" ? "\n🔔 Alert at reminder time" : lang === "es" ? "\n🔔 Aviso en el horario" : "\n🔔 Aviso na hora");

  const nameGreetReminder = userNickname ? `, ${userNickname}` : "";
  return {
    response: `⏰ *Lembrete criado${nameGreetReminder}!*\n📌 ${parsed.title}\n📅 ${dateStr} às ${timeStr}${advanceNote}${recurrenceLabel[String(parsed.recurrence)] ?? ""}\n\n_Vou te avisar aqui no WhatsApp!_`,
  };
}

// ─────────────────────────────────────────────
// SNOOZE — adia o último lembrete enviado
// ─────────────────────────────────────────────
async function handleReminderSnooze(
  userId: string,
  phone: string,
  message: string,
  userTz = "America/Sao_Paulo"
): Promise<string> {
  // Busca o lembrete enviado mais recentemente (nos últimos 30 min)
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: lastReminder } = await supabase
    .from("reminders")
    .select("id, title, message, event_id, whatsapp_number")
    .eq("user_id", userId)
    .eq("status", "sent")
    .gte("sent_at", thirtyMinAgo)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastReminder) {
    return "Não encontrei nenhum lembrete recente para adiar. 🔍\n\n_O snooze funciona quando enviado em até 30 minutos após um lembrete._";
  }

  // Extrai duração do snooze da mensagem (padrão: 30 min)
  const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let snoozeMin = 30;

  const hoursMatch = m.match(/(\d+(?:[.,]\d+)?)\s*hora/);
  if (hoursMatch) {
    snoozeMin = Math.round(parseFloat(hoursMatch[1].replace(",", ".")) * 60);
  } else if (/meia hora/.test(m)) {
    snoozeMin = 30;
  } else {
    const minsMatch = m.match(/(\d+)\s*(?:min|minutos?)?/);
    if (minsMatch && parseInt(minsMatch[1]) > 0 && parseInt(minsMatch[1]) <= 480) {
      snoozeMin = parseInt(minsMatch[1]);
    }
  }

  // Garante snooze razoável: entre 5 e 8h
  snoozeMin = Math.max(5, Math.min(snoozeMin, 480));

  const newSendAt = new Date(Date.now() + snoozeMin * 60 * 1000);

  await supabase.from("reminders").insert({
    user_id: userId,
    whatsapp_number: lastReminder.whatsapp_number ?? phone,
    title: lastReminder.title,
    message: lastReminder.message,
    send_at: newSendAt.toISOString(),
    event_id: lastReminder.event_id ?? null,
    recurrence: "none",
    source: "snooze",
    status: "pending",
  });

  const timeStr = newSendAt.toLocaleTimeString("pt-BR", {
    timeZone: userTz,
    hour: "2-digit",
    minute: "2-digit",
  });

  const label =
    snoozeMin >= 60
      ? `${snoozeMin / 60 === Math.floor(snoozeMin / 60) ? snoozeMin / 60 + " hora" + (snoozeMin / 60 > 1 ? "s" : "") : snoozeMin + " min"}`
      : `${snoozeMin} min`;

  return `⏰ *Lembrete adiado por ${label}!*\nVou te avisar novamente às *${timeStr}*.\n\n_"${lastReminder.title}"_`;
}

// ─────────────────────────────────────────────
// EVENT FOLLOWUP — confirma se o evento aconteceu
// ─────────────────────────────────────────────
async function handleEventFollowup(
  userId: string,
  phone: string,
  message: string,
  session: Record<string, unknown>
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  const ctx = (session?.pending_context as Record<string, unknown>) ?? {};
  const eventId = ctx?.event_id as string | undefined;
  const eventTitle = (ctx?.event_title as string) || "seu compromisso";

  const m = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  // ✅ Confirmação positiva
  if (/^(sim|s|feito|foi|aconteceu|consegui|concluido|ok|yes|fui|rolou|deu certo|certo|boa|foi sim|sim fui)$/.test(m)) {
    if (eventId) {
      await supabase
        .from("events")
        .update({ status: "done" })
        .eq("id", eventId)
        .eq("user_id", userId);
    }
    return { response: `✅ *${eventTitle}* marcado como concluído! Ótimo trabalho! 💪` };
  }

  // 🔄 Quer adiar/reagendar
  if (/^(adiar|nao|não|n|nope|nao fui|nao consegui|nao rolou|reagendar|remarcar|cancelar)$/.test(m) ||
      /nao (fui|consegui|foi|rolou|aconteceu)/.test(m)) {
    // Busca data/hora do evento no banco para passar ao edit flow
    let eventDate = ctx.event_date as string | undefined;
    let eventTime = ctx.event_time as string | undefined;
    if (eventId && (!eventDate || !eventTime)) {
      const { data: ev } = await supabase
        .from("events")
        .select("event_date, event_time")
        .eq("id", eventId)
        .maybeSingle();
      if (ev) {
        eventDate = ev.event_date ?? undefined;
        eventTime = ev.event_time ?? undefined;
      }
    }
    // Mantém evento como pending (não cancela, apenas não confirma)
    return {
      response: `Tudo bem! Para quando vou remarcar *${eventTitle}*? 📅\n\n_Ex: amanhã às 15h, sexta às 10h_`,
      pendingAction: "agenda_edit",
      pendingContext: {
        event_id: eventId,
        event_title: eventTitle,
        event_date: eventDate,
        event_time: eventTime,
        reminder_minutes: null,
        step: "awaiting_change",
      },
    };
  }

  // Resposta ambígua
  return {
    response: `*${eventTitle}* aconteceu?\n\n✅ *sim* — marco como feito\n🔄 *adiar* — vamos reagendar`,
    pendingAction: "event_followup",
    pendingContext: ctx,
  };
}

// ─────────────────────────────────────────────
// STATEMENT IMPORT HELPERS — Feature #15
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// MODO SOMBRA: handlers para mensagens encaminhadas
// ─────────────────────────────────────────────

/**
 * Resolve perfil do usuario a partir de replyTo e lid.
 * Reutiliza o padrao multi-fallback (LID → phone → phone com +).
 */
async function resolveProfileForShadow(
  replyTo: string,
  lid: string | null
): Promise<{
  profile: { id: string; phone_number: string; timezone: string | null } | null;
  sendPhone: string;
}> {
  const phone = replyTo.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
  let profile: { id: string; phone_number: string; timezone: string | null } | null = null;

  if (lid) {
    const { data } = await supabase.from("profiles").select("id, phone_number, timezone").eq("whatsapp_lid", lid).maybeSingle();
    profile = data;
  }
  if (!profile) {
    const { data } = await supabase.from("profiles").select("id, phone_number, timezone")
      .or(`phone_number.eq.${phone},phone_number.eq.+${phone}`).maybeSingle();
    profile = data;
  }

  const sendPhone = profile?.phone_number?.replace(/\D/g, "") || phone;
  return { profile, sendPhone };
}

/**
 * Handler principal do Modo Sombra.
 * Classifica conteudo textual encaminhado e roteia para a acao correta.
 */
async function handleShadowMode(
  replyTo: string,
  content: string,
  base64Media: string | null,
  lid: string | null,
  messageId: string | undefined,
  pushName: string
): Promise<string[]> {
  const log: string[] = ["shadow_mode"];

  try {
    const { profile, sendPhone } = await resolveProfileForShadow(replyTo, lid);
    if (!profile) { log.push("unknown_profile"); return log; }

    const { data: config } = await supabase.from("agent_configs").select("*").eq("user_id", profile.id).maybeSingle();
    if (config?.is_active === false) { log.push("agent_inactive"); return log; }

    // Verifica se ha sessao pendente — shadow mode NAO interrompe fluxos em andamento
    const sessionId = profile.phone_number?.replace(/\D/g, "") || "";
    const { data: session } = await supabase.from("whatsapp_sessions").select("pending_action")
      .eq("phone_number", sessionId).maybeSingle();
    if (session?.pending_action) {
      log.push("pending_session_active");
      // Redireciona para processMessage normal para manter fluxo
      await processMessage(replyTo, content, lid, messageId, pushName);
      return log;
    }

    const moduleFinance = config?.module_finance !== false;
    const moduleAgenda = config?.module_agenda !== false;
    const moduleNotes = config?.module_notes !== false;
    const userTz = profile.timezone || "America/Sao_Paulo";
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: userTz });

    // Textos muito curtos → nota automatica (sem gastar API)
    if (content.length < 10) {
      if (moduleNotes) {
        await supabase.from("notes").insert({
          user_id: profile.id, title: content.slice(0, 50), content, source: "whatsapp_forward",
        });
        await sendText(sendPhone || replyTo, `📝 Anotei: "${content}" [📨 encaminhado]`);
      }
      log.push("short_text_note");
      return log;
    }

    // Regex pre-filter: textos claramente financeiros (economiza API call)
    const financialPattern = /R\$\s?\d|pix|transfer[eê]ncia|comprovante|boleto|pagamento.*confirm|valor\s*:?\s*R?\$?\s*\d/i;
    let analysis: ShadowAnalysis;

    if (financialPattern.test(content)) {
      // Alta probabilidade financeira → ainda usa API para extrair dados precisos
      analysis = await analyzeForwardedContent(content, today, userTz);
      if (analysis.action === "unknown") analysis = { action: "finance_record", confidence: 0.6, data: {} };
    } else {
      analysis = await analyzeForwardedContent(content, today, userTz);
    }

    log.push(`classified: ${analysis.action} (${analysis.confidence})`);

    // ── Roteamento por acao classificada ──
    if (analysis.action === "finance_record" && analysis.confidence >= 0.7 && moduleFinance) {
      const d = analysis.data;
      const amount = d.amount ?? 0;

      if (amount > 0) {
        if (amount >= 1000) {
          // Alto valor → confirma com botoes
          await sendButtons(
            sendPhone || replyTo,
            "💸 Transação detectada",
            `R$ ${fmtBRL(amount)} — ${d.description || "encaminhado"}\nRegistrar como ${d.type === "income" ? "receita" : "gasto"}?`,
            [
              { id: "SHADOW_FIN_YES", text: "✅ Registrar" },
              { id: "SHADOW_FIN_NO",  text: "❌ Ignorar" },
            ]
          );
          await supabase.from("whatsapp_sessions").upsert({
            user_id: profile.id, phone_number: sessionId,
            pending_action: "shadow_finance_confirm",
            pending_context: { ...d, today },
            last_activity: new Date().toISOString(), last_processed_id: messageId ?? null,
          }, { onConflict: "phone_number" });
          log.push("finance_high_value_confirm");
        } else {
          // Valor normal → auto-registra
          await supabase.from("transactions").insert({
            user_id: profile.id, type: d.type || "expense", amount,
            category: d.category || "outros", description: d.description || "Encaminhado",
            transaction_date: d.date || today, source: "whatsapp_forward",
          });
          const emoji = d.type === "income" ? "🟢" : "🔴";
          const catEm = CATEGORY_EMOJI[d.category ?? "outros"] ?? "📦";
          await sendText(sendPhone || replyTo, `${emoji} Registrei: R$ ${fmtBRL(amount)} — ${d.description || "encaminhado"} (${catEm} ${d.category || "outros"}) [📨 encaminhado]`);
          log.push("finance_auto_saved");
        }
        return log;
      }
    }

    if (analysis.action === "event_create" && analysis.confidence >= 0.6 && moduleAgenda) {
      const d = analysis.data;
      const dateLabel = d.event_date || "data indefinida";
      const timeLabel = d.event_time || "";
      await sendButtons(
        sendPhone || replyTo,
        "📅 Evento detectado!",
        `*${d.title || "Compromisso"}*\n${dateLabel}${timeLabel ? " às " + timeLabel : ""}\n\nCriar na agenda?`,
        [
          { id: "SHADOW_EVT_YES",  text: "✅ Criar" },
          { id: "SHADOW_EVT_NO",   text: "❌ Ignorar" },
        ]
      );
      await supabase.from("whatsapp_sessions").upsert({
        user_id: profile.id, phone_number: sessionId,
        pending_action: "shadow_event_confirm",
        pending_context: { title: d.title, date: d.event_date, time: d.event_time, duration: d.duration_minutes },
        last_activity: new Date().toISOString(), last_processed_id: messageId ?? null,
      }, { onConflict: "phone_number" });
      log.push("event_confirm");
      return log;
    }

    if (analysis.action === "reminder_create" && analysis.confidence >= 0.6 && moduleNotes) {
      const d = analysis.data;
      await sendButtons(
        sendPhone || replyTo,
        "⏰ Lembrete detectado!",
        `*${d.reminder_title || "Lembrete"}*\nData: ${d.remind_at || "indefinida"}\n\nCriar lembrete?`,
        [
          { id: "SHADOW_REM_YES", text: "✅ Criar" },
          { id: "SHADOW_REM_NO",  text: "❌ Ignorar" },
        ]
      );
      await supabase.from("whatsapp_sessions").upsert({
        user_id: profile.id, phone_number: sessionId,
        pending_action: "shadow_reminder_confirm",
        pending_context: { title: d.reminder_title, remind_at: d.remind_at },
        last_activity: new Date().toISOString(), last_processed_id: messageId ?? null,
      }, { onConflict: "phone_number" });
      log.push("reminder_confirm");
      return log;
    }

    // Default: salva como nota
    if (moduleNotes) {
      const noteTitle = analysis.data?.note_title || content.slice(0, 50);
      const noteContent = analysis.data?.note_content || content;
      await supabase.from("notes").insert({
        user_id: profile.id, title: noteTitle, content: noteContent, source: "whatsapp_forward",
      });
      syncNotion(profile.id, noteContent).catch(() => {});
      await sendText(sendPhone || replyTo, `📝 Anotei: "${noteTitle}" [📨 encaminhado]`);
      log.push("note_saved");
    }

    return log;
  } catch (err) {
    console.error("[shadow_mode] Error:", err);
    log.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return log;
  }
}

/**
 * Handler para documentos (PDF, etc.) recebidos via WhatsApp.
 */
async function handleDocumentMessage(
  replyTo: string,
  data: Record<string, unknown>,
  docMsg: Record<string, unknown>,
  lid: string | null,
  messageId: string | undefined,
  pushName: string,
  isForwarded: boolean
): Promise<string[]> {
  const log: string[] = ["document_processing"];
  const mimetype = (docMsg.mimetype as string) || "";
  const fileName = (docMsg.fileName as string) || "documento";

  try {
    const media = await downloadMediaBase64(data);
    if (!media) {
      log.push("download_failed");
      return log;
    }

    // Se e imagem embutida → processa como imagem
    if (mimetype.startsWith("image/")) {
      return await processImageMessage(replyTo, media.base64, media.mimetype, lid, messageId, pushName, isForwarded) as string[];
    }

    // PDF: o Vision API não processa PDF binário diretamente.
    // Orienta o usuário a enviar como screenshot/foto para melhor resultado.
    if (mimetype === "application/pdf") {
      const { profile: pdfProfile } = await resolveProfileForShadow(replyTo, lid);
      const sendPhone = pdfProfile?.phone_number ?? replyTo;
      await sendText(sendPhone, `📄 Recebi o PDF "${fileName}"!\n\nPara registrar as transações automaticamente, tire um *screenshot* da tela do comprovante e envie como foto — o Vision funciona melhor com imagem do que com PDF.\n\nOu me diga por texto: _gastei R$X em Y_`);
      log.push("pdf_guided_to_screenshot");
      return log;
    }

    // Fallback: salva como nota com metadata
    const { profile } = await resolveProfileForShadow(replyTo, lid);
    if (profile) {
      await supabase.from("notes").insert({
        user_id: profile.id,
        title: fileName,
        content: `Documento recebido: ${fileName}\nTipo: ${mimetype}\nRecebido em: ${new Date().toISOString()}`,
        source: isForwarded ? "whatsapp_forward" : "whatsapp",
      });
      const fwdLabel = isForwarded ? " [📨 encaminhado]" : "";
      await sendText(profile.phone_number ?? replyTo, `📄 Recebi "${fileName}" — salvei como anotação.${fwdLabel}`);
    }
    log.push("saved_as_note");
    return log;
  } catch (err) {
    console.error("[document_processing] Error:", err);
    log.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return log;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTATOS — vCard, envio de mensagem e reuniões
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processa contactMessage/contactsArrayMessage recebido via WhatsApp.
 * Extrai nome + telefone do vCard e pede confirmação via botões antes de salvar.
 */
async function handleContactMessage(
  contactData: Record<string, unknown>,
  replyTo: string,
  lid: string | null,
): Promise<string[]> {
  const log: string[] = [];

  // ── Resolve perfil do usuário ───────────────────────────────────────────
  const { profile, sendPhone } = await resolveProfileForShadow(replyTo, lid);
  const dest = sendPhone || replyTo;
  console.log("[handleContactMessage] replyTo:", replyTo, "| lid:", lid, "| profile:", !!profile, "| dest:", dest);

  if (!profile) {
    log.push("profile_not_found");
    // Não envia erro — usuário não cadastrado, ignora silenciosamente
    return log;
  }

  // ── Extrai lista de contatos do payload (vários formatos possíveis) ──────
  let rawList: Array<Record<string, unknown>> = [];

  if (Array.isArray(contactData.contacts)) {
    rawList = contactData.contacts as Array<Record<string, unknown>>;
  } else if (contactData.displayName || contactData.vcard) {
    rawList = [contactData];
  } else {
    // Tenta subchaves (evolutionAPI aninha de formas diferentes)
    const sub = (
      contactData.contactMessage ??
      contactData.message ??
      contactData
    ) as Record<string, unknown>;
    rawList = [sub];
  }

  console.log("[handleContactMessage] rawList count:", rawList.length, "| keys[0]:", Object.keys(rawList[0] ?? {}));

  // ── Parseia cada contato e monta lista com nome + telefone ───────────────
  type ParsedContact = { name: string; phone: string };
  const parsed: ParsedContact[] = [];

  for (const c of rawList) {
    const name = String(c.displayName ?? c.fullName ?? c.name ?? "").trim();
    const vcard = String(c.vcard ?? "");

    // Extrai telefone: waid= é mais confiável, fallback TEL:, fallback campo phone
    let phone = "";
    const waidMatch = vcard.match(/waid=(\d+)/i);
    if (waidMatch) {
      phone = waidMatch[1];
    } else {
      const telMatch = vcard.match(/TEL[^:\n]*:\s*([+\d\s\-().]+)/i);
      if (telMatch) phone = telMatch[1].replace(/\D/g, "");
    }
    if (!phone && c.phone) phone = String(c.phone).replace(/\D/g, "");

    if (!phone) { log.push(`skip_no_phone: ${name || "?"}`); continue; }

    // Normaliza para código Brasil
    if (!phone.startsWith("55") && phone.length <= 11) phone = `55${phone}`;

    const nameToUse = name || `Contato ${phone.slice(-4)}`;
    parsed.push({ name: nameToUse, phone });
  }

  console.log("[handleContactMessage] parsed contacts:", parsed.map(p => `${p.name}(${p.phone})`));

  if (parsed.length === 0) {
    log.push("no_contacts_parsed");
    await sendText(dest, "📇 Recebi um contato mas não consegui extrair o número. Tente compartilhar novamente.");
    return log;
  }

  // ── Para cada contato, pede confirmação com botão ───────────────────────
  const sessionId = profile.phone_number?.replace(/\D/g, "") || dest.replace(/\D/g, "");

  for (const p of parsed) {
    const phoneDisplay = phoneForDisplay(p.phone);
    await sendButtons(
      dest,
      "📇 Novo contato detectado!",
      `*${p.name}*\n📱 ${phoneDisplay}\n\nSalvar nos seus contatos?`,
      [
        { id: `CONTACT_SAVE_YES|${p.name}|${p.phone}`, text: "💾 Salvar" },
        { id: "CONTACT_SAVE_NO",                        text: "❌ Ignorar" },
      ]
    );

    // Armazena na sessão para confirmar
    await supabase.from("whatsapp_sessions").upsert({
      user_id: profile.id,
      phone_number: sessionId,
      pending_action: "contact_save_confirm",
      pending_context: { name: p.name, phone: p.phone },
      last_activity: new Date().toISOString(),
    }, { onConflict: "phone_number" });

    log.push(`prompted_save: ${p.name} (${p.phone})`);
  }

  return log;
}

/**
 * Monta o rodapé de apresentação da Maya enviado a contatos externos.
 * Inclui número do usuário (para responder diretamente) + CTA minhamaya.com.
 */
function buildMayaCTA(userName: string, userPhone: string): string {
  return (
    `\n\n_——————————_\n` +
    `Para falar diretamente com *${userName}*, o número é: *${userPhone}*\n\n` +
    `Quer ter uma assistente virtual igual a mim? 🤖✨\n` +
    `Acesse 👉 *minhamaya.com* e descubra tudo que posso fazer por você diretamente no WhatsApp — agendamentos, finanças, lembretes e muito mais!\n\n` +
    `Até mais! 🤍\n*— Maya*`
  );
}

/** Formata número de telefone para exibição humana (+55 11 99999-9999) */
function phoneForDisplay(raw: string): string {
  const n = raw.replace(/@.*$/, "").replace(/\D/g, "");
  if (n.startsWith("55") && n.length === 13) {
    return `+55 (${n.slice(2, 4)}) ${n.slice(4, 9)}-${n.slice(9)}`;
  }
  if (n.startsWith("55") && n.length === 12) {
    return `+55 (${n.slice(2, 4)}) ${n.slice(4, 8)}-${n.slice(8)}`;
  }
  return n.length > 0 ? `+${n}` : raw;
}

/**
 * Envia mensagem para um contato salvo, imediatamente ou com atraso.
 * Ex: "manda pra Cibele dizendo pegar pão" / "daqui 30min manda pra João que..."
 */
async function handleSendToContact(
  userId: string,
  replyTo: string,
  text: string,
  userTz: string,
  agentName: string,
  userNickname: string | null,
  pushName: string,
): Promise<string> {
  const norm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Detecta atraso: "daqui 30 minutos", "daqui 1 hora"
  let delayMs = 0;
  const delayMatch = norm.match(/daqui\s+(\d+)\s*(minuto|hora)/i);
  if (delayMatch) {
    const num = parseInt(delayMatch[1]);
    const unit = delayMatch[2].toLowerCase();
    delayMs = unit.startsWith("min") ? num * 60_000 : num * 3_600_000;
  }

  // Extrai nome do contato — "pra/para/pro [Nome]"
  // Capitaliza o primeiro char após o prefixo para aceitar "pra cibele" e "pra Cibele"
  const prefixMatch = /\b(?:pra|para|pro|ao?)\s+/i.exec(text);
  if (!prefixMatch) {
    return "Não identifiquei para quem enviar. Tente: _Manda pra [Nome] dizendo [mensagem]_";
  }
  const rawAfterPrefix = text.slice(prefixMatch.index + prefixMatch[0].length);
  // Normaliza para Title Case: "cibele" → "Cibele", "CIBELE" → "Cibele", "CIBELE SILVA" → "Cibele Silva"
  // Só é usado para extração de nome (tokenRe); a mensagem é extraída do `text` original na linha abaixo
  const afterPrefix = rawAfterPrefix.split(/\s+/).map(w =>
    w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w
  ).join(" ");
  // Coleta tokens que começam com maiúscula (nomes próprios) — para no primeiro minúsculo
  const nameTokens: string[] = [];
  const tokenRe = /^([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+)\s*/;
  let remaining = afterPrefix;
  while (remaining.length > 0) {
    const t = tokenRe.exec(remaining);
    if (!t) break;
    nameTokens.push(t[1]);
    remaining = remaining.slice(t[0].length);
  }
  if (nameTokens.length === 0) {
    return "Não identifiquei para quem enviar. Tente: _Manda pra [Nome] dizendo [mensagem]_";
  }
  const contactName = nameTokens.join(" ");

  // ── Busca contato no banco ─────────────────────────────────────────────────
  // Estratégia: nome completo primeiro → primeiro nome → lista para disambiguação
  let found: Record<string, unknown> | null = null;

  // 1) Busca por nome completo extraído
  const { data: f1 } = await supabase
    .from("contacts").select("*").eq("user_id", userId)
    .ilike("name", `%${contactName}%`).limit(1).maybeSingle();
  found = f1 ?? null;

  if (!found) {
    // 2) Fallback: primeiro token (ex: "Miguel" de "Miguel Fernandes")
    const firstName = nameTokens[0];
    const { data: allFirstNameMatches } = await supabase
      .from("contacts").select("*").eq("user_id", userId)
      .ilike("name", `${firstName}%`).limit(5);

    if (allFirstNameMatches && allFirstNameMatches.length === 1) {
      // Apenas um resultado com esse primeiro nome → usa direto
      found = allFirstNameMatches[0] as Record<string, unknown>;
    } else if (allFirstNameMatches && allFirstNameMatches.length > 1) {
      // Múltiplos contatos com o mesmo primeiro nome → pede para o usuário escolher
      const lista = allFirstNameMatches
        .map((c, i) => `*${i + 1}.* ${c.name}`)
        .join("\n");
      return (
        `Encontrei ${allFirstNameMatches.length} contatos com o nome *${firstName}*:\n\n` +
        `${lista}\n\n` +
        `Para qual deles você quer enviar? Responda com o número ou o nome completo.`
      );
    }
  }

  if (!found) {
    // Lista os contatos disponíveis para ajudar o usuário
    const { data: allContacts } = await supabase
      .from("contacts").select("name").eq("user_id", userId).limit(10);
    const lista = allContacts?.map(c => `• ${c.name}`).join("\n") || "_Nenhum contato salvo_";
    return `Não encontrei *${contactName}* nos seus contatos.\n\n*Seus contatos:*\n${lista}\n\nPara adicionar: compartilhe o contato ou diga _"Salva o contato [Nome]: [número]"_ 📇`;
  }

  // Extrai conteúdo da mensagem
  // 1ª tentativa: depois de palavra-gatilho ("dizendo", "falando", "que", ":")
  const msgMatch = text.match(/(?:dizendo|dizer|falando|que\s+(?!tal\b)|:\s*)(.+)/i);
  let msgContent = msgMatch ? msgMatch[1].trim() : "";

  // 2ª tentativa (fallback): tudo depois do último token do nome extraído
  // Ex: "Enviar pro Caio confirmar horário" → tira "Enviar pro Caio " → "confirmar horário"
  if (!msgContent) {
    const nameInText = new RegExp(
      `(?:pra|para|pro|ao?)\\s+${nameTokens.join("\\s+")}\\s+`,
      "i"
    );
    const afterName = text.replace(nameInText, "");
    msgContent = afterName !== text ? afterName.trim() : text.trim();
  }

  // Nome e saudação com horário do dia
  const senderName = userNickname || pushName || "seu contato";
  const contactFirstName = found.name.split(" ")[0];
  const hour = new Date().toLocaleString("en-US", { timeZone: userTz, hour: "numeric", hour12: false });
  const h = parseInt(hour);
  const greeting = h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";

  // Busca telefone real do usuário para o CTA
  const { data: userProfile } = await supabase
    .from("profiles")
    .select("phone_number")
    .eq("id", userId)
    .maybeSingle();
  const userPhone = phoneForDisplay(userProfile?.phone_number ?? replyTo);

  const outgoing =
    `${greeting}, *${contactFirstName}*! 😊\n\n` +
    `Aqui é a *${agentName}*, assistente virtual do *${senderName}*.\n\n` +
    `Ele(a) me pediu para te passar um recado:\n\n` +
    `💬 _"${msgContent}"_` +
    buildMayaCTA(senderName, userPhone);

  if (delayMs > 0) {
    const sendAt = new Date(Date.now() + delayMs).toISOString();
    await supabase.from("reminders").insert({
      user_id: userId,
      whatsapp_number: found.phone,
      title: `Mensagem para ${found.name}`,
      message: outgoing,
      send_at: sendAt,
      recurrence: "none",
      source: "send_to_contact",
      status: "pending",
    });
    const mins = Math.round(delayMs / 60_000);
    const timeLabel = mins < 60 ? `${mins} minuto${mins > 1 ? "s" : ""}` : `${Math.round(mins / 60)} hora${mins >= 120 ? "s" : ""}`;
    return `✅ Agendado! Vou mandar a mensagem pra *${found.name}* em ${timeLabel}.`;
  }

  await sendText(found.phone, outgoing);
  return `✅ Mensagem enviada pra *${found.name}*!`;
}

/** Formata data YYYY-MM-DD em português legível */
function formatDateBR(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const months = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${d} de ${months[m - 1]}`;
}

/**
 * Cria reunião com Google Meet para um contato salvo.
 * Notifica o contato via WhatsApp e agenda lembretes 10 min antes para ambos.
 */
async function handleScheduleMeeting(
  userId: string,
  replyTo: string,
  text: string,
  userTz: string,
  agentName: string,
  userNickname: string | null,
  pushName: string,
  language: string,
): Promise<string> {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: userTz });

  // Extrai nome do contato — "com [o/a/os/as] NomeProprio"
  // Aceita artigos opcionais: "com o Guilherme", "com a Maria", "com guilherme" (minúsculo)
  const contactMatch = text.match(/com\s+(?:o|a|os|as)\s+([A-Za-záéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+(?:\s+[A-Za-záéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+)*)/i)
    ?? text.match(/com\s+([A-Za-záéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+(?:\s+[A-Za-záéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+)*)/i);
  if (!contactMatch) {
    return "Não identifiquei com quem marcar a reunião. Tente: _Marca reunião com Guilherme amanhã às 14h_";
  }
  // Normaliza para Title Case: "GUILHERME" → "Guilherme", "guilherme" → "Guilherme"
  const contactName = contactMatch[1].split(/\s+/).map(w =>
    w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w
  ).join(" ");

  const { data: found } = await supabase
    .from("contacts")
    .select("*")
    .eq("user_id", userId)
    .ilike("name", `%${contactName}%`)
    .limit(1)
    .maybeSingle();

  if (!found) {
    // Contato não está salvo — cria evento de agenda normalmente com o nome como título
    const fallback = await handleAgendaCreate(userId, replyTo, text, null, language, userNickname, userTz);
    return fallback.response;
  }

  // Extrai data/hora usando extractEvent (IA)
  let extracted: Awaited<ReturnType<typeof extractEvent>>;
  try {
    extracted = await extractEvent(text, today, language);
  } catch {
    return "Não consegui entender a data. Tente: _Marca reunião com [Nome] amanhã às 14h_";
  }

  if (!extracted?.date) {
    return `Para marcar com *${found.name}*, me diga a data e hora. Ex: _amanhã às 14h_ ou _sexta às 10h_`;
  }

  const title = `Reunião com ${found.name}`;
  const description = `Reunião agendada pela ${agentName} — assistente de ${userNickname || pushName}`;

  // Cria evento no Google Calendar com Google Meet
  const { eventId, meetLink } = await createCalendarEventWithMeet(
    userId, title, extracted.date, extracted.time ?? null, null, description
  );

  // Salva na tabela events
  await supabase.from("events").insert({
    user_id: userId,
    title,
    event_date: extracted.date,
    event_time: extracted.time ?? null,
    description,
    status: "confirmed",
    google_event_id: eventId ?? null,
    source: "whatsapp_meeting",
  });

  // Agenda lembretes 10 min antes (se tiver horário)
  if (extracted.time) {
    try {
      const meetingDt = new Date(`${extracted.date}T${extracted.time}:00`);
      const reminderAt = new Date(meetingDt.getTime() - 10 * 60_000).toISOString();
      const meetSuffix = meetLink ? `\n\n🔗 ${meetLink}` : "";

      await supabase.from("reminders").insert([
        {
          user_id: userId,
          whatsapp_number: replyTo,
          title: `Reunião com ${found.name} em 10 min`,
          message: `⏰ *Lembrete!*\nDaqui 10 minutos você tem reunião com *${found.name}*${meetSuffix}`,
          send_at: reminderAt,
          recurrence: "none",
          status: "pending",
          source: "meeting_reminder",
        },
        {
          user_id: userId,
          whatsapp_number: found.phone,
          title: `Lembrete reunião em 10 min`,
          message: `⏰ *Lembrete, ${found.name.split(" ")[0]}!*\n\nDaqui 10 minutos você tem reunião com *${userNickname || pushName}*!${meetSuffix}\n\n_— ${agentName}, assistente virtual de ${userNickname || pushName}_`,
          send_at: reminderAt,
          recurrence: "none",
          status: "pending",
          source: "meeting_reminder_contact",
        },
      ]);
    } catch (e) {
      console.error("[schedule_meeting] reminder insert error:", e);
    }
  }

  // Busca telefone real do usuário para o CTA
  const { data: userProfile } = await supabase
    .from("profiles")
    .select("phone_number")
    .eq("id", userId)
    .maybeSingle();
  const userPhone = phoneForDisplay(userProfile?.phone_number ?? replyTo);

  // Notifica o contato via WhatsApp — mensagem criativa com CTA
  const dateLabel = formatDateBR(extracted.date);
  const timeLabel = extracted.time ? ` às *${extracted.time}*` : "";
  const contactFirstName = found.name.split(" ")[0];
  const senderName = userNickname || pushName || "seu contato";
  const contactMsg =
    `Olá, *${contactFirstName}*! 👋\n\n` +
    `Aqui é a *${agentName}*, assistente virtual de *${senderName}*.\n\n` +
    `Ele(a) pediu para marcar uma reunião com você:\n\n` +
    `📅 *${dateLabel}*${timeLabel}` +
    (meetLink ? `\n🔗 *Link da reunião:*\n${meetLink}` : "") +
    buildMayaCTA(senderName, userPhone);

  sendText(found.phone, contactMsg).catch(() => {});

  // Resposta ao usuário
  let response =
    `✅ Reunião agendada com *${found.name}*!\n\n` +
    `📅 ${dateLabel}${timeLabel}`;
  if (meetLink) response += `\n\n🔗 *Link Meet:*\n${meetLink}`;
  response +=
    `\n\n📱 Mandei o convite para *${found.name}* pelo WhatsApp` +
    (extracted.time ? " e vou lembrar vocês 10 minutos antes. ⏰" : ".");

  return response;
}

const CATEGORY_EMOJI: Record<string, string> = {
  alimentacao: "🍔",
  transporte: "🚗",
  moradia: "🏠",
  saude: "💊",
  lazer: "🎮",
  educacao: "📚",
  trabalho: "💼",
  outros: "📦",
};

function fmtBRL(value: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function docTypeLabel(dt: StatementExtraction["document_type"]): string {
  switch (dt) {
    case "extrato":    return "Extrato Bancário";
    case "fatura":     return "Fatura do Cartão";
    case "nota_fiscal": return "Nota Fiscal";
    case "comprovante": return "Comprovante";
    default:           return "Documento";
  }
}

function buildStatementPreview(extraction: StatementExtraction): string {
  const { document_type, institution, period, transactions, total_expense, total_income } = extraction;
  const count = transactions.length;
  const header = `📊 *${docTypeLabel(document_type)}${institution ? ` — ${institution}` : ""}${period ? ` ${period}` : ""}*\nEncontrei *${count} transação(ões)*:\n`;

  const preview = transactions.slice(0, 8).map(t => {
    const dot = t.type === "expense" ? "🔴" : "🟢";
    const catEmoji = CATEGORY_EMOJI[t.category] ?? "📦";
    return `${dot} ${t.description} R$ ${fmtBRL(t.amount)} (${catEmoji} ${t.category})`;
  }).join("\n");

  const remaining = count > 8 ? `\n_+ ${count - 8} mais..._` : "";

  const totals = [
    `\n💸 Total gastos: *R$ ${fmtBRL(total_expense)}*`,
    total_income > 0 ? `💰 Total receitas: *R$ ${fmtBRL(total_income)}*` : "",
  ].filter(Boolean).join("\n");

  return `${header}\n${preview}${remaining}\n${totals}\n\nConfirmar registro de *todas as ${count} transações*?\nResponda *sim* para salvar ou *não* para cancelar.`;
}

async function handleStatementConfirm(
  userId: string,
  phone: string,
  message: string,
  session: Record<string, unknown>
): Promise<{ response: string; pendingAction?: string; pendingContext?: unknown }> {
  const ctx = (session?.pending_context ?? {}) as Record<string, unknown>;
  const transactions = (ctx.transactions ?? []) as StatementExtraction["transactions"];
  const total_expense = (ctx.total_expense ?? 0) as number;
  const total_income = (ctx.total_income ?? 0) as number;

  const m = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (/^(sim|confirmar|salvar|ok|yes|pode|confirmo|salvo)/.test(m)) {
    if (transactions.length === 0) {
      return { response: "Não há transações para salvar. Envie uma nova imagem." };
    }

    const today = new Date().toLocaleDateString("sv-SE");
    const rows = transactions.map(t => ({
      user_id: userId,
      type: t.type,
      amount: t.amount,
      category: t.category,
      description: t.description,
      transaction_date: t.date || today,
      source: "whatsapp_image",
    }));

    const { error } = await supabase.from("transactions").insert(rows);
    if (error) {
      console.error("handleStatementConfirm insert error:", error);
      return { response: "⚠️ Erro ao salvar as transações. Tente novamente enviando a imagem." };
    }

    const count = transactions.length;
    const net = total_income - total_expense;
    const netSign = net >= 0 ? "+" : "-";
    const netFormatted = `${netSign}R$ ${fmtBRL(Math.abs(net))}`;

    const successMsg = [
      `✅ *${count} transação(ões) registrada(s) com sucesso!*`,
      ``,
      `💸 Gastos: R$ ${fmtBRL(total_expense)}`,
      total_income > 0 ? `💰 Receitas: R$ ${fmtBRL(total_income)}` : null,
      `💵 Líquido: ${netFormatted}`,
      ``,
      `Tudo salvo! Para ver o resumo completo, acesse o dashboard ou me peça: _"relatório financeiro"_ 📊`,
    ].filter(line => line !== null).join("\n");

    return { response: successMsg, pendingAction: undefined, pendingContext: undefined };

  } else if (/^(nao|não|cancela|cancelar|cancel|no\b)/.test(m)) {
    return { response: "Ok, cancelado! Nada foi registrado. 🗑️", pendingAction: undefined, pendingContext: undefined };
  } else {
    return {
      response: "Responda *sim* para confirmar o registro ou *não* para cancelar.",
      pendingAction: "statement_import",
      pendingContext: ctx,
    };
  }
}

async function processImageMessage(
  replyTo: string,
  base64: string,
  mimetype: string,
  lid: string | null,
  messageId: string | undefined,
  pushName: string,
  isForwarded = false,
  caption = ""
): Promise<unknown> {
  const log: string[] = ["image_processing"];
  if (isForwarded) log.push("forwarded");
  if (caption) log.push(`caption: ${caption.slice(0, 60)}`);
  try {
    // 1. Extract using smart statement analysis (passa caption como hint para o Vision)
    const extraction = await extractStatementFromImage(base64, mimetype, caption);
    log.push(`doc_type: ${extraction.document_type}, tx_count: ${extraction.transactions.length}`);

    // 2. Normalize phone for profile lookup and session key
    const phone = replyTo.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");

    // 3. Unknown or no transactions
    if (extraction.document_type === "unknown" || extraction.transactions.length === 0) {
      log.push("not_a_financial_doc");
      // Se encaminhada e nao financeira → salva como nota silenciosa
      if (isForwarded) {
        const { data: pf } = await supabase.from("profiles").select("id, phone_number")
          .or(`phone_number.eq.${phone},phone_number.eq.+${phone}`).maybeSingle();
        if (pf) {
          await supabase.from("notes").insert({
            user_id: pf.id, title: "Imagem encaminhada", content: "[Imagem recebida via encaminhamento — não identificada como documento financeiro]", source: "whatsapp_forward",
          });
          await sendText(pf.phone_number ?? replyTo, "📷 Recebi a imagem encaminhada — salvei como anotação. [📨 encaminhado]");
        }
        return log;
      }
      const { data: profileBasic } = await supabase
        .from("profiles")
        .select("phone_number")
        .or(`phone_number.eq.${phone},phone_number.eq.+${phone}`)
        .maybeSingle();
      const sendPhone = profileBasic?.phone_number ?? replyTo;
      await sendText(
        sendPhone || replyTo,
        "📷 Recebi a imagem! Não identifiquei um extrato ou nota fiscal.\n\nPosso registrar:\n• 📄 *Extrato bancário* — foto do app ou PDF\n• 💳 *Fatura do cartão* — com lista de compras\n• 🧾 *Nota fiscal / cupom*\n• 📱 *Comprovante* de PIX, TED ou boleto\n\nOu me diga por texto: _gastei R$50 de almoço_"
      );
      return log;
    }

    // 4. Resolve full profile (same multi-fallback pattern as processMessage)
    let profile: { id: string; phone_number: string; account_status: string } | null = null;

    if (lid) {
      const { data } = await supabase
        .from("profiles")
        .select("id, phone_number, account_status")
        .eq("whatsapp_lid", lid)
        .maybeSingle();
      profile = data;
    }
    if (!profile) {
      const { data } = await supabase
        .from("profiles")
        .select("id, phone_number, account_status")
        .or(`phone_number.eq.${phone},phone_number.eq.+${phone}`)
        .maybeSingle();
      profile = data;
    }

    if (!profile) {
      log.push("unknown_number");
      await sendText(replyTo, "Para processar seu extrato, vincule seu número no app Minha Maya primeiro.");
      return log;
    }

    const sendPhone = profile.phone_number?.replace(/\D/g, "") ?? phone;
    const sessionId = profile.phone_number?.replace(/\D/g, "") || phone;

    // 5. Single transaction (nota_fiscal or comprovante with 1 item) — save directly
    if (extraction.transactions.length === 1) {
      const t = extraction.transactions[0];
      const today = new Date().toLocaleDateString("sv-SE");
      await supabase.from("transactions").insert({
        user_id: profile.id,
        type: t.type,
        amount: t.amount,
        category: t.category,
        description: t.description,
        transaction_date: t.date || today,
        source: "whatsapp_image",
      });
      const dot = t.type === "expense" ? "🔴" : "🟢";
      const catEmoji = CATEGORY_EMOJI[t.category] ?? "📦";
      const confirmMsg = `✅ *${docTypeLabel(extraction.document_type)} registrado!*\n\n${dot} ${t.description}\n${catEmoji} Categoria: ${t.category}\n💵 Valor: R$ ${fmtBRL(t.amount)}\n\nSalvo com sucesso! 🎉`;
      await sendText(sendPhone || replyTo, confirmMsg);
      log.push("single_tx_saved");
      return log;
    }

    // 6. Multiple transactions — build preview and store pending confirmation
    const preview = buildStatementPreview(extraction);

    await supabase.from("whatsapp_sessions").upsert(
      {
        user_id: profile.id,
        phone_number: sessionId,
        pending_action: "statement_import",
        pending_context: {
          step: "statement_confirm",
          transactions: extraction.transactions,
          document_type: extraction.document_type,
          institution: extraction.institution,
          period: extraction.period,
          total_expense: extraction.total_expense,
          total_income: extraction.total_income,
        },
        last_activity: new Date().toISOString(),
        last_processed_id: messageId ?? null,
      },
      { onConflict: "phone_number" }
    );

    await sendText(sendPhone || replyTo, preview);
    log.push("preview_sent");
    return log;

  } catch (err) {
    log.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    console.error("processImageMessage error:", err);
    return log;
  }
}

function getHumanizedError(intent: string): string {
  switch (intent) {
    case "reminder_set":    return "⚠️ Não consegui salvar seu lembrete. Pode tentar de novo? Ex: _Me lembra de ligar amanhã às 10h_";
    case "reminder_cancel": return "⚠️ Não consegui cancelar o lembrete agora. Tente de novo em instantes.";
    case "reminder_edit":   return "⚠️ Não consegui editar o lembrete. Tente de novo com mais detalhes.";
    case "reminder_list":   return "⚠️ Não consegui buscar seus lembretes. Tente de novo em instantes.";
    case "agenda_create":   return "⚠️ Não consegui salvar esse compromisso. Pode repetir com data e horário? Ex: _Reunião amanhã às 15h_";
    case "agenda_query":    return "⚠️ Não consegui consultar sua agenda agora. Tente de novo em instantes.";
    case "agenda_edit":     return "⚠️ Não consegui alterar o compromisso. Tente de novo com mais detalhes.";
    case "agenda_delete":   return "⚠️ Não consegui remover o compromisso. Tente de novo em instantes.";
    case "notes_save":      return "⚠️ Não consegui salvar sua anotação. Pode tentar de novo?";
    case "finance_record":  return "⚠️ Não consegui registrar essa transação. Tente de novo. Ex: _Gastei 50 reais de almoço_";
    case "budget_set":       return "⚠️ Não consegui definir o orçamento. Ex: _quero gastar no máximo 2000 em alimentação_";
    case "budget_query":     return "⚠️ Não consegui consultar seus orçamentos. Tente de novo.";
    case "recurring_create": return "⚠️ Não consegui criar a recorrente. Ex: _aluguel 1500 todo dia 5_";
    case "habit_create":     return "⚠️ Não consegui criar o hábito. Ex: _quero hábito de exercício todo dia às 7h_";
    case "habit_checkin":    return "⚠️ Não consegui registrar. Tente enviar _feito_ quando completar um hábito.";
    case "finance_report":  return "⚠️ Não consegui gerar o relatório financeiro agora. Tente de novo em instantes.";
    default:                return "⚠️ Ops, algo deu errado por aqui. Pode tentar de novo? 🙏";
  }
}

/** Registra metrica de performance do bot (fire-and-forget, nunca lanca erro) */
async function logMetric(
  userId: string,
  intent: string,
  processingTimeMs: number,
  success: boolean,
  errorType?: string,
  messageLength?: number
): Promise<void> {
  try {
    await (supabase.from("bot_metrics" as any) as any).insert({
      user_id: userId,
      intent,
      processing_time_ms: processingTimeMs,
      success,
      error_type: errorType ?? null,
      message_length: messageLength ?? null,
    });
  } catch { /* silencioso — nao deve quebrar o fluxo principal */ }
}

async function processMessage(replyTo: string, text: string, lid: string | null = null, messageId?: string, pushName = "", _originalText?: string): Promise<unknown> {
  const log: string[] = [];
  const t0 = Date.now(); // timing para bot_metrics
  let currentIntent = "";
  try {
    // ── Fluxo de vinculação: usuário enviou código MAYA-XXXXXX ──
    const linkMatch = text.trim().match(/^MAYA[-\s]?([A-Z0-9]{6})$/i);
    if (linkMatch) {
      const code = linkMatch[1].toUpperCase();
      log.push(`link_attempt: ${code}`);

      const { data: profileByCode } = await supabase
        .from("profiles")
        .select("id, link_code_expires_at")
        .eq("link_code", code)
        .maybeSingle();

      if (!profileByCode) {
        await sendText(replyTo, "❌ Código inválido. Gere um novo código no app Minha Maya.");
        return log;
      }

      if (profileByCode.link_code_expires_at && new Date(profileByCode.link_code_expires_at) < new Date()) {
        await sendText(replyTo, "⏰ Código expirado. Gere um novo no app Minha Maya.");
        return log;
      }

      // Salva LID e limpa código
      await supabase.from("profiles").update({
        whatsapp_lid: lid ?? replyTo,
        link_code: null,
        link_code_expires_at: null,
      }).eq("id", profileByCode.id);

      await sendText(replyTo, "✅ *WhatsApp vinculado com sucesso!*\nAgora pode usar a Minha Maya normalmente. Tente: *gastei 50 reais de almoço*");
      log.push("linked!");
      return log;
    }

    // ── Busca perfil por LID (novo WhatsApp) ou telefone (fallback) ──
    let profile: { id: string; plan: string; messages_used: number; messages_limit: number; phone_number: string; account_status: string; timezone: string | null; access_until: string | null } | null = null;

    if (lid) {
      const { data } = await supabase
        .from("profiles")
        .select("id, plan, messages_used, messages_limit, phone_number, account_status, timezone, access_until")
        .eq("whatsapp_lid", lid)
        .maybeSingle();
      profile = data;
    }

    if (!profile) {
      // Fallback: tenta por telefone (@s.whatsapp.net ou @lid → extrai dígitos)
      const phone = replyTo
        .replace(/@s\.whatsapp\.net$/, "")
        .replace(/@lid$/, "")
        .replace(/:\d+$/, "");
      const { data } = await supabase
        .from("profiles")
        .select("id, plan, messages_used, messages_limit, phone_number, account_status, timezone, access_until")
        .or(`phone_number.eq.${phone},phone_number.eq.+${phone}`)
        .maybeSingle();
      profile = data;
    }

    // Fallback adicional: busca em user_phone_numbers (múltiplos números - plano business)
    if (!profile) {
      const phone = replyTo
        .replace(/@s\.whatsapp\.net$/, "")
        .replace(/@lid$/, "")
        .replace(/:\d+$/, "");
      const { data: extraNum } = await supabase
        .from("user_phone_numbers")
        .select("user_id")
        .or(`phone_number.eq.${phone},phone_number.eq.+${phone}`)
        .maybeSingle();
      if (extraNum?.user_id) {
        const { data } = await supabase
          .from("profiles")
          .select("id, plan, messages_used, messages_limit, phone_number, account_status, timezone, access_until")
          .eq("id", extraNum.user_id)
          .maybeSingle();
        profile = data;
      }
    }

    // Fallback por resolução de LID → telefone real via Evolution API
    // Útil quando o usuário tem WhatsApp Multi-Device e ainda não vinculou o LID
    if (!profile && lid) {
      const resolvedPhone = await resolveLidToPhone(lid);
      if (resolvedPhone) {
        const { data } = await supabase
          .from("profiles")
          .select("id, plan, messages_used, messages_limit, phone_number, account_status, timezone, access_until")
          .or(
            `phone_number.eq.${resolvedPhone},phone_number.eq.+${resolvedPhone},phone_number.eq.55${resolvedPhone}`
          )
          .maybeSingle();
        if (data) {
          profile = data;
          // Salva o LID no perfil automaticamente para lookups futuros (sem precisar de código MAYA)
          supabase
            .from("profiles")
            .update({ whatsapp_lid: lid })
            .eq("id", data.id)
            .then(() => {})
            .catch(() => {});
          log.push(`lid_auto_linked: ${lid} → ${resolvedPhone}`);
        }
      }
    }

    if (!profile) {
      // Número não cadastrado em nenhum dashboard → silêncio total (sem resposta)
      log.push("unknown_number");
      return log;
    }

    // Usa o telefone do perfil para enviar respostas (LID não funciona no sendText)
    const sendPhone = profile.phone_number?.replace(/\D/g, "") ?? "";

    // 2. Verifica se a conta está ativa
    if (profile.account_status === "suspended") {
      await sendText(
        sendPhone || replyTo,
        "🚫 *Acesso suspenso*\n\nSua conta na Minha Maya está suspensa devido a um estorno ou reembolso confirmado.\n\nSe acredita que isso é um engano, ou deseja reativar sua assinatura, acesse:\n👉 *minhamaya.com*"
      );
      log.push("account_suspended");
      return log;
    }

    if (profile.account_status === "pending") {
      await sendText(
        sendPhone || replyTo,
        "⏳ *Conta aguardando ativação*\n\nSua conta ainda não foi ativada.\n\nSe você já realizou sua assinatura, acesse o app e salve seu número de WhatsApp para ativar automaticamente.\n\n👉 *minhamaya.com*"
      );
      return log;
    }

    // 2b. Verifica se o período de acesso expirou (assinatura cancelada que estava em grace period)
    if (profile.access_until) {
      const accessUntilDate = new Date(profile.access_until);
      if (!isNaN(accessUntilDate.getTime()) && accessUntilDate < new Date()) {
        // Período expirou → suspende a conta automaticamente e avisa
        supabase.from("profiles")
          .update({ account_status: "suspended", access_until: null })
          .eq("id", profile.id)
          .then(() => {}).catch(() => {});
        supabase.from("agent_configs")
          .update({ is_active: false })
          .eq("user_id", profile.id)
          .then(() => {}).catch(() => {});

        await sendText(
          sendPhone || replyTo,
          "⏰ *Sua assinatura expirou*\n\nSeu período de acesso à Minha Maya chegou ao fim.\n\nRenove sua assinatura para voltar a usar a Maya normalmente:\n👉 *minhamaya.com*"
        );
        log.push("access_expired");
        return log;
      }
    }

    // 3. Carrega configuração do agente
    const { data: config } = await supabase
      .from("agent_configs")
      .select("*")
      .eq("user_id", profile.id)
      .maybeSingle();

    // 3b. Verifica se o agente está ativo (toggle do dashboard)
    // is_active === false significa que o usuário pausou manualmente → silêncio total
    if (config?.is_active === false) {
      log.push("agent_paused");
      return log;
    }

    const agentName = config?.agent_name ?? "Maya";
    const tone = config?.tone ?? "profissional";
    const language = (config?.language as string) || "pt-BR";
    const userNickname = (config?.user_nickname as string) || null;
    const customInstructions = (config?.custom_instructions as string) || null;
    const userTz = (profile.timezone as string) || "America/Sao_Paulo";
    const tzOffset = getTzOffset(userTz);

    // 4. Busca/cria sessão (contexto de conversa ativa)
    // Sempre usa o telefone do perfil como chave canônica para evitar sessões duplicadas
    // (LID do WhatsApp Web vs telefone real resultariam em sessões separadas sem isso)
    const sessionPhone = profile.phone_number?.replace(/\D/g, "") || (lid ?? replyTo);
    const sessionId = sessionPhone;

    // Busca sessão: tenta pelo telefone canônico OU pelo user_id (para migrar sessões antigas por LID)
    let { data: session } = await supabase
      .from("whatsapp_sessions")
      .select("*")
      .eq("phone_number", sessionId)
      .maybeSingle();

    if (!session) {
      // Fallback: busca qualquer sessão desse user (pode ter sido criada por LID diferente)
      const { data: sessionByUser } = await supabase
        .from("whatsapp_sessions")
        .select("*")
        .eq("user_id", profile.id)
        .order("last_activity", { ascending: false })
        .limit(1)
        .maybeSingle();
      session = sessionByUser;
    }

    // 4b. Verifica respostas rápidas (prioridade máxima)
    // Só dispara quando NÃO há fluxo multi-step pendente — evitar interromper agenda/nota/lembrete em andamento
    const hasPendingFlow = !!session?.pending_action;
    if (!hasPendingFlow) {
      const { data: quickReplies } = await supabase
        .from("quick_replies")
        .select("trigger_text, reply_text")
        .eq("user_id", profile.id);

      if (quickReplies?.length) {
        const textLower = text.toLowerCase().trim();
        const match = quickReplies.find((qr) =>
          textLower === qr.trigger_text.toLowerCase().trim() ||
          textLower.startsWith(qr.trigger_text.toLowerCase().trim())
        );
        if (match) {
          const reply = match.reply_text
            .replace("{{user_name}}", (config?.user_nickname as string) || "")
            .replace("{{agent_name}}", agentName);
          await sendText(sendPhone || replyTo, reply);
          log.push(`quick_reply: ${match.trigger_text}`);
          return log;
        }
      }
    }

    // 5. Classifica intenção
    let intent: Intent = classifyIntent(text);
    currentIntent = intent;

    // Se há ação pendente e a mensagem parece ser uma resposta, mantém o contexto
    // Exclui reminder_snooze pois é ação one-shot (não tem fluxo multi-step)
    const oneShot = ["reminder_snooze"];
    if (
      session?.pending_action &&
      !oneShot.includes(session.pending_action as string) &&
      intent === "ai_chat" &&
      text.length < 150
    ) {
      intent = session.pending_action as Intent;
      currentIntent = intent;
    }

    // Módulos ativos por padrão quando sem configuração
    const moduleFinance = config?.module_finance !== false;
    const moduleAgenda = config?.module_agenda !== false;
    const moduleNotes = config?.module_notes !== false;
    const moduleChat = config?.module_chat !== false;

    const modules: ModuleMap = { finance: moduleFinance, agenda: moduleAgenda, notes: moduleNotes, chat: moduleChat };

    // Mapa intent → módulo necessário
    const INTENT_REQUIRES: Partial<Record<Intent, keyof ModuleMap>> = {
      finance_record:    "finance",
      finance_report:    "finance",
      budget_set:        "finance",
      budget_query:      "finance",
      recurring_create:  "finance",
      agenda_create:   "agenda",
      agenda_query:    "agenda",
      agenda_lookup:   "agenda",
      agenda_edit:     "agenda",
      agenda_delete:   "agenda",
      event_followup:  "agenda",
      notes_save:      "notes",
      reminder_set:    "notes",
      reminder_list:   "notes",
      reminder_cancel: "notes",
      reminder_edit:   "notes",
      reminder_snooze: "notes",
      ai_chat:         "chat",
    };

    const requiredModule = INTENT_REQUIRES[intent];
    const moduleActive = !requiredModule || modules[requiredModule];

    // 6. Executa handler
    let responseText: string;
    let pendingAction: string | undefined;
    let pendingContext: unknown;

    if (intent === "greeting") {
      // Saudação: usa greeting_message personalizado do usuário ou fallback padrão
      const tplGreeting = (config?.greeting_message as string)
        || "Olá, {{user_name}}! Sou a {{agent_name}}, sua assistente pessoal. Como posso ajudar?";
      const greetName = userNickname || pushName || "você";
      responseText = applyTemplate(tplGreeting, {
        user_name: greetName,
        agent_name: agentName,
      });
      // Traduz se necessário (a template pode estar em PT mas usuário preferir EN/ES)
      if (language !== "pt-BR") {
        responseText = await translateIfNeeded(responseText, language);
      }
      await sendText(sendPhone || replyTo, responseText);
      log.push("greeting_sent");
      return log; // early return — não salva sessão pendente, não incrementa contador de módulos
    } else if (!moduleActive) {
      // ── Módulo desativado: informa o usuário e limpa fluxo pendente ──
      responseText = getModuleDisabledMsg(intent, language, modules);
      pendingAction = undefined;   // evita usuário preso em fluxo de módulo desativado
      pendingContext = undefined;
    } else if (intent === "budget_set") {
      responseText = await handleBudgetSet(profile.id, text);
    } else if (intent === "budget_query") {
      responseText = await handleBudgetQuery(profile.id, text);
    } else if (intent === "recurring_create") {
      responseText = await handleRecurringCreate(profile.id, text);
    } else if (intent === "habit_create") {
      responseText = await handleHabitCreate(profile.id, sendPhone || replyTo, text, userTz);
    } else if (intent === "habit_checkin") {
      responseText = await handleHabitCheckin(profile.id, text, userTz);
    } else if (intent === "finance_record") {
      responseText = await handleFinanceRecord(profile.id, sendPhone || replyTo, text, config);
    } else if (intent === "finance_report") {
      const reportResult = await handleFinanceReport(profile.id, text);
      responseText = reportResult.text;
      // Envia grafico antes do texto (se disponivel)
      if (reportResult.chartUrl) {
        try {
          await sendImage(sendPhone || replyTo, reportResult.chartUrl, "", true);
        } catch (chartErr) {
          console.error("[finance_report] Failed to send chart:", chartErr);
        }
      }
    } else if (intent === "agenda_create") {
      const result = await handleAgendaCreate(profile.id, sendPhone || replyTo, text, session, language, userNickname, userTz);
      responseText = result.response;
      pendingAction = result.pendingAction;
      pendingContext = result.pendingContext;
    } else if (intent === "agenda_query") {
      responseText = await handleAgendaQuery(profile.id, text, userTz);
    } else if (intent === "agenda_lookup") {
      const result = await handleAgendaLookup(profile.id, text, userTz);
      responseText = result.response;
      pendingAction = result.pendingAction;
      pendingContext = result.pendingContext;
    } else if (intent === "agenda_edit") {
      const result = await handleAgendaEdit(profile.id, sendPhone || replyTo, text, session, userTz);
      responseText = result.response;
      pendingAction = result.pendingAction;
      pendingContext = result.pendingContext;
    } else if (intent === "agenda_delete") {
      responseText = await handleAgendaDelete(profile.id, text);
    } else if (intent === "notes_save") {
      const notesResult = await handleNotesSave(profile.id, sendPhone || replyTo, text, session, config, userTz);
      responseText = notesResult.response;
      pendingAction = notesResult.pendingAction;
      pendingContext = notesResult.pendingContext;
    } else if (intent === "reminder_list") {
      responseText = await handleReminderList(profile.id, language, userTz);
    } else if (intent === "reminder_cancel") {
      responseText = await handleReminderCancel(profile.id, text, language);
    } else if (intent === "reminder_edit") {
      responseText = await handleReminderEdit(profile.id, text, language, userTz);
    } else if (intent === "reminder_set") {
      const reminderResult = await handleReminderSet(profile.id, sendPhone || replyTo, text, session, language, userNickname, userTz);
      responseText = reminderResult.response;
      pendingAction = reminderResult.pendingAction;
      pendingContext = reminderResult.pendingContext;
    } else if (intent === "reminder_snooze") {
      responseText = await handleReminderSnooze(profile.id, sendPhone || replyTo, text, userTz);
    } else if (intent === "event_followup") {
      const followupResult = await handleEventFollowup(profile.id, sendPhone || replyTo, text, session ?? {});
      responseText = followupResult.response;
      pendingAction = followupResult.pendingAction;
      pendingContext = followupResult.pendingContext;
    } else if (intent === "statement_import") {
      const stmtResult = await handleStatementConfirm(profile.id, sendPhone || replyTo, text, session ?? {});
      responseText = stmtResult.response;
      pendingAction = stmtResult.pendingAction;
      pendingContext = stmtResult.pendingContext;

    } else if (intent === "shadow_finance_confirm") {
      const ctx = (session?.pending_context ?? {}) as Record<string, unknown>;
      const msgLow = text.toLowerCase();
      if (text === "BUTTON:SHADOW_FIN_YES" || /^(1|sim|confirmar|registrar|ok)\b/.test(msgLow)) {
        const txDate = (ctx.date as string) || new Date().toLocaleDateString("sv-SE", { timeZone: userTz });
        await supabase.from("transactions").insert({
          user_id: profile.id,
          type: ctx.type || "expense",
          amount: ctx.amount,
          category: ctx.category || "outros",
          description: ctx.description || "Encaminhado",
          transaction_date: txDate,
          source: "whatsapp_forward",
        });
        const emoji = ctx.type === "income" ? "🟢" : "🔴";
        const catEm = CATEGORY_EMOJI[(ctx.category as string) ?? "outros"] ?? "📦";
        responseText = `${emoji} Registrado: R$ ${fmtBRL(ctx.amount as number)} — ${ctx.description || "encaminhado"} (${catEm} ${ctx.category || "outros"}) [📨 encaminhado]`;
      } else {
        responseText = "Ok, ignorei essa transação. 🗑️";
      }
      pendingAction = undefined;
      pendingContext = undefined;

    } else if (intent === "shadow_event_confirm") {
      const ctx = (session?.pending_context ?? {}) as Record<string, unknown>;
      const msgLow = text.toLowerCase();
      if (text === "BUTTON:SHADOW_EVT_YES" || /^(1|sim|criar|confirmar|ok)\b/.test(msgLow)) {
        await supabase.from("events").insert({
          user_id: profile.id,
          title: ctx.title || "Evento encaminhado",
          event_date: ctx.date ?? null,
          event_time: ctx.time ?? null,
          status: "confirmed",
          source: "whatsapp_forward",
        });
        const dateStr = ctx.date ? ` — ${ctx.date}` : "";
        const timeStr = ctx.time ? ` às ${ctx.time}` : "";
        responseText = `✅ Evento criado: *${ctx.title || "Evento encaminhado"}*${dateStr}${timeStr} [📨 encaminhado]`;
        syncGoogleCalendar(profile.id, ctx.title as string, ctx.date as string, (ctx.time as string) ?? null).catch(() => {});
      } else {
        responseText = "Ok, ignorei o evento. 🗑️";
      }
      pendingAction = undefined;
      pendingContext = undefined;

    } else if (intent === "shadow_reminder_confirm") {
      const ctx = (session?.pending_context ?? {}) as Record<string, unknown>;
      const msgLow = text.toLowerCase();
      if (text === "BUTTON:SHADOW_REM_YES" || /^(1|sim|criar|confirmar|ok)\b/.test(msgLow)) {
        const remindAt = ctx.remind_at
          ? new Date(ctx.remind_at as string)
          : new Date(Date.now() + 24 * 60 * 60 * 1000);
        await supabase.from("reminders").insert({
          user_id: profile.id,
          whatsapp_number: sendPhone || replyTo,
          title: (ctx.title as string) || "Lembrete encaminhado",
          message: `🔔 *Lembrete!*\n${(ctx.title as string) || "Lembrete encaminhado"}`,
          send_at: remindAt.toISOString(),
          recurrence: "none",
          source: "whatsapp_forward",
          status: "pending",
        });
        responseText = `✅ Lembrete criado: *${ctx.title || "Lembrete encaminhado"}* [📨 encaminhado]`;
      } else {
        responseText = "Ok, ignorei o lembrete. 🗑️";
      }
      pendingAction = undefined;
      pendingContext = undefined;

    } else if (intent === "contact_save") {
      // Salvar contato digitado: "salva o contato João 11999999999"
      // Extrai nome
      const nameMatchCS = text.match(
        /(?:contato|numero|telefone)\s+(?:d[oa]\s+)?([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+)*)|(?:salva|adiciona)\s+(?:o\s+)?([A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ][a-záéíóúâêîôûãõç]+)/i
      );
      const nameCS = (nameMatchCS?.[1] ?? nameMatchCS?.[2] ?? "").trim();
      // Extrai telefone — qualquer sequência de dígitos com 8+ dígitos
      const phoneMatchCS = text.match(/\b(\d[\d\s\-().]{7,}\d)\b/);
      let phoneCS = phoneMatchCS ? phoneMatchCS[1].replace(/\D/g, "") : "";
      if (phoneCS && !phoneCS.startsWith("55") && phoneCS.length <= 11) phoneCS = `55${phoneCS}`;

      if (!nameCS || !phoneCS) {
        responseText = `Para salvar um contato, me diga o nome e o número:\n_"Salva o contato João: 11 99999-9999"_\n\nOu compartilhe o contato direto da agenda do WhatsApp! 📇`;
      } else {
        const phoneDisplayCS = phoneForDisplay(phoneCS);
        const sessionId = profile.phone_number?.replace(/\D/g, "") || (sendPhone || replyTo).replace(/\D/g, "");
        await sendButtons(
          sendPhone || replyTo,
          "📇 Salvar contato?",
          `*${nameCS}*\n📱 ${phoneDisplayCS}\n\nConfirma salvar nos seus contatos?`,
          [
            { id: `CONTACT_SAVE_YES|${nameCS}|${phoneCS}`, text: "💾 Salvar" },
            { id: "CONTACT_SAVE_NO",                        text: "❌ Não" },
          ]
        );
        await supabase.from("whatsapp_sessions").upsert({
          user_id: profile.id, phone_number: sessionId,
          pending_action: "contact_save_confirm",
          pending_context: { name: nameCS, phone: phoneCS },
          last_activity: new Date().toISOString(),
        }, { onConflict: "phone_number" });
        responseText = ""; // botão já enviado
      }

    } else if (intent === "contact_save_confirm") {
      // Usuário clicou em "💾 Salvar" ou "❌ Ignorar" após detectar contato
      const ctx = (session?.pending_context ?? {}) as Record<string, unknown>;

      // Extrai nome e phone do botão (formato "CONTACT_SAVE_YES|Nome|phone")
      // ou do pending_context como fallback
      let csName = (ctx.name as string) || "";
      let csPhone = (ctx.phone as string) || "";
      const btnParts = text.replace("BUTTON:", "").split("|");
      if (btnParts[0] === "CONTACT_SAVE_YES" && btnParts[1]) {
        csName = btnParts[1];
        csPhone = btnParts[2] ?? csPhone;
      }

      const isYes =
        text.startsWith("BUTTON:CONTACT_SAVE_YES") ||
        /^(1|sim|salvar|salva|confirmar|ok|yes)\b/i.test(text);

      if (isYes && csName && csPhone) {
        const { error } = await supabase.from("contacts").upsert(
          { user_id: profile.id, name: csName, phone: csPhone, source: "whatsapp" },
          { onConflict: "user_id,phone" }
        );
        const firstName = csName.split(" ")[0];
        responseText = error
          ? `⚠️ Erro ao salvar. Tente de novo.`
          : `✅ *${csName}* salvo nos seus contatos!\n\nAgora pode pedir:\n• _"Manda mensagem pro ${firstName} dizendo..."_\n• _"Marca reunião com ${firstName} amanhã às 14h"_`;
      } else {
        responseText = "Ok, contato não salvo. 👍";
      }
      pendingAction = undefined;
      pendingContext = undefined;

    } else if (intent === "reminder_delegate") {
      // Resposta à pergunta "Quem envia?" disparada pelo send-reminder quando o
      // lembrete continha um "enviar pro X..." — usuário escolhe Maya ou ele mesmo.
      const ctx = (session?.pending_context ?? {}) as Record<string, unknown>;
      const contactText = (ctx.contact_text as string) ?? "";
      const msgLow = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      const mayaSends =
        text === "BUTTON:DELEGATE_MAYA" ||
        /^(1|maya|pode|voce envia|pode enviar|maya envia|pode ser|manda voce|envia voce|sim)\b/i.test(msgLow);
      const meSends =
        text === "BUTTON:DELEGATE_ME" ||
        /^(2|eu|eu mesmo|eu envio|vou eu|nao|deixa que eu|eu mando)\b/i.test(msgLow);

      if (mayaSends && contactText) {
        // Maya executa o envio — reutiliza handleSendToContact com o texto original do lembrete
        responseText = await handleSendToContact(
          profile.id, sendPhone || replyTo, contactText, userTz, agentName, userNickname, pushName
        );
      } else if (meSends) {
        responseText = "Ok, você envia! ✌️ Me avisa se precisar de mais alguma coisa.";
      } else {
        // Não reconheceu — repete a pergunta
        const opts =
          `Quem envia essa mensagem?\n\n` +
          `*1.* 🤖 Maya envia\n` +
          `*2.* ✉️ Eu mesmo envio`;
        responseText = opts;
      }
      pendingAction = undefined;
      pendingContext = undefined;

    } else if (intent === "list_contacts") {
      const { data: allContacts } = await supabase
        .from("contacts")
        .select("name, phone_number")
        .eq("user_id", profile.id)
        .order("name", { ascending: true });
      if (!allContacts || allContacts.length === 0) {
        responseText = "Você ainda não tem contatos salvos na Maya. 📇\n\nCompartilhe um contato comigo ou diga _\"Salva o contato [Nome]: [número]\"_";
      } else {
        const lines = allContacts.map((c: any) => `• *${c.name}*`).join("\n");
        responseText = `📇 *Seus contatos salvos (${allContacts.length}):*\n\n${lines}\n\nPara enviar mensagem: _"Manda pra [Nome] dizendo..."_`;
      }

    } else if (intent === "send_to_contact") {
      responseText = await handleSendToContact(
        profile.id, sendPhone || replyTo, text, userTz, agentName, userNickname, pushName
      );

    } else if (intent === "schedule_meeting") {
      responseText = await handleScheduleMeeting(
        profile.id, sendPhone || replyTo, text, userTz, agentName, userNickname, pushName, language
      );

    } else {
      // Chat geral com IA (moduleChat já verificado acima via moduleActive)
      // Informa à IA quais módulos estão ativos/inativos para consistência
      const moduleContext = [
        `Módulos ativos: ${[moduleFinance && "Financeiro", moduleAgenda && "Agenda", moduleNotes && "Anotações/Lembretes", "Conversa livre"].filter(Boolean).join(", ")}.`,
        !moduleFinance ? "O módulo Financeiro está DESATIVADO — se o usuário pedir registro de gastos, diga que o módulo está desativado e peça para ativar no painel." : "",
        !moduleAgenda  ? "O módulo Agenda está DESATIVADO — se o usuário pedir agenda ou compromissos, diga que o módulo está desativado e peça para ativar no painel." : "",
        !moduleNotes   ? "O módulo Anotações/Lembretes está DESATIVADO — se o usuário pedir anotações ou lembretes, diga que o módulo está desativado e peça para ativar no painel." : "",
      ].filter(Boolean).join(" ");
      const enrichedInstructions = [customInstructions, moduleContext].filter(Boolean).join("\n\n");
      const history = await getRecentHistory(profile.id);
      responseText = await assistantChat(text, agentName, tone, language, userNickname, enrichedInstructions, history);
    }

    // 7. Traduz resposta se necessário e envia
    // (responseText vazio indica que um botão interativo já foi enviado pelo handler)
    if (responseText) {
      if (language !== "pt-BR") {
        responseText = await translateIfNeeded(responseText, language);
      }
      try {
        await sendText(sendPhone || replyTo, responseText);
      } catch (sendErr) {
        console.error("[processMessage] sendText failed, queuing for retry:", sendErr);
        await queueMessage(sendPhone || replyTo, responseText, profile.id);
      }
    }

    // 8. Atualiza sessão
    await supabase.from("whatsapp_sessions").upsert(
      {
        user_id: profile.id,
        phone_number: sessionId,
        pending_action: pendingAction ?? null,
        pending_context: pendingContext ?? null,
        last_activity: new Date().toISOString(),
        last_processed_id: messageId ?? null,
      },
      { onConflict: "phone_number" }
    );

    // 9. Salva mensagens na conversa
    // Pula registro de conversa quando responseText esta vazio (botoes interativos ja enviados pelo handler)
    if (responseText) {
      await saveConversation(profile.id, lid, sendPhone, pushName, text, responseText, intent);
    }

    // 10. Incrementa contador de mensagens
    await supabase
      .from("profiles")
      .update({ messages_used: profile.messages_used + 1 })
      .eq("id", profile.id);

    // 11. Registra metrica de performance (fire-and-forget)
    logMetric(profile.id, currentIntent || "ai_chat", Date.now() - t0, true, undefined, text.length).catch(() => {});

    log.push("success");
    return log;
  } catch (err) {
    const { message, stack } = fromThrown(err);
    log.push(`ERROR: ${message}`);
    await logError({
      context: "whatsapp-webhook/processMessage",
      message,
      stack,
      phone_number: replyTo.replace(/@.*$/, ""),
      metadata: { lid, messageId },
    });
    // Registra metrica de erro se temos profile (busca por phone_number, nao por id)
    try {
      const errPhone = replyTo.replace(/@.*$/, "").replace(/:\d+$/, "");
      const { data: pErr } = await supabase.from("profiles").select("id")
        .or(`phone_number.eq.${errPhone},phone_number.eq.+${errPhone}`)
        .maybeSingle();
      if (pErr?.id) logMetric(pErr.id, currentIntent || "unknown", Date.now() - t0, false, message.slice(0, 100)).catch(() => {});
    } catch { /* ignora */ }
    try {
      const humanizedError = getHumanizedError(currentIntent);
      await sendText(replyTo, humanizedError);
    } catch { /* ignora erro no fallback */ }
    return log;
  }
}

async function getRecentHistory(userId: string): Promise<ChatMessage[]> {
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conv) return [];

  const { data: msgs } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(10);

  return (msgs ?? []).reverse() as ChatMessage[];
}

async function saveConversation(
  userId: string,
  lid: string | null,
  phoneNumber: string,
  contactName: string,
  userText: string,
  assistantText: string,
  intent: string
): Promise<void> {
  // Busca conversa existente: por LID (se disponível) ou por user_id
  let { data: conv } = await supabase
    .from("conversations")
    .select("id, message_count")
    .eq("user_id", userId)
    .eq(lid ? "whatsapp_lid" : "phone_number", lid ?? phoneNumber)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conv) {
    const { data: newConv } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        phone_number: phoneNumber,
        whatsapp_lid: lid ?? null,
        contact_name: contactName || null,
      })
      .select()
      .single();
    conv = newConv;
  } else {
    // Atualiza nome se mudou
    if (contactName) {
      await supabase
        .from("conversations")
        .update({ contact_name: contactName })
        .eq("id", conv.id);
    }
  }

  if (!conv) return;

  // Formata texto de botão para log legível
  const displayUserText = userText.startsWith("BUTTON:")
    ? `[Botão: ${userText.replace("BUTTON:", "").replace(/_/g, " ")}]`
    : userText;

  await supabase.from("messages").insert([
    { conversation_id: conv.id, role: "user", content: displayUserText, intent },
    { conversation_id: conv.id, role: "assistant", content: assistantText },
  ]);

  await supabase
    .from("conversations")
    .update({
      message_count: (conv.message_count ?? 0) + 2,
      last_message_at: new Date().toISOString(),
    })
    .eq("id", conv.id);
}

