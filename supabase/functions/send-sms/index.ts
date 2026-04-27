// supabase/functions/send-sms/index.ts v7 — Solapi 운영 버전
// 비밀값은 app_secrets 테이블에서 로드:
//   SOLAPI_API_KEY / SOLAPI_API_SECRET / SOLAPI_SENDER (또는 ALIGO_SENDER 폴백)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function normalizePhone(p: string): string { return (p || "").replace(/[^0-9]/g, ""); }
function smsByteLen(s: string): number {
  let n = 0;
  for (const ch of String(s)) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

async function makeSolapiAuth(apiKey: string, apiSecret: string): Promise<string> {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(date + salt));
  const signature = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: secrets } = await supabaseAdmin
      .from("app_secrets").select("key, value")
      .in("key", ["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER", "ALIGO_SENDER"]);
    const map: Record<string, string> = {};
    for (const r of (secrets || [])) map[r.key] = r.value;
    const SOLAPI_API_KEY = map.SOLAPI_API_KEY;
    const SOLAPI_API_SECRET = map.SOLAPI_API_SECRET;
    const SENDER = map.SOLAPI_SENDER || map.ALIGO_SENDER;

    if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET || !SENDER) {
      return jsonResp({ ok: false, error: "필수 secret 누락 (SOLAPI_API_KEY/SECRET/SENDER)" }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return jsonResp({ ok: false, error: "인증 헤더 없음" }, 401);
    const jwt = authHeader.replace("Bearer ", "");
    const { data: userResp, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userResp?.user) return jsonResp({ ok: false, error: "유효하지 않은 세션" }, 401);
    const userId = userResp.user.id;

    let body: any;
    try { body = await req.json(); }
    catch { return jsonResp({ ok: false, error: "JSON 본문 파싱 실패" }, 400); }

    const receiver = normalizePhone(body.receiver || "");
    const msg = (body.msg || "").trim();
    if (!receiver || receiver.length < 10) return jsonResp({ ok: false, error: "수신번호 오류" }, 400);
    if (!msg) return jsonResp({ ok: false, error: "메시지 본문 없음" }, 400);
    if (msg.length > 2000) return jsonResp({ ok: false, error: "메시지 2000자 초과" }, 400);

    let msgType = (body.msg_type && body.msg_type !== "auto")
      ? body.msg_type
      : (smsByteLen(msg) > 90 ? "LMS" : "SMS");
    if (msgType !== "LMS" && msgType !== "MMS") msgType = "SMS";

    const message: any = { to: receiver, from: SENDER, text: msg, type: msgType };
    if (msgType !== "SMS" && body.title) message.subject = body.title;

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
      solapiResult = { error: { code: "NetworkError", message: (e as Error).message } };
    }

    const okResult = httpStatus >= 200 && httpStatus < 300 && (solapiResult.messageId || solapiResult.groupId);
    const errMsg = okResult ? null : (
      solapiResult.errorMessage || solapiResult.message || solapiResult.error?.message || `HTTP ${httpStatus}`
    );

    const logRow = {
      sender: SENDER,
      receiver,
      receiver_name: body.receiver_name || null,
      msg_type: msgType,
      title: message.subject || null,
      msg,
      result_code: okResult ? 1 : -1,
      result_message: (errMsg || "정상 접수").toString().slice(0, 1000),
      msg_id: solapiResult.messageId || solapiResult.groupId || null,
      sent_by: userId,
      template_id: body.template_id || null,
      related_table: body.related_table || null,
      related_id: body.related_id || null,
    };

    const { data: logInserted } = await supabaseAdmin
      .from("sms_logs").insert(logRow).select("id").single();

    return jsonResp({
      ok: okResult,
      result_code: okResult ? 1 : -1,
      message: okResult ? "발송 성공" : errMsg,
      msg_id: solapiResult.messageId || solapiResult.groupId,
      sent_log_id: logInserted?.id || null,
      provider: "solapi",
      error: okResult ? null : errMsg,
    });
  } catch (e) {
    return jsonResp({ ok: false, error: `서버 오류: ${(e as Error).message}` }, 500);
  }
});
