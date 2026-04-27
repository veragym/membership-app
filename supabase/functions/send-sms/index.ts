// supabase/functions/send-sms/index.ts
// 알리고(Aligo) SMS 발송 Edge Function
// ───────────────────────────────────
// 환경변수 (Supabase Secrets):
//   ALIGO_USER_ID      알리고 로그인 ID
//   ALIGO_API_KEY      알리고 API 키
//   ALIGO_SENDER       발신번호 (사전등록 필수, 하이픈 없이)
//
// 요청 (POST JSON):
//   {
//     "receiver":      "01012345678",
//     "receiver_name": "홍길동",
//     "msg":           "메시지 본문",
//     "msg_type":      "SMS" | "LMS" | "auto",   // 생략 시 auto (90byte 초과면 LMS)
//     "title":         "LMS/MMS 제목 (선택)",
//     "related_table": "inquiries" | "pt_registrations" | ... (선택),
//     "related_id":    "uuid" (선택)
//   }
//
// 응답:
//   { ok, result_code, message, msg_id, sent_log_id, error? }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface SendBody {
  receiver: string;
  receiver_name?: string;
  msg: string;
  msg_type?: "SMS" | "LMS" | "auto";
  title?: string;
  related_table?: string;
  related_id?: string;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(p: string): string {
  return (p || "").replace(/[^0-9]/g, "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ───── 1) 환경변수 검증 ─────
    const ALIGO_USER_ID = Deno.env.get("ALIGO_USER_ID");
    const ALIGO_API_KEY = Deno.env.get("ALIGO_API_KEY");
    const ALIGO_SENDER = Deno.env.get("ALIGO_SENDER");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    )!;

    if (!ALIGO_USER_ID || !ALIGO_API_KEY || !ALIGO_SENDER) {
      return jsonResp(
        {
          ok: false,
          error:
            "알리고 환경변수 미설정. ALIGO_USER_ID / ALIGO_API_KEY / ALIGO_SENDER 를 Supabase Secrets에 등록하세요.",
        },
        500,
      );
    }

    // ───── 2) 인증 사용자 확인 ─────
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResp({ ok: false, error: "인증 헤더 없음" }, 401);
    }
    const jwt = authHeader.replace("Bearer ", "");

    const supabaseAdmin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
    );
    const { data: userResp, error: userErr } = await supabaseAdmin.auth.getUser(
      jwt,
    );
    if (userErr || !userResp?.user) {
      return jsonResp({ ok: false, error: "유효하지 않은 세션" }, 401);
    }
    const userId = userResp.user.id;

    // ───── 3) 요청 파싱 + 검증 ─────
    let body: SendBody;
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

    // ───── 4) 알리고 API 호출 ─────
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
    formData.append("testmode_yn", "N"); // 명시적으로 실 발송

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

    // ───── 5) sms_logs 기록 ─────
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
