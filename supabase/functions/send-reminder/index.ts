/**
 * send-reminder
 * Chamada pelo pg_cron a cada 1 minuto.
 * Busca lembretes pendentes cujo send_at <= agora e envia via WhatsApp.
 * Suporta recorrência: cria próxima ocorrência automaticamente.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendText } from "../_shared/evolution.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ─────────────────────────────────────────────
// Calcula a próxima data de um lembrete recorrente
// ─────────────────────────────────────────────
function nextOccurrence(
  current: Date,
  recurrence: string,
  recurrenceValue: number | null
): Date | null {
  const next = new Date(current);

  if (recurrence === "daily") {
    next.setDate(next.getDate() + 1);
    return next;
  }

  if (recurrence === "weekly") {
    // recurrenceValue = dia da semana (0=dom..6=sáb)
    const targetDay = recurrenceValue ?? current.getDay();
    next.setDate(next.getDate() + 7);
    // Ajusta para o dia correto da semana caso tenha desviado
    while (next.getDay() !== targetDay) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  if (recurrence === "monthly") {
    next.setMonth(next.getMonth() + 1);
    return next;
  }

  if (recurrence === "day_of_month") {
    // recurrenceValue = dia do mês (1-31)
    const day = recurrenceValue ?? current.getDate();
    next.setMonth(next.getMonth() + 1);
    // Garante o dia correto (tratando meses com menos dias)
    const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, maxDay));
    return next;
  }

  if (recurrence === "hourly") {
    // recurrenceValue = intervalo em horas (ex: 2 = a cada 2 horas)
    const hours = recurrenceValue ?? 1;
    next.setTime(next.getTime() + hours * 60 * 60 * 1000);
    return next;
  }

  return null; // "none" ou tipo desconhecido → sem próxima
}

serve(async (_req) => {
  // Auth desabilitada — função é chamada por pg_cron interno
  // verify_jwt = false no config.toml, URL obscura = segurança suficiente

  const now = new Date();
  const nowIso = now.toISOString();

  // Busca lembretes pendentes
  const { data: reminders, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "pending")
    .lte("send_at", nowIso)
    .limit(50);

  if (error) {
    console.error("Error fetching reminders:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  if (!reminders || reminders.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }));
  }

  let sent = 0;
  let failed = 0;
  let scheduled = 0;

  for (const reminder of reminders) {
    try {
      await sendText(reminder.whatsapp_number, reminder.message);

      // Marca como enviado
      await supabase
        .from("reminders")
        .update({ status: "sent", sent_at: now.toISOString() })
        .eq("id", reminder.id);

      sent++;

      // ─── Followup pós-evento: define pending_action na sessão do usuário ───
      if (reminder.source === "event_followup" && reminder.user_id && reminder.whatsapp_number) {
        let eventType = "compromisso";
        if (reminder.event_id) {
          const { data: ev } = await supabase
            .from("events")
            .select("event_type, event_date, event_time")
            .eq("id", reminder.event_id)
            .maybeSingle();
          if (ev) eventType = ev.event_type ?? "compromisso";
        }
        // Seta pending_action na sessão do WhatsApp para capturar resposta do usuário
        await supabase.from("whatsapp_sessions").upsert(
          {
            user_id: reminder.user_id,
            phone_number: reminder.whatsapp_number,
            pending_action: "event_followup",
            pending_context: {
              event_id: reminder.event_id ?? null,
              event_title: reminder.title ?? "",
              event_type: eventType,
            },
            last_activity: now.toISOString(),
          },
          { onConflict: "phone_number" }
        );
      }

      // ── Recorrência: agenda próxima ocorrência ──────────────────
      if (reminder.recurrence && reminder.recurrence !== "none") {
        const sendAt = new Date(reminder.send_at);
        const next = nextOccurrence(sendAt, reminder.recurrence, reminder.recurrence_value ?? null);

        if (next) {
          await supabase.from("reminders").insert({
            user_id: reminder.user_id,
            whatsapp_number: reminder.whatsapp_number,
            title: reminder.title,
            message: reminder.message,
            send_at: next.toISOString(),
            recurrence: reminder.recurrence,
            recurrence_value: reminder.recurrence_value,
            source: reminder.source ?? "whatsapp",
            status: "pending",
          });
          scheduled++;
        }
      }
    } catch (err) {
      console.error(`Failed to send reminder ${reminder.id}:`, err);

      await supabase
        .from("reminders")
        .update({ status: "failed" })
        .eq("id", reminder.id);

      failed++;
    }
  }

  console.log(`Reminders: ${sent} sent, ${failed} failed, ${scheduled} next scheduled`);
  return new Response(JSON.stringify({ sent, failed, scheduled }));
});
