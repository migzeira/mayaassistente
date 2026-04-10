import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendText } from "./evolution.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

/** Notifica o usuário via WhatsApp quando uma integração expira (fire-and-forget).
 *  Dedup: só envia 1x por dia por provider (usa integration.metadata.last_expiry_notification).
 *  Silencioso em caso de erro — nunca deve quebrar o fluxo principal. */
async function notifyIntegrationExpired(
  userId: string,
  provider: string,
  integrationId: string,
): Promise<void> {
  try {
    const { data: integ } = await supabase
      .from("integrations")
      .select("metadata")
      .eq("id", integrationId)
      .maybeSingle();
    const today = new Date().toISOString().slice(0, 10);
    const meta = (integ?.metadata ?? {}) as Record<string, unknown>;
    if (meta.last_expiry_notification === today) return; // já avisou hoje

    const { data: profile } = await supabase
      .from("profiles")
      .select("phone_number, display_name")
      .eq("id", userId)
      .maybeSingle();
    const phone = profile?.phone_number?.replace(/\D/g, "");
    if (!phone) return;

    const providerLabel =
      provider === "google_calendar" ? "Google Calendar" :
      provider === "google_sheets"   ? "Google Sheets" :
      provider === "notion"          ? "Notion" :
      provider;

    await sendText(
      phone,
      `⚠️ *Integração expirou*\n\nSua conexão com *${providerLabel}* expirou e foi desconectada automaticamente.\n\nReconecte em *Integrações* no app da Minha Maya pra voltar a sincronizar.`
    );

    // Marca dedup no metadata
    await supabase
      .from("integrations")
      .update({ metadata: { ...meta, last_expiry_notification: today } })
      .eq("id", integrationId);
  } catch (err) {
    console.warn("[notifyIntegrationExpired] failed:", err);
  }
}

/** Lê credencial do app_settings (fallback para env var) */
async function getSetting(key: string): Promise<string> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? Deno.env.get(key.toUpperCase()) ?? "";
}

/** Busca integração e renova token se necessário */
async function getIntegration(userId: string, provider: string) {
  const { data } = await supabase
    .from("integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("is_connected", true)
    .maybeSingle();

  if (!data?.access_token) return null;

  // Renova token Google se expirado (ou expira em menos de 60s)
  if (
    provider.startsWith("google") &&
    data.refresh_token &&
    data.expires_at &&
    new Date(data.expires_at) <= new Date(Date.now() + 60_000)
  ) {
    const googleClientId = await getSetting("google_client_id");
    const googleClientSecret = await getSetting("google_client_secret");

    if (!googleClientId || !googleClientSecret) {
      console.warn("Google credentials not configured in app_settings — skipping token refresh");
      return data;
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: data.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokens = await res.json();
    if (tokens.access_token && typeof tokens.expires_in === "number") {
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      await supabase
        .from("integrations")
        .update({ access_token: tokens.access_token, expires_at: expiresAt })
        .eq("id", data.id);
      data.access_token = tokens.access_token;
    } else if (tokens.error === "invalid_grant") {
      // Refresh token expirou — desconecta integração automaticamente e notifica usuário
      console.error("Google refresh token expired, disconnecting integration:", data.id);
      await supabase
        .from("integrations")
        .update({ is_connected: false, access_token: null, refresh_token: null })
        .eq("id", data.id);
      // Fire-and-forget: avisa o usuário que a integração foi desconectada
      notifyIntegrationExpired(userId, provider, data.id).catch(() => {});
      return null;
    } else {
      console.error("Google token refresh failed:", tokens.error_description ?? tokens.error);
    }
  }

  return data;
}

/** Cria evento no Google Calendar e retorna o google_event_id */
export async function syncGoogleCalendar(
  userId: string,
  title: string,
  date: string,
  time: string | null,
  endTime?: string | null,
  description?: string | null,
  location?: string | null,
  userTz: string = "America/Sao_Paulo"
): Promise<string | null> {
  const integration = await getIntegration(userId, "google_calendar");
  if (!integration) return null;

  const start = time
    ? { dateTime: `${date}T${time}:00`, timeZone: userTz }
    : { date };
  const end = endTime
    ? { dateTime: `${date}T${endTime}:00`, timeZone: userTz }
    : time
      ? { dateTime: `${date}T${time}:00`, timeZone: userTz }
      : { date };

  const body: Record<string, unknown> = { summary: title, start, end };
  if (description) body.description = description;
  if (location) body.location = location;

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (res.ok) {
    const data = await res.json();
    return data.id ?? null; // google_event_id
  }
  console.error("Google Calendar create error:", res.status, await res.text());
  return null;
}

/** Atualiza evento existente no Google Calendar */
export async function updateGoogleCalendar(
  userId: string,
  googleEventId: string,
  title: string,
  date: string,
  time: string | null,
  endTime?: string | null,
  description?: string | null,
  location?: string | null,
  userTz: string = "America/Sao_Paulo"
): Promise<boolean> {
  const integration = await getIntegration(userId, "google_calendar");
  if (!integration) return false;

  const start = time
    ? { dateTime: `${date}T${time}:00`, timeZone: userTz }
    : { date };
  const end = endTime
    ? { dateTime: `${date}T${endTime}:00`, timeZone: userTz }
    : time
      ? { dateTime: `${date}T${time}:00`, timeZone: userTz }
      : { date };

  const body: Record<string, unknown> = { summary: title, start, end };
  if (description) body.description = description;
  if (location) body.location = location;

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${integration.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    console.error("Google Calendar update error:", res.status, await res.text());
  }
  return res.ok;
}

/** Deleta evento do Google Calendar */
export async function deleteGoogleCalendar(
  userId: string,
  googleEventId: string
): Promise<boolean> {
  const integration = await getIntegration(userId, "google_calendar");
  if (!integration) return false;

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${integration.access_token}`,
      },
    }
  );

  if (!res.ok && res.status !== 410) { // 410 = already deleted
    console.error("Google Calendar delete error:", res.status, await res.text());
  }
  return res.ok || res.status === 410;
}

/**
 * Cria evento no Google Calendar com link do Google Meet.
 * Requer que o token OAuth tenha escopo calendar.events.
 * Retorna eventId e meetLink (null se Google Calendar não estiver conectado).
 */
export async function createCalendarEventWithMeet(
  userId: string,
  title: string,
  date: string,
  time: string | null,
  endTime?: string | null,
  description?: string | null,
  attendeeEmail?: string | null,
  userTz: string = "America/Sao_Paulo"
): Promise<{ eventId: string | null; meetLink: string | null }> {
  const integration = await getIntegration(userId, "google_calendar");
  if (!integration) return { eventId: null, meetLink: null };

  const start = time
    ? { dateTime: `${date}T${time}:00`, timeZone: userTz }
    : { date };

  // End: explicit endTime → use it; time but no endTime → default +1h; all-day → next day
  let end: Record<string, string>;
  if (endTime) {
    end = { dateTime: `${date}T${endTime}:00`, timeZone: userTz };
  } else if (time) {
    const [h, m] = time.split(":").map(Number);
    const endH = String((h + 1) % 24).padStart(2, "0");
    end = { dateTime: `${date}T${endH}:${String(m ?? 0).padStart(2, "0")}:00`, timeZone: userTz };
  } else {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    end = { date: d.toISOString().slice(0, 10) };
  }

  const body: Record<string, unknown> = {
    summary: title,
    start,
    end,
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
  if (description) body.description = description;
  if (attendeeEmail) body.attendees = [{ email: attendeeEmail }];

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    console.error("Google Calendar Meet create error:", res.status, await res.text());
    return { eventId: null, meetLink: null };
  }

  const data = await res.json() as Record<string, unknown>;
  const confData = data.conferenceData as Record<string, unknown> | undefined;
  const entryPoints = (confData?.entryPoints as Array<Record<string, unknown>>) ?? [];
  const meetLink = entryPoints.find(ep => ep.entryPointType === "video")?.uri as string ?? null;

  return { eventId: (data.id as string) ?? null, meetLink };
}

/** Adiciona linha ao Google Sheets */
export async function syncGoogleSheets(
  userId: string,
  row: { date: string; description: string; amount: number; type: string; category: string }
): Promise<void> {
  const integration = await getIntegration(userId, "google_sheets");
  if (!integration?.metadata?.sheet_id) return;

  const sheetId = integration.metadata.sheet_id;
  const values = [[
    row.date,
    row.description,
    row.type === "expense" ? `-${row.amount}` : `${row.amount}`,
    row.type === "expense" ? "Gasto" : "Receita",
    row.category,
  ]];

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:E:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values }),
    }
  );
}

/** Cria página no Notion */
export async function syncNotion(
  userId: string,
  content: string
): Promise<void> {
  const integration = await getIntegration(userId, "notion");
  if (!integration?.metadata?.database_id && !integration?.metadata?.page_id) return;

  const parentId = integration.metadata.database_id ?? integration.metadata.page_id;
  const parentType = integration.metadata.database_id ? "database_id" : "page_id";

  await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${integration.access_token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      parent: { [parentType]: parentId },
      properties: {
        title: {
          title: [{ text: { content: content.slice(0, 100) } }],
        },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ text: { content } }],
          },
        },
      ],
    }),
  });
}
