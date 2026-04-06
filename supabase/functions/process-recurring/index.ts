/**
 * process-recurring
 * Chamado via pg_cron diariamente às 06:00.
 * Processa transações recorrentes que vencem hoje ou antes.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendText } from "../_shared/evolution.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  const internalSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!authHeader.includes(internalSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const today = new Date().toISOString().split("T")[0];
  let processed = 0;

  // Busca todas as recorrentes ativas com next_date <= hoje
  const { data: recurring } = await supabase
    .from("recurring_transactions")
    .select("*, profiles(phone_number, display_name)")
    .eq("active", true)
    .lte("next_date", today);

  for (const rec of recurring ?? []) {
    try {
      // Cria a transação
      await supabase.from("transactions").insert({
        user_id: rec.user_id,
        description: rec.description,
        amount: rec.amount,
        type: rec.type,
        category: rec.category,
        transaction_date: rec.next_date,
        source: "recurring",
      });

      // Calcula próxima data
      const next = calcNextDate(rec.next_date, rec.frequency);
      await supabase
        .from("recurring_transactions")
        .update({ next_date: next, last_processed: today })
        .eq("id", rec.id);

      // Notifica o usuário via WhatsApp (se tiver número)
      const phone = rec.profiles?.phone_number?.replace(/\D/g, "");
      if (phone) {
        const emoji = rec.type === "expense" ? "🔴" : "🟢";
        const typeLabel = rec.type === "expense" ? "Gasto" : "Receita";
        await sendText(phone,
          `${emoji} *${typeLabel} recorrente registrado!*\n📝 ${rec.description}\n💰 R$ ${Number(rec.amount).toFixed(2).replace(".", ",")}\n🔁 Próxima: ${formatDate(next)}`
        );
      }

      processed++;
    } catch (e) {
      console.error(`Error processing recurring ${rec.id}:`, e);
    }
  }

  return new Response(JSON.stringify({ ok: true, processed }), {
    headers: { "Content-Type": "application/json" },
  });
});

function calcNextDate(currentDate: string, frequency: string): string {
  const d = new Date(currentDate + "T12:00:00");
  switch (frequency) {
    case "daily":   d.setDate(d.getDate() + 1); break;
    case "weekly":  d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly":  d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().split("T")[0];
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("pt-BR", {
    day: "numeric", month: "long",
  });
}
