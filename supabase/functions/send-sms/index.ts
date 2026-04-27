// supabase/functions/send-sms/index.ts v3
// 알리고(Aligo) SMS 발송 Edge Function
// ───────────────────────────────────
// 비밀값은 app_secrets 테이블에서 로드 (service_role 전용 RLS):
//   ALIGO_USER_ID / ALIGO_API_KEY / ALIGO_SENDER

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(p: string): string {
  return (p || "").replace(/[^0-9]/g, "");
}

async function loadSecrets(supabaseAdmin: any): Promise<Record<string, string>> {
  const { data, error } = await supabaseAdmin
    .from("app_secrets")
    .select("key, value")
    .in("key", ["ALIGO_USER_ID", "ALIGO_API_KEY", "ALIGO_SENDER"]);
  if (error) throw new Error("app_secrets 조회 실패: " + error.message);
  const map: Record<string, string> = {};
  for (const r of (data || [])) map[r.key] = r.value;
  return map;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const secrets = await loadSecrets(supabaseAdmin);
    const ALIGO_USER_ID = secrets.ALIGO_USER_ID;
    const ALIGO_API_KEY = secrets.ALIGO_API_KEY;
    const ALIGO_SENDER = secrets.ALIGO_SENDER;

    if (!ALIGO_USER_ID || !ALIGO_API_KEY || !ALIGO_SENDER) {
      return jsonResp(
        {
          ok: false,
          error: "app_secrets 테이블에 ALIGO_USER_ID / ALIGO_API_KEY / ALIGO_SENDER 를 등록하세요.",
        },
        500,
      );
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResp({ ok: false, error: "인증 헤더 없음" }, 401);
    }
    const jwt = authHeader.replace("Bearer ", "");

    const { data: userResp, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userResp?.user) {
      return jsonResp({ ok: false, error: "유효하지 않은 세션" }, 401);
    }
    const userId = userResp.user.id;

    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResp({ ok: false, error: "JSON 본문 파싱 실패" }, 400);
    }
    const receiver = normalizePhone(body.receiver || "");
    const msg = (body.msg || "").trim();

    if (!receiver) return jsonResp({ ok: false, error: "수신번호 없음" }, 400);
    if (receiver.length < 10) {
      return jsonResp({ ok: false, error: "수신번호 형식 오류" }, 400);
    }
    if (!msg) return jsonResp({ ok: false, error: "메시지 본문 없음" }, 400);
    if (msg.length > 2000) {
      return jsonResp({ ok: false, error: "메시지가 2000자를 초과합니다" }, 400);
    }

    const formData = new FormData();
    formData.append("user_id", ALIGO_USER_ID);
    formData.append("key", ALIGO_API_KEY);
    formData.append("sender", ALIGO_SENDER);
    formData.append("receiver", receiver);
    formData.append("msg", msg);
    if (body.msg_type && body.msg_type !== "auto") {
      formData.append("msg_type", body.msg_type);
    }
    if (body.title) formData.append("title", body.title);
    formData.append("testmode_yn", "N");

    let aligoResult: any = {};
    try {
      const aligoResp = await fetch("https://apis.aligo.in/send/", {
        method: "POST",
        body: formData,
      });
      aligoResult = await aligoResp.json();
    } catch (e) {
      aligoResult = {
        result_code: -999,
        message: `알리고 API 호출 실패: ${(e as Error).message}`,
      };
    }

    const okResult =
      typeof aligoResult.result_code === "number" &&
      aligoResult.result_code > 0;

    const logRow = {
      sender: ALIGO_SENDER,
      receiver,
      receiver_name: body.receiver_name || null,
      msg_type: body.msg_type || "auto",
      title: body.title || null,
      msg,
      result_code: aligoResult.result_code ?? null,
      result_message: aligoResult.message ?? null,
      msg_id: aligoResult.msg_id ? String(aligoResult.msg_id) : null,
      sent_by: userId,
      template_id: body.template_id || null,
      related_table: body.related_table || null,
      related_id: body.related_id || null,
    };

    const { data: logInserted, error: logErr } = await supabaseAdmin
      .from("sms_logs")
      .insert(logRow)
      .select("id")
      .single();

    if (logErr) {
      console.error("sms_logs insert failed:", logErr);
    }

    return jsonResp({
      ok: okResult,
      result_code: aligoResult.result_code,
      message: aligoResult.message,
      msg_id: aligoResult.msg_id,
      sent_log_id: logInserted?.id || null,
      error: okResult ? null : aligoResult.message || "발송 실패",
    });
  } catch (e) {
    return jsonResp(
      { ok: false, error: `서버 오류: ${(e as Error).message}` },
      500,
    );
  }
});
