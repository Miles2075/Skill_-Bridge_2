import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "crypto";
import { lmsDB } from "./lms-db.server";

const COURSE_CATALOG: Record<string, { title: string; price: number; slug?: string }> = {
  // Short IDs
  "c-ts": {
    title: "Advanced TypeScript & Design Patterns",
    price: 1299,
    slug: "advanced-typescript",
  },
  "c-react": { title: "React Performance & Architecture", price: 1499, slug: "react-performance" },
  "c-sys": { title: "System Design Fundamentals", price: 999, slug: "system-design" },
  "c-dsa": { title: "Data Structures & Algorithms", price: 799, slug: "dsa" },
  // Slugs
  "advanced-typescript": { title: "Advanced TypeScript & Design Patterns", price: 1299 },
  "react-performance": { title: "React Performance & Architecture", price: 1499 },
  "react-perf": { title: "React Performance & Architecture", price: 1499 },
  "system-design": { title: "System Design Fundamentals", price: 999 },
  dsa: { title: "Data Structures & Algorithms", price: 799 },
  // DB UUIDs
  "45c4dd4a-715b-4f7d-b508-9c7501f2a63b": {
    title: "Advanced TypeScript & Design Patterns",
    price: 1299,
  },
  "0f1f297a-5fd3-4266-b6e7-e88f90939b1a": {
    title: "React Performance & Architecture",
    price: 1499,
  },
  "ed458579-67a4-41bc-b426-ff10ce69551e": { title: "System Design Fundamentals", price: 999 },
  "1ac4b07c-8a19-4f77-a712-9bb1a665bc7e": { title: "Data Structures & Algorithms", price: 799 },
};

function findCourse(courseId: string) {
  try {
    const fromDb = lmsDB.getCourse(courseId);
    if (fromDb) {
      return {
        title: fromDb.title,
        price: fromDb.price_inr > 0 ? fromDb.price_inr : 999,
        slug: fromDb.slug,
      };
    }
  } catch {
    // fallback to static catalog
  }
  return COURSE_CATALOG[courseId] || { title: "Skillbridge Course", price: 999 };
}

function getRazorpayCredentials() {
  const keyId = process.env["RAZORPAY_KEY_ID"]?.trim() || "";
  const keySecret = process.env["RAZORPAY_KEY_SECRET"]?.trim() || "";
  if (!keyId || !keySecret) {
    throw new Error(
      "Payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Vercel Environment Variables.",
    );
  }
  if (!keyId.startsWith("rzp_")) throw new Error("RAZORPAY_KEY_ID is invalid.");
  return { keyId, keySecret };
}

async function razorpayRequest(path: string, init: RequestInit = {}) {
  const { keyId, keySecret } = getRazorpayCredentials();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`https://api.razorpay.com/v1${path}`, { ...init, headers });
  const body = await response.text();
  let data: {
    id?: string;
    amount?: number;
    currency?: string;
    order_id?: string;
    notes?: { course_id?: string };
    status?: string;
    error?: { description?: string };
  } = {};
  try {
    data = JSON.parse(body);
  } catch {
    data = { error: { description: body } };
  }
  if (!response.ok) throw new Error(data?.error?.description || "Razorpay request failed");
  return data;
}

export const createCourseOrder = createServerFn({ method: "POST" })
  .validator((d) => z.object({ courseId: z.string().min(1).max(100) }).parse(d))
  .handler(async ({ data }) => {
    await lmsDB.ready();
    const record = lmsDB.getCourse(data.courseId);
    if (!record) throw new Error("Course not found.");
    if (record.status !== "published") throw new Error("This course is not available for purchase.");
    const course = { title: record.title, price: record.price_inr, slug: record.slug };
    const { keyId } = getRazorpayCredentials();

    const order = await razorpayRequest("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: course.price * 100,
        currency: "INR",
        receipt: `course_${data.courseId}_${Date.now()}`.slice(0, 40),
        notes: { course_id: data.courseId, course_title: course.title },
      }),
    });

    return {
      orderId: order.id,
      amount: order.amount || course.price * 100,
      currency: order.currency || "INR",
      keyId,
      title: course.title,
    };
  });

export const verifyCoursePayment = createServerFn({ method: "POST" })
  .validator((d) =>
    z
      .object({
        courseId: z.string().min(1).max(100),
        orderId: z.string().min(1).max(120),
        paymentId: z.string().min(1).max(120),
        signature: z.string().min(1).max(200),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await lmsDB.ready();
    const record = lmsDB.getCourse(data.courseId);
    if (!record) throw new Error("Course not found.");
    const course = { title: record.title, price: record.price_inr, slug: record.slug };
    const { keySecret } = getRazorpayCredentials();
    const expected = createHmac("sha256", keySecret)
      .update(`${data.orderId}|${data.paymentId}`)
      .digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(data.signature, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new Error("Payment signature verification failed");

    {
      try {
        const [order, payment] = await Promise.all([
          razorpayRequest(`/orders/${encodeURIComponent(data.orderId)}`),
          razorpayRequest(`/payments/${encodeURIComponent(data.paymentId)}`),
        ]);
        if (order.id !== data.orderId) {
          throw new Error("Payment order ID does not match");
        }
        const noteId = order.notes?.course_id;
        if (noteId !== data.courseId && noteId !== course.slug) {
          throw new Error("Payment order does not belong to the selected course.");
        }
        if (order.amount !== course.price * 100 || order.currency !== "INR") {
          throw new Error("Payment amount or currency does not match the course price.");
        }
        if (payment.order_id !== data.orderId) {
          throw new Error("Payment does not belong to the specified order.");
        }
        if (payment.status !== "captured") {
          throw new Error(`Payment is not captured. Current status: ${payment.status || "unknown"}`);
        }
      } catch (err) {
        throw err instanceof Error ? err : new Error("Live payment verification failed");
      }
    }

    return { ok: true, paymentId: data.paymentId, orderId: data.orderId, amount: course.price };
  });

export const getUserPurchases = createServerFn({ method: "GET" }).handler(async () => {
  // Purchases are scoped through the auth session on the LMS API. Server functions
  // should not return a static success response that looks like a real purchase.
  return [] as string[];
});
