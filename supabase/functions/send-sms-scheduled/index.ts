// supabase/functions/send-sms-scheduled/index.ts
// 매일 10:00 KST GitHub Actions cron이 호출.
// sms_scheduled에서 due_at <= NOW() AND status='pending' 조회 → 일괄 발송.
// send_once 템플릿은 동일 receiver+template 이력 있으면 skip.
// 보호: x-cron-secret 헤더가 app_secrets.CRON_SECRET 와 일치해야 함.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function jsonResp(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function smsByteLen(s: string): number {
  let n = 0; for (const ch of String(s)) n += ch.charCodeAt(0) > 127 ? 2 : 1; return n;
}

async function makeSolapiAuth(apiKey: string, apiSecret: string): Promise<string> {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const cKey = await crypto.subtle.importKey("raw", enc.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cKey, enc.encode(date + salt));
  const signature = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: secrets } = await supabaseAdmin
      .from("app_secrets").select("key, value")
      .in("key", ["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER", "ALIGO_SENDER", "CRON_SECRET"]);
    const map: Record<string, string> = {};
    for (const r of (secrets || [])) map[r.key] = r.value;

    const expectedSecret = map.CRON_SECRET;
    const headerSecret = req.headers.get("x-cron-secret") || "";
    if (expectedSecret && headerSecret !== expectedSecret) {
      return jsonResp({ ok: false, error: "unauthorized" }, 401);
    }

    const SOLAPI_API_KEY = map.SOLAPI_API_KEY;
    const SOLAPI_API_SECRET = map.SOLAPI_API_SECRET;
    const SENDER = map.SOLAPI_SENDER || map.ALIGO_SENDER;
    if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET || !SENDER) {
      return jsonResp({ ok: false, error: "secrets 누락" }, 500);
    }

    const { data: due, error: dueErr } = await supabaseAdmin
      .from("sms_scheduled")
      .select("id, template_id, related_table, related_id, receiver, receiver_name, msg, msg_type, title")
      .eq("status", "pending")
      .lte("due_at", new Date().toISOString())
      .limit(200);
    if (dueErr) return jsonResp({ ok: false, error: dueErr.message }, 500);

    let sent = 0, failed = 0, skipped = 0;
    const results: any[] = [];

    for (const row of (due || [])) {
      // send_once 체크
      let shouldSkip = false;
      if (row.template_id) {
        const { data: tplInfo } = await supabaseAdmin
          .from("sms_templates").select("send_once").eq("id", row.template_id).maybeSingle();
        if (tplInfo?.send_once) {
          const { count } = await supabaseAdmin
            .from("sms_logs")
            .select("id", { count: "exact", head: true })
            .eq("template_id", row.template_id)
            .eq("receiver", row.receiver)
            .gt("result_code", 0);
          if ((count || 0) > 0) shouldSkip = true;
        }
      }

      if (shouldSkip) {
        await supabaseAdmin.from("sms_scheduled").update({
          status: "skipped_duplicate", sent_at: new Date().toISOString(),
        }).eq("id", row.id);
        skipped++;
        results.push({ id: row.id, status: "skipped_duplicate" });
        continue;
      }

      // Solapi 발송
      let msgType = row.msg_type && row.msg_type !== "auto" ? row.msg_type : (smsByteLen(row.msg) > 90 ? "LMS" : "SMS");
      if (msgType !== "LMS" && msgType !== "MMS") msgType = "SMS";
      const message: any = { to: row.receiver, from: SENDER, text: row.msg, type: msgType };
      if (msgType !== "SMS" && row.title) message.subject = row.title;

      const auth = await makeSolapiAuth(SOLAPI_API_KEY, SOLAPI_API_SECRET);
      let solapiResult: any = {};
      let httpStatus = 0;
      try {
        const r = await fetch("https://api.solapi.com/messages/v4/send", {
          method: "POST",
          headers: { "Authorization": auth, "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        httpStatus = r.status;
        solapiResult = await r.json();
      } catch (e) {
        solapiResult = { error: { message: (e as Error).message } };
      }

      const ok = httpStatus >= 200 && httpStatus < 300 && (solapiResult.messageId || solapiResult.groupId);
      const errMsg = ok ? null : (solapiResult.errorMessage || solapiResult.message || solapiResult.error?.message || `HTTP ${httpStatus}`);

      const logRow = {
        sender: SENDER,
        receiver: row.receiver,
        receiver_name: row.receiver_name,
        msg_type: msgType,
        title: row.title,
        msg: row.msg,
        result_code: ok ? 1 : -1,
        result_message: (errMsg || "자동 발송 성공").toString().slice(0, 1000),
        msg_id: solapiResult.messageId || solapiResult.groupId || null,
        sent_by: null,
        template_id: row.template_id,
        related_table: row.related_table,
        related_id: row.related_id,
      };
      const logResp = await supabaseAdmin.from("sms_logs").insert(logRow).select("id").single();

      await supabaseAdmin.from("sms_scheduled").update({
        status: ok ? "sent" : "failed",
        sent_at: new Date().toISOString(),
        error: ok ? null : errMsg,
        sms_log_id: logResp.data?.id || null,
      }).eq("id", row.id);

      if (ok) sent++; else failed++;
      results.push({ id: row.id, status: ok ? "sent" : "failed", error: errMsg });
    }

    return jsonResp({ ok: true, summary: { total: due?.length || 0, sent, failed, skipped }, results });
  } catch (e) {
    return jsonResp({ ok: false, error: `서버 오류: ${(e as Error).message}` }, 500);
  }
});
