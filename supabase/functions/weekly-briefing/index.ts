/**
 * weekly-briefing
 * Chamado pelo pg_cron aos domingos às 23:00 UTC (20:00 BRT).
 * Envia um resumo da agenda da semana seguinte para cada usuário ativo.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendText } from "../_shared/evolution.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const EVENT_TYPE_EMOJIS: Record<string, string> = {
  compromisso: "📌",
  reuniao: "🤝",
  consulta: "🏥",
  evento: "🎉",
  tarefa: "✏️",
};

const WEEKDAY_PT = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

serve(async (_req) => {
  // Calcula próxima semana em BRT
  const nowBRT = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));

  // Próxima segunda-feira
  const daysUntilMonday = ((8 - nowBRT.getDay()) % 7) || 7;
  const nextMonday = new Date(nowBRT);
  nextMonday.setDate(nowBRT.getDate() + daysUntilMonday);

  // Próximo domingo
  const nextSunday = new Date(nextMonday);
  nextSunday.setDate(nextMonday.getDate() + 6);

  const startDate = nextMonday.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const endDate = nextSunday.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

  console.log(`[weekly-briefing] Week: ${startDate} → ${endDate}`);

  // Busca usuários ativos com briefing habilitado
  const { data: configs, error: configErr } = await supabase
    .from("agent_configs")
    .select("user_id, user_nickname, daily_briefing_enabled");

  if (configErr) {
    console.error("Error fetching configs:", configErr);
    return new Response(JSON.stringify({ error: configErr.message }), { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const cfg of configs ?? []) {
    // Respeita o toggle (daily_briefing_enabled controla ambos briefings)
    if (cfg.daily_briefing_enabled === false) { skipped++; continue; }

    try {
      // Busca número de telefone
      const { data: profile } = await supabase
        .from("profiles")
        .select("phone_number, account_status")
        .eq("id", cfg.user_id)
        .maybeSingle();

      if (!profile?.phone_number || profile.account_status !== "active") { skipped++; continue; }

      // Busca eventos da semana
      const { data: events } = await supabase
        .from("events")
        .select("title, event_date, event_time, end_time, event_type, location, status")
        .eq("user_id", cfg.user_id)
        .gte("event_date", startDate)
        .lte("event_date", endDate)
        .neq("status", "cancelled")
        .order("event_date", { ascending: true })
        .order("event_time", { ascending: true });

      const userName = (cfg.user_nickname as string) || "você";

      // Formata o período da semana
      const mondayFormatted = nextMonday.toLocaleDateString("pt-BR", { day: "numeric", month: "long" });
      const sundayFormatted = nextSunday.toLocaleDateString("pt-BR", { day: "numeric", month: "long" });

      let message: string;

      if (!events || events.length === 0) {
        message = `📅 *Olá, ${userName}!*\n\nSua semana de *${mondayFormatted} a ${sundayFormatted}* está livre!\n\nSe quiser, posso anotar compromissos, criar lembretes ou organizar sua agenda. É só me dizer. 😊`;
      } else {
        // Agrupa por data
        const grouped: Record<string, typeof events> = {};
        for (const ev of events) {
          if (!grouped[ev.event_date]) grouped[ev.event_date] = [];
          grouped[ev.event_date].push(ev);
        }

        const lines: string[] = [
          `📅 *Sua semana — ${mondayFormatted} a ${sundayFormatted}*`,
          `_(${events.length} compromisso${events.length > 1 ? "s" : ""})_\n`,
        ];

        for (const [dateKey, dayEvents] of Object.entries(grouped)) {
          const d = new Date(dateKey + "T12:00:00");
          const weekday = WEEKDAY_PT[d.getDay()];
          const dayFormatted = d.toLocaleDateString("pt-BR", { day: "numeric", month: "short" });
          lines.push(`*${weekday}, ${dayFormatted}*`);

          for (const ev of dayEvents) {
            const emoji = EVENT_TYPE_EMOJIS[ev.event_type] ?? "📌";
            const time = ev.event_time ? ` às ${ev.event_time.slice(0, 5)}` : "";
            const loc = ev.location ? ` · 📍 ${ev.location}` : "";
            lines.push(`  ${emoji} ${ev.title}${time}${loc}`);
          }
          lines.push("");
        }

        lines.push(`Tenha uma ótima semana, ${userName}! 💪`);
        message = lines.join("\n");
      }

      await sendText(profile.phone_number, message);

      // Registra como enviado
      await supabase.from("reminders").insert({
        user_id: cfg.user_id,
        whatsapp_number: profile.phone_number,
        title: "Resumo semanal",
        message: message.slice(0, 500),
        send_at: new Date().toISOString(),
        recurrence: "none",
        source: "weekly_briefing",
        status: "sent",
        sent_at: new Date().toISOString(),
      });

      sent++;
      console.log(`[weekly-briefing] ✅ Sent to user ${cfg.user_id}`);
    } catch (err) {
      failed++;
      console.error(`[weekly-briefing] ❌ Failed for user ${cfg.user_id}:`, err);
    }
  }

  const result = { sent, skipped, failed, week: `${startDate} → ${endDate}` };
  console.log("[weekly-briefing] Done:", result);
  return new Response(JSON.stringify(result));
});
