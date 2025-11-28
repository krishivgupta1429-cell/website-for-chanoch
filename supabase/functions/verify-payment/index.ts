import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper logging function
const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[VERIFY-PAYMENT-LIVE] ${step}${detailsStr}`);
};

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

// Registration + Donation email template (payment success)
function renderRegistrationAndDonationTemplate(data: {
  fullName: string;
  amountCents: number;
  sponsorships: string[];
  cansQuantity: number;
  donationDate: string;
  referenceId: string;
}): string {
  // Format amount from cents to dollars
  const amountDollars = data.amountCents / 100;
  const formattedAmount = Number.isInteger(amountDollars)
    ? `$${amountDollars}`
    : `$${amountDollars.toFixed(2)}`;

  // Format donation date in America/New_York timezone
  const date = new Date(data.donationDate);
  const formattedDate = date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });

  // Format sponsorships
  const sponsorshipText = data.sponsorships && data.sponsorships.length > 0
    ? data.sponsorships.join(", ")
    : "";

  // Build donation details section
  const donationDetails: string[] = [];
  
  if (sponsorshipText) {
    donationDetails.push(`• ${formattedAmount} — ${sponsorshipText}`);
  } else {
    donationDetails.push(`• ${formattedAmount}`);
  }
  
  if (data.cansQuantity > 0) {
    donationDetails.push(`• ${data.cansQuantity} cans sponsored`);
  }
  
  donationDetails.push(`• Date: ${formattedDate}`);
  donationDetails.push(`• Reference id: ${data.referenceId}`);

  return `Hi ${data.fullName},<br/><br/>
Thank you so much for signing up and contributing to the Menorah in the Village, we can't wait to celebrate with you!<br/><br/>
📍 <strong>Location:</strong> The Central Ave Patio<br/>
882 Whalley Avenue, New Haven, CT 06515<br/>
🕔 <strong>Event Start Time:</strong> 4:00 PM<br/>
📅 <strong>Date:</strong> December 14<br/><br/>
Your participation helps bring warmth and light to our whole community.<br/><br/>
(For any can drop offs, we'll reach out to arrange a time and location.)<br/><br/>
<strong>Donation Acknowledgment:</strong><br/><br/>
We are also truly grateful for your generous support of Menorah in the Westville Village. Your contribution helps build our Menorah of Cans and brings light and compassion to those in need throughout Westville and New Haven.<br/><br/>
<strong>Donation Details</strong><br/>
${donationDetails.join("<br/>")}<br/><br/>
Your partnership makes a heartfelt difference. Thank you for helping illuminate our community with kindness.<br/><br/>
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
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { session_id } = await req.json();

    logStep("Starting payment verification", { sessionId: session_id });

    if (!session_id) {
      logStep("ERROR: Missing session_id parameter");
      throw new Error("Missing session_id parameter");
    }

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      logStep("ERROR: STRIPE_SECRET_KEY not configured");
      throw new Error("Stripe not configured");
    }

    logStep("Using LIVE mode Stripe key");

    const stripe = new Stripe(stripeKey, {
      apiVersion: "2025-08-27.basil",
    });

    // Retrieve the checkout session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);
    logStep("Retrieved session from Stripe", {
      id: session.id,
      payment_status: session.payment_status,
      status: session.status,
      amount_total: session.amount_total,
      livemode: session.livemode,
    });

    // Initialize Supabase admin client
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Find the form submission by checkout session ID
    const { data: submission, error: findError } = await supabaseAdmin
      .from("form_submissions")
      .select("id, wants_to_donate, payment_status, full_name, email, cans_quantity, sponsorships, created_at")
      .eq("stripe_checkout_session_id", session_id)
      .maybeSingle();

    if (findError) {
      logStep("ERROR: Failed to find form submission", { error: findError });
      throw findError;
    }

    if (!submission) {
      logStep("ERROR: No form submission found", { sessionId: session_id });
      throw new Error("Form submission not found");
    }

    logStep("Found form submission", { 
      submissionId: submission.id,
      wantsToDonate: submission.wants_to_donate,
      currentStatus: submission.payment_status
    });

    // Only update if wants_to_donate is true
    if (!submission.wants_to_donate) {
      logStep("Submission does not want to donate, skipping update", { 
        submissionId: submission.id 
      });
      return new Response(
        JSON.stringify({
          payment_status: "none",
          message: "No donation requested",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    // Get payment intent details if available
    let paymentIntentId = null;
    if (session.payment_intent) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          session.payment_intent as string
        );
        paymentIntentId = paymentIntent.id;
        logStep("Payment intent retrieved", { 
          paymentIntentId, 
          status: paymentIntent.status 
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logStep("ERROR: Failed to retrieve payment intent", { error });
      }
    }

    // Determine payment status
    let paymentStatus = "pending";
    if (session.payment_status === "paid") {
      paymentStatus = "success";
    } else if (session.payment_status === "unpaid") {
      paymentStatus = "failed";
    }

    const amountInCents = session.amount_total || 0;

    logStep("Preparing to update form submission", {
      submissionId: submission.id,
      paymentStatus,
      amountInCents,
      paymentIntentId,
    });

    // Update the form submission
    const { error: updateError } = await supabaseAdmin
      .from("form_submissions")
      .update({
        is_donor: paymentStatus === "success",
        stripe_customer_id: session.customer as string || null,
        stripe_payment_intent_id: paymentIntentId,
        payment_amount_cents: amountInCents,
        payment_status: paymentStatus,
      })
      .eq("id", submission.id);

    if (updateError) {
      logStep("ERROR: Failed to update form submission", { 
        submissionId: submission.id,
        error: updateError 
      });
      throw updateError;
    }

    logStep("Successfully updated form submission", { 
      submissionId: submission.id,
      paymentStatus 
    });

    // Send combined confirmation + donation receipt email if payment was successful
    if (paymentStatus === "success") {
      logStep("Payment successful, sending combined donor confirmation email", {
        email: submission.email,
        amount: amountInCents
      });
      
      const emailResult = await sendBrevoEmail({
        toEmail: submission.email,
        toName: submission.full_name,
        subject: "You're Registered for Menorah in the Westville Village. Thank you for your donation!",
        html: renderRegistrationAndDonationTemplate({
          fullName: submission.full_name,
          amountCents: amountInCents,
          sponsorships: submission.sponsorships || [],
          cansQuantity: submission.cans_quantity || 0,
          donationDate: submission.created_at,
          referenceId: paymentIntentId || session_id,
        }),
      });

      if (!emailResult.success) {
        logStep("ERROR: Donor confirmation email failed", { error: emailResult.error });
      }
    }

    return new Response(
      JSON.stringify({
        payment_status: paymentStatus,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_email: session.customer_email,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    logStep("ERROR: Payment verification failed", { 
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined
    });
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
