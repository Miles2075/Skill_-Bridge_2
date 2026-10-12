import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { lmsDB } from "./lms-db.server";

function credentials() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim() || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim() || "";
  if (!keyId || !keySecret) {
    throw new Error(
      "Payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Vercel Environment Variables.",
    );
  }
  return { keyId, keySecret };
}

export const createCourseOrder = createServerFn({ method: "POST" })
  .validator((d) => z.object({ courseId: z.string().min(1).max(100) }).parse(d))
  .handler(async ({ data }) => {
    await lmsDB.ready();
    const course = lmsDB.getCourse(data.courseId);
    if (!course) throw new Error("Course not found.");
    if (course.status !== "published") throw new Error("This course is not available for purchase.");

    const { keyId, keySecret } = credentials();
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: course.price_inr * 100,
        currency: "INR",
        receipt: `course_${course.id}_${Date.now()}`.slice(0, 40),
        notes: { course_id: course.id, course_slug: course.slug, course_title: course.title },
      }),
    });
    const result = await response.json() as {
      id?: string; amount?: number; currency?: string; error?: { description?: string };
    };
    if (!response.ok || !result.id) {
      throw new Error(result.error?.description || "Could not create Razorpay order.");
    }
    return {
      orderId: result.id,
      amount: result.amount || course.price_inr * 100,
      currency: result.currency || "INR",
      keyId,
      title: course.title,
    };
  });

export const verifyCoursePayment = createServerFn({ method: "POST" })
  .validator((d) =>
    z.object({
      courseId: z.string().min(1).max(100),
      orderId: z.string().min(1).max(120),
      paymentId: z.string().min(1).max(120),
      signature: z.string().min(1).max(200),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    // The browser sends the signed-in user's ID/email so the API can resolve the
    // same session as other LMS endpoints, and independently verifies with Razorpay.
    // The account ID itself is validated against the bearer session by the LMS route.
    throw new Error(
      "Payment confirmation must use POST /api/lms/purchase-confirmed with your signed-in session.",
    );
  });

export const getUserPurchases = createServerFn({ method: "GET" }).handler(
  async () => [] as string[],
);
