import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SubmitEntryBody {
  full_name: string;
  email: string;
  area_code?: string | null;
  phone_number?: string | null;
  full_phone?: string | null;
  number_of_adults: number;
  number_of_children?: number;
  reason: string;
  reason_other?: string | null;
  sponsorships: string[];
  cans_quantity: number;
  comments?: string | null;
  email_updates_opt_in?: boolean;
  wants_to_donate?: boolean;
  verification_token: string;
  verification_sent_at: string;
}

// Reusable Brevo email sending function
async function sendBrevoEmail({
  toEmail,
  toName,
  subject,
  html,
}: {
  toEmail: string;
  toName: string;
  subject: string;
  html: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const apiKey = Deno.env.get("BREVO_API_KEY");
    if (!apiKey) {
      throw new Error("Missing BREVO_API_KEY");
    }

    const payload = {
      sender: { name: "Chabad of Westville", email: "rabbi@chabadwestville.org" },
      to: [{ email: toEmail, name: toName }],
      subject,
      htmlContent: html,
    };

    console.log(`[brevo] Attempting to send email to ${toEmail}...`);

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[brevo] API error: ${response.status} - ${errorText}`);
      return { success: false, error: `Brevo API error: ${response.status}` };
    }
    
    console.log(`[brevo] Email sent successfully to ${toEmail}`);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[brevo] Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

// Registration-only email template (no payment)
function renderRegistrationOnlyTemplate(fullName: string): string {
  return `Hi ${fullName},<br/><br/>
Thank you so much for signing up for Menorah in the Village, we can't wait to celebrate with you!<br/><br/>
📍 <strong>Location:</strong> The Central Ave Patio<br/>
882 Whalley Avenue, New Haven, CT 06515<br/>
🕔 <strong>Event Start Time:</strong> 4:00 PM<br/>
📅 <strong>Date:</strong> December 14<br/><br/>
Your participation helps bring warmth and light to our whole community.<br/><br/>
To help spread the light even further, would you consider forwarding the event sign-up to friends and family?<br/><br/>
Here's the link: <a href="https://menorah.chabadwestville.org">https://menorah.chabadwestville.org</a><br/><br/>
If you have any questions at all, feel free to reach out anytime.<br/>
Looking forward to celebrating together!<br/><br/>
Warmly,<br/>
Rabbi Chanoch & Mushka Wineberg<br/>
Chabad of Westville<br/>
<a href="https://chabadwestville.org">chabadwestville.org</a>`;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    const body = (await req.json()) as Partial<SubmitEntryBody>;

    // Minimal validation of required fields
    if (!body.full_name || !body.email || !body.reason || !body.verification_token || !body.verification_sent_at || body.number_of_adults === undefined) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }

    // Compute full_phone if not provided but parts are
    let full_phone = body.full_phone ?? null;
    if (!full_phone && body.area_code && body.phone_number) {
      full_phone = `${body.area_code}${body.phone_number}`;
    }

    // Prepare insert payload
    const insertPayload = {
      full_name: body.full_name.trim(),
      email: body.email.trim().toLowerCase(),
      area_code: body.area_code?.trim() ?? null,
      phone_number: body.phone_number?.trim() ?? null,
      full_phone,
      number_of_adults: body.number_of_adults,
      number_of_children: body.number_of_children ?? 0,
      reason: body.reason,
      reason_other: body.reason_other?.trim() ?? null,
      sponsorships: body.sponsorships ?? [],
      cans_quantity: body.cans_quantity ?? 0,
      comments: body.comments?.trim() ?? null,
      email_updates_opt_in: body.email_updates_opt_in ?? false,
      wants_to_donate: body.wants_to_donate ?? false,
      verification_token: body.verification_token,
      verification_sent_at: body.verification_sent_at,
      payment_status: body.wants_to_donate ? "pending" : "none",
    };

    const { data, error } = await supabaseAdmin
      .from("form_submissions")
      .insert(insertPayload)
      .select("id")
      .single();

    if (error) {
      console.error("[submit-form-entry] Insert error:", error);
      return new Response(
        JSON.stringify({ error: "Insert failed" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    // Send registration confirmation email only for NON-donors
    // Donors will receive their combined email after payment success
    if (!body.wants_to_donate) {
      const emailResult = await sendBrevoEmail({
        toEmail: body.email.trim().toLowerCase(),
        toName: body.full_name.trim(),
        subject: "You're Registered for Menorah in the Westville Village!",
        html: renderRegistrationOnlyTemplate(body.full_name.trim()),
      });
      
      if (!emailResult.success) {
        console.error("[submit-form-entry] Registration email failed:", emailResult.error);
      }
    }

    return new Response(JSON.stringify({ id: data.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("[submit-form-entry] Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Unexpected error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
