import crypto from "crypto";
import nodePath from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { head, issueSignedToken, presignUrl, put } from "@vercel/blob";
import { lmsDB } from "./lms-db.server";

interface UserContext {
  userId: string | null;
  email: string | null;
  name: string | null;
  role: "student" | "teacher" | "admin";
  isAdmin: boolean;
  isTeacher: boolean;
}

function parseUserContext(req: Request): UserContext {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  let userId: string | null = null;
  let email: string | null = null;
  let name: string | null = null;
  let roleStr: string | null = null;

  // Never treat a client-writable role cookie or x-user-* header as identity.
  // A session token must resolve to a server-side session before its user/role is used.

  if (token) {
    const validated = lmsDB.validateSession(token);
    if (validated) {
      userId = validated.user.id;
      email = validated.user.email ?? null;
      name = String(
        (validated.user.user_metadata?.display_name as string) ||
          (validated.user.email ?? "").split("@")[0],
      );
      const primaryRole = validated.roles.includes("admin")
        ? "admin"
        : validated.roles.includes("teacher")
          ? "teacher"
          : "student";
      roleStr = primaryRole;
    }
  }

  const role = (
    roleStr === "teacher" || roleStr === "instructor" || roleStr === "admin"
      ? roleStr === "instructor"
        ? "teacher"
        : roleStr
      : "student"
  ) as "student" | "teacher" | "admin";
  const isAdmin = role === "admin";
  const isTeacher = role === "teacher" || isAdmin;

  return {
    userId,
    email,
    name,
    role,
    isAdmin,
    isTeacher,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

async function handleLmsApiRequestInternal(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/lms")) {
    return null;
  }

  const path = url.pathname.replace(/^\/api\/lms\/?/, "");
  const method = req.method.toUpperCase();
  const user = parseUserContext(req);

  // Keep externally authenticated users (for example Supabase users) in the
  // LMS database as well. Their auth UUID may not exist in the LMS snapshot
  // yet, which otherwise makes profile/avatar updates return "User not found".
  if (user.userId && user.email) {
    const syncedUser = lmsDB.ensureExternalUser({
      id: user.userId,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    user.userId = syncedUser.id;
    user.email = syncedUser.email;
    user.name = String(
      syncedUser.user_metadata?.display_name || syncedUser.email.split("@")[0] || "Learner",
    );
    user.role = (syncedUser.user_metadata?.role || user.role) as "student" | "teacher" | "admin";
    user.isAdmin = user.role === "admin";
    user.isTeacher = user.role === "teacher" || user.isAdmin;
  }

  try {
  // The API is a server-side boundary: never trust client-supplied role headers.
  // Signed internal sessions from the LMS store are resolved by parseUserContext;
  // external JWT payloads are accepted only when an explicit trusted auth adapter
  // has verified them before forwarding user headers.
    // AUTH: POST /api/lms/auth/login
    if (path === "auth/login" && method === "POST") {
      const body = await req.json();
      const { email, password } = body;
      if (!email || !password) return errorResponse("Email and password are required");

      const res = lmsDB.authenticateUser(email, password);
      if (!res) {
        return errorResponse("Invalid login credentials", 400);
      }
      return jsonResponse({
        user: res.user,
        session: res.session,
        roles: res.roles,
      });
    }

    // AUTH: POST /api/lms/auth/signup
    if (path === "auth/signup" && method === "POST") {
      const body = await req.json();
      const { email, password, metadata } = body;
      if (!email || !password) return errorResponse("Email and password are required");

      const cleanEmail = email.trim().toLowerCase();
      if (lmsDB.findUserByEmail(cleanEmail)) {
        const authed = lmsDB.authenticateUser(cleanEmail, password);
        if (authed) {
          return jsonResponse({
            user: authed.user,
            session: authed.session,
            roles: authed.roles,
          });
        }
      }

      const res = lmsDB.registerUser({
        email: cleanEmail,
        password,
        name: metadata?.display_name || metadata?.name,
        role: metadata?.role,
      });
      return jsonResponse({
        user: res.user,
        session: res.session,
        roles: res.roles,
      });
    }

    // AUTH: PATCH /api/lms/profile
    if (path === "profile" && method === "PATCH") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const body = await req.json();
      const displayName = body.displayName === undefined ? undefined : String(body.displayName);
      const avatarUrl =
        body.avatarUrl === undefined
          ? undefined
          : body.avatarUrl === null
            ? null
            : String(body.avatarUrl);
      if (displayName !== undefined && !displayName.trim())
        return errorResponse("Display name cannot be empty.");
      try {
        const updated = lmsDB.updateUserProfile(user.userId, { displayName, avatarUrl });
        if (!updated) return errorResponse("User not found.", 404);
        return jsonResponse({ user: updated });
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Unable to update profile.");
      }
    }

    // AUTH: POST /api/lms/upload-avatar
    if (path === "upload-avatar" && method === "POST") {
      if (!user.userId) return errorResponse("Unauthorized", 401);

      // Vercel Functions have a request-size limit, so keep server-side avatar
      // uploads below that limit. Course videos/thumbnails continue to use the
      // direct signed-URL Blob flow above.
      const MAX_AVATAR_SIZE = process.env.VERCEL
        ? 4 * 1024 * 1024
        : 5 * 1024 * 1024;
      const declaredSize = Number(
        req.headers.get("x-file-size") || req.headers.get("content-length") || 0,
      );
      if (declaredSize > MAX_AVATAR_SIZE) {
        return errorResponse(
          `Profile picture is too large. Maximum file size is ${Math.round(
            MAX_AVATAR_SIZE / 1024 / 1024,
          )} MB.`,
          413,
        );
      }
      if (!req.body) return errorResponse("Profile picture is required.", 400);

      let originalName = "avatar";
      const encodedName = req.headers.get("x-file-name");
      if (encodedName) {
        try {
          originalName = decodeURIComponent(encodedName);
        } catch {
          originalName = encodedName;
        }
      }

      const contentType = req.headers.get("content-type") || "application/octet-stream";
      const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
      if (!allowedTypes.has(contentType)) {
        return errorResponse("Use a JPG, PNG, WebP, or GIF image.", 400);
      }

      // On Vercel, upload the avatar through the Blob SDK and use the exact
      // canonical public URL returned by Blob. This avoids deriving a display
      // URL from a signed PUT URL.
      if (process.env.VERCEL) {
        try {
          const extension = nodePath.extname(originalName).toLowerCase() || ".jpg";
          const safeBase =
            originalName
              .slice(0, Math.max(0, originalName.length - extension.length))
              .replace(/[^a-zA-Z0-9_-]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 80) || "avatar";
          const pathname = `avatars/${user.userId}/${Date.now()}-${crypto.randomUUID().slice(
            0,
            8,
          )}-${safeBase}${extension}`;

          const blob = await put(pathname, req.body, {
            access: "public",
            contentType,
            addRandomSuffix: false,
          });

          const updated = lmsDB.updateUserProfile(user.userId, {
            avatarUrl: `/api/lms/avatar?userId=${encodeURIComponent(user.userId)}&v=${Date.now()}`,
            avatarBlobUrl: blob.url,
          });
          if (!updated) return errorResponse("User not found.", 404);

          return jsonResponse({
            // Return the canonical public Blob URL to the browser. The app
            // proxy remains available as a compatibility fallback, but the
            // client should render the actual public media URL.
            avatarUrl: blob.url,
            avatarProxyUrl: `/api/lms/avatar?userId=${encodeURIComponent(user.userId)}&v=${Date.now()}`,
            fileName: originalName,
            size: blob.size ?? declaredSize ?? 0,
          });
        } catch (err) {
          console.warn("Failed to upload profile picture to Vercel Blob:", err);
          return errorResponse(
            err instanceof Error ? err.message : "Failed to save profile picture.",
            500,
          );
        }
      }

      const uploadDir = nodePath.resolve(process.cwd(), "public", "uploads", "avatars");
      fs.mkdirSync(uploadDir, { recursive: true });
      const uniqueName =
        user.userId +
        "-" +
        Date.now() +
        "-" +
        crypto.randomUUID().slice(0, 8) +
        "-" +
        nodePath
          .basename(originalName)
          .replace(/[^a-zA-Z0-9._-]+/g, "-");

      const filePath = nodePath.join(uploadDir, uniqueName);

      try {
        const writeStream = fs.createWriteStream(filePath);
        await pipeline(Readable.fromWeb(req.body as ReadableStream<Uint8Array>), writeStream);
        const writtenStat = await fs.promises.stat(filePath);
        if (declaredSize > 0 && writtenStat.size === 0) {
          await fs.promises.rm(filePath, { force: true }).catch(() => {});
          return errorResponse("Profile picture upload failed: 0 bytes written to disk.", 500);
        }
      } catch (err) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        if (req.signal?.aborted) {
          return errorResponse("Profile picture upload was cancelled before completion.", 499);
        }
        throw err;
      }

      const publicAvatarUrl = "/uploads/avatars/" + uniqueName;
      try {
        const updated = lmsDB.updateUserProfile(user.userId, { avatarUrl: publicAvatarUrl });
        if (!updated) {
          await fs.promises.rm(filePath, { force: true }).catch(() => {});
          return errorResponse("User not found.", 404);
        }
      } catch (dbErr) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        console.warn("Failed to save profile picture:", dbErr);
        return errorResponse("Failed to save profile picture.", 500);
      }

      return jsonResponse({
        avatarUrl: publicAvatarUrl,
        fileName: originalName,
        size: declaredSize || 0,
      });
    }

    // MEDIA: GET /api/lms/avatar?userId=...
    // Serve stored public Blob avatars through the app origin as a fallback for
    // browsers/privacy tools that block cross-origin Blob CDN URLs.
    if (path === "avatar" && method === "GET") {
      const targetUserId = new URL(req.url).searchParams.get("userId") || user.userId;
      const db = lmsDB.getUserById(targetUserId);
      if (!db) return errorResponse("User not found.", 404);

      const blobUrl = db.user_metadata?.avatar_blob_url as string | undefined;
      const legacyUrl = db.user_metadata?.avatar_url as string | undefined;
      const sourceUrl =
        blobUrl ||
        (legacyUrl && /^https:\/\/(.+)\.public\.blob\.vercel-storage\.com\//.test(legacyUrl)
          ? legacyUrl
          : "");

      if (!sourceUrl) {
        if (legacyUrl?.startsWith("/uploads/")) {
          return Response.redirect(new URL(legacyUrl, req.url).toString(), 302);
        }
        return errorResponse("Profile picture not found.", 404);
      }

      // Public Vercel Blob objects are immutable and are designed to be
      // rendered directly from their canonical public URL. Keep delivery
      // outside the application function so the avatar endpoint itself does
      // not add another server-side Blob read dependency.
      return Response.redirect(sourceUrl, 302);
    }

    // STORAGE: POST /api/lms/finalize-upload
    // Confirms a direct browser-to-Blob upload and persists its canonical public URL.
    if (path === "finalize-upload" && method === "POST") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const body = await req.json().catch(() => ({}));
      const kind = body?.kind as "video" | "thumbnail" | undefined;
      const courseId = typeof body?.courseId === "string" ? body.courseId : "";
      const lessonId = typeof body?.lessonId === "string" ? body.lessonId : "";
      const pathname = typeof body?.pathname === "string" ? body.pathname : "";

      if (!kind || !["video", "thumbnail"].includes(kind)) {
        return errorResponse("Invalid upload type.", 400);
      }
      if (!courseId || !pathname) return errorResponse("Course id and pathname are required.", 400);
      if (!pathname.startsWith(`courses/${courseId}/${kind === "video" ? "videos" : "thumbnails"}/`)) {
        return errorResponse("Invalid upload pathname.", 400);
      }

      const course = lmsDB.getCourse(courseId);
      if (!course) return errorResponse("Course not found.", 404);
      if (!user.isAdmin && course.teacher_id === null) {
        lmsDB.updateCourse(course.id, { teacher_id: user.userId });
        course.teacher_id = user.userId;
      }
      if (!user.isAdmin && course.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only upload to your own courses.", 403);
      }

      if (kind === "video" && lessonId) {
        const lesson = lmsDB.getLesson(lessonId);
        if (!lesson || lesson.course_id !== course.id) {
          return errorResponse("Lesson does not belong to this course.", 403);
        }
      }

      try {
        // HEAD the exact pathname instead of listing the store. A direct PUT
        // can complete before the blob appears in a list response, while HEAD
        // resolves the just-uploaded object directly and returns its canonical
        // public URL.
        const blob = await head(pathname);
        if (!blob?.url) return errorResponse("Uploaded blob could not be resolved.", 409);

        if (kind === "thumbnail") {
          lmsDB.updateCourse(course.id, { thumbnail: blob.url });
        } else if (lessonId) {
          lmsDB.updateLesson(lessonId, { video_url: blob.url });
        } else {
          const currentUrls = Array.isArray(course.video_urls)
            ? [...course.video_urls]
            : course.video_url
              ? [course.video_url]
              : [];
          if (!currentUrls.includes(blob.url)) currentUrls.push(blob.url);
          lmsDB.updateCourse(course.id, {
            video_url: course.video_url || blob.url,
            video_urls: currentUrls,
          });
        }

        return jsonResponse({
          publicUrl: blob.url,
          pathname: blob.pathname,
          size: blob.size,
        });
      } catch (err) {
        console.warn("Failed to finalize Blob upload:", err);
        return errorResponse(err instanceof Error ? err.message : "Failed to finalize upload.", 500);
      }
    }

    // STORAGE: POST /api/lms/create-upload-url
    if (path === "create-upload-url" && method === "POST") {
      if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL) {
        return errorResponse("Cloud file storage is not configured.", 503);
      }
      if (!user.userId) return errorResponse("Unauthorized", 401);

      const body = await req.json().catch(() => ({}));
      const kind = body?.kind as "video" | "thumbnail" | "avatar" | undefined;
      const courseId = typeof body?.courseId === "string" ? body.courseId : "";
      const lessonId = typeof body?.lessonId === "string" ? body.lessonId : "";
      const fileName = typeof body?.fileName === "string" ? body.fileName : "upload";
      const contentType = typeof body?.contentType === "string" ? body.contentType : "";
      const size = Number(body?.size || 0);

      const limits = {
        video: {
          max: 500 * 1024 * 1024,
          types: ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"],
        },
        thumbnail: {
          max: 10 * 1024 * 1024,
          types: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        },
        avatar: {
          max: 5 * 1024 * 1024,
          types: ["image/jpeg", "image/png", "image/webp", "image/gif"],
        },
      } as const;

      if (!kind || !(kind in limits)) return errorResponse("Invalid upload type.", 400);
      const limit = limits[kind];
      if (!contentType || !limit.types.includes(contentType as never)) {
        return errorResponse("Unsupported file type.", 400);
      }
      if (!Number.isFinite(size) || size <= 0 || size > limit.max) {
        return errorResponse(`File is too large or invalid. Maximum size is ${Math.round(limit.max / 1024 / 1024)} MB.`, 413);
      }

      if (kind === "video" || kind === "thumbnail") {
        const course = lmsDB.getCourse(courseId);
        if (!course) return errorResponse("Course not found.", 404);
        if (!user.isAdmin && course.teacher_id === null) {
          lmsDB.updateCourse(course.id, { teacher_id: user.userId });
          course.teacher_id = user.userId;
        }
        if (!user.isAdmin && course.teacher_id !== user.userId) {
          return errorResponse("Forbidden: you can only upload to your own courses.", 403);
        }
        if (kind === "video" && lessonId) {
          const lesson = lmsDB.getLesson(lessonId);
          if (!lesson || lesson.course_id !== course.id) {
            return errorResponse("Lesson does not belong to this course.", 403);
          }
        }
      }

      const extension = nodePath.extname(fileName).toLowerCase();
      const allowedExtensions =
        kind === "video"
          ? new Set([".mp4", ".webm", ".mov", ".m4v"])
          : new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
      if (!allowedExtensions.has(extension)) return errorResponse("Unsupported file extension.", 400);

      const safeBase =
        fileName
          .slice(0, fileName.length - extension.length)
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || kind;

      const folder =
        kind === "avatar"
          ? `avatars/${user.userId}`
          : `courses/${courseId}/${kind === "video" ? "videos" : "thumbnails"}`;
      const pathname = `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeBase}${extension}`;

      const token = await issueSignedToken({
        pathname,
        operations: ["put"],
        maximumSizeInBytes: limit.max,
        allowedContentTypes: [...limit.types],
        validUntil: Date.now() + 15 * 60 * 1000,
      });
      const { presignedUrl } = await presignUrl(token, {
        pathname,
        operation: "put",
        validUntil: Date.now() + 15 * 60 * 1000,
      });

      // A Vercel Blob signed PUT URL points at the actual Blob object.
      // The query string is only the temporary write authorization, so the
      // same URL without its query is the canonical public media URL.
      const publicUrl = new URL(presignedUrl);
      publicUrl.search = "";
      publicUrl.hash = "";

      return jsonResponse({
        uploadUrl: presignedUrl,
        publicUrl: publicUrl.toString(),
        pathname,
      });
    }

    // AUTH: POST /api/lms/auth/logout
    if (path === "auth/logout" && method === "POST") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (token) lmsDB.logoutUser(token);
      return jsonResponse({ success: true });
    }

    // AUTH: GET /api/lms/auth/session
    if (path === "auth/session" && method === "GET") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      const validated = token ? lmsDB.validateSession(token) : null;
      if (!validated) {
        return jsonResponse({ user: null, session: null, roles: [] });
      }
      return jsonResponse({
        user: validated.user,
        session: validated.session,
        roles: validated.roles,
      });
    }

    // AUTH: GET /api/lms/auth/roles
    if (path === "auth/roles" && method === "GET") {
      const roles = user.userId ? lmsDB.getUserRoles(user.userId) : [];
      return jsonResponse({ roles });
    }

    // GENERIC QUERY compatibility adapter. Only allow tables and actions that
    // callers actually need, and always scope private records to the current user.
    if (path === "query" && method === "POST") {
      const body = await req.json();
      const table = typeof body.table === "string" ? body.table : "";
      const action = body.action;
      if (!["select", "insert", "upsert", "update", "delete"].includes(action)) {
        return errorResponse("Unsupported table action", 400);
      }

      const allowedTables = new Set([
        "courses", "lessons", "enrollments", "lesson_progress", "assignments",
        "submissions", "quizzes", "quiz_attempts", "certificates", "users",
        "user_roles", "sessions", "purchases", "profiles",
      ]);
      if (!allowedTables.has(table)) return errorResponse("Table not allowed", 400);

      const ownerColumnByTable: Record<string, string> = {
        enrollments: "student_id",
        lesson_progress: "student_id",
        submissions: "student_id",
        quiz_attempts: "student_id",
        certificates: "student_id",
        purchases: "user_id",
        profiles: "id",
        users: "id",
        sessions: "user_id",
        user_roles: "user_id",
      };
      const privateTable = Object.hasOwn(ownerColumnByTable, table);
      if (privateTable && !user.userId) return errorResponse("Unauthorized", 401);
      const isWrite = action !== "select";
      if (isWrite && !user.userId) return errorResponse("Unauthorized", 401);

      // Generic table APIs never mutate auth, role, purchase, enrollment, or
      // teacher-owned course data. Those writes must go through typed endpoints.
      const directWriteTables = new Set(["profiles", "lesson_progress"]);
      if (isWrite && !directWriteTables.has(table)) {
        return errorResponse("Use the dedicated API endpoint for this operation", 403);
      }
      if (isWrite && table === "lesson_progress" && !user.userId) {
        return errorResponse("Unauthorized", 401);
      }

      const filters =
        body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
          ? { ...(body.filters as Record<string, unknown>) }
          : undefined;
      const scopedFilters: Record<string, unknown> = filters || {};
      if (privateTable && user.userId) {
        scopedFilters[ownerColumnByTable[table]!] = user.userId;
      }

      const values = body.values;
      if (isWrite && (table === "profiles" || table === "lesson_progress") && values !== undefined) {
        const rows = Array.isArray(values) ? values : [values];
        for (const row of rows) {
          if (!row || typeof row !== "object") return errorResponse("Invalid payload", 400);
          const record = row as Record<string, unknown>;
          const ownerColumn = table === "profiles" ? "id" : "student_id";
          if (record[ownerColumn] !== undefined && record[ownerColumn] !== user.userId) {
            return errorResponse("You can only modify your own records", 403);
          }
          if (table === "lesson_progress") record["student_id"] = user.userId;
          if (table === "profiles") record["id"] = user.userId;
        }
      }

      const result = lmsDB.queryTable(table, {
        ...body,
        filters: Object.keys(scopedFilters).length ? scopedFilters : undefined,
      });
      return jsonResponse(result);
    }
    // GET /api/lms/courses
    if (path === "courses" && method === "GET") {
      const courses = lmsDB.getAllCourses();
      return jsonResponse({ courses });
    }

    // GET /api/lms/course?idOrSlug=...
    if (path === "course" && method === "GET") {
      const idOrSlug = url.searchParams.get("idOrSlug") || url.searchParams.get("slug") || "";
      if (!idOrSlug) return errorResponse("Missing course slug or id parameter");
      const course = lmsDB.getCourse(idOrSlug);
      if (!course) return errorResponse("Course not found", 404);

      const lessons = lmsDB.getLessonsForCourse(course.id);
      let enrollment = null;
      let progressRecords: unknown[] = [];

      if (user.userId) {
        enrollment = lmsDB.getStudentEnrollment(user.userId, course.id);
        progressRecords = lmsDB.getLessonProgress(user.userId, course.id);
      }

      return jsonResponse({
        course,
        lessons,
        enrollment,
        lessonProgress: progressRecords,
      });
    }

    // POST /api/lms/enroll
    if (path === "enroll" && method === "POST") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const body = await req.json();
      const courseId = body.courseId || body.courseSlug;
      if (!courseId) return errorResponse("Missing courseId");

      const enrollment = lmsDB.enrollStudent(
        user.userId,
        courseId,
        user.name || body.studentName || "Student",
        user.email || body.studentEmail || "student@example.com",
      );
      return jsonResponse({ enrollment });
    }

    // GET /api/lms/my-purchases
    if (path === "my-purchases" && method === "GET") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const purchases = lmsDB.getPurchasesForUser(user.userId);
      return jsonResponse({ purchases, courseIds: purchases.map((purchase) => purchase.course_id) });
    }

    // POST /api/lms/purchase-confirmed
    // Independently verify the Razorpay signature and captured payment before enrollment.
    if (path === "purchase-confirmed" && method === "POST") {
      if (!user.userId) return errorResponse("Sign in before purchasing a course.", 401);
      const body = await req.json().catch(() => ({}));
      const courseId = typeof body.courseId === "string" ? body.courseId : "";
      const orderId = typeof body.orderId === "string" ? body.orderId : "";
      const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
      const signature = typeof body.signature === "string" ? body.signature : "";
      if (!courseId || !orderId || !paymentId || !signature) {
        return errorResponse("Course and payment details are required.");
      }

      const keyId = process.env.RAZORPAY_KEY_ID?.trim();
      const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
      if (!keyId || !keySecret) return errorResponse("Payments are not configured.", 503);
      const course = lmsDB.getCourse(courseId);
      if (!course || course.status !== "published") return errorResponse("Course not found or unavailable.", 404);

      const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
      const supplied = Buffer.from(signature, "utf8");
      const expectedBuffer = Buffer.from(expected, "utf8");
      if (supplied.length !== expectedBuffer.length || !crypto.timingSafeEqual(supplied, expectedBuffer)) {
        return errorResponse("Payment signature verification failed.", 400);
      }

      const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
      const [orderResponse, paymentResponse] = await Promise.all([
        fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, { headers: { Authorization: auth } }),
        fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: auth } }),
      ]);
      if (!orderResponse.ok || !paymentResponse.ok) {
        return errorResponse("Could not verify payment with Razorpay.", 502);
      }
      const order = await orderResponse.json() as {
        id?: string; amount?: number; currency?: string; notes?: { course_id?: string; course_slug?: string };
      };
      const payment = await paymentResponse.json() as {
        id?: string; order_id?: string; amount?: number; currency?: string; status?: string;
      };
      if (order.id !== orderId || payment.id !== paymentId || payment.order_id !== orderId) {
        return errorResponse("Payment identifiers do not match.", 400);
      }
      if (order.amount !== course.price_inr * 100 || payment.amount !== order.amount ||
          order.currency !== "INR" || payment.currency !== "INR") {
        return errorResponse("Paid amount does not match this course.", 400);
      }
      if (order.notes?.course_id !== course.id && order.notes?.course_id !== course.slug &&
          order.notes?.course_slug !== course.slug) {
        return errorResponse("Payment was not created for this course.", 400);
      }
      if (payment.status !== "captured") return errorResponse("Payment has not been captured.", 402);

      const purchase = lmsDB.recordPurchase({
        id: `purchase_${paymentId}`,
        user_id: user.userId,
        course_id: course.id,
        amount_inr: course.price_inr,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
      });
      const enrollment = lmsDB.enrollStudent(user.userId, course.id, user.name || "Learner", user.email || "");
      await lmsDB.flush();
      return jsonResponse({ ok: true, purchase, enrollment });
    }

    // POST /api/lms/purchase-confirmed
    // Used after client payment UI completes. This route independently fetches the
    // Razorpay order and payment and validates the signature, amount, course, and
    // authenticated owner before granting access.
    if (path === "purchase-confirmed" && method === "POST") {
      if (!user.userId) return errorResponse("Sign in before purchasing a course.", 401);
      const body = await req.json().catch(() => ({}));
      const courseId = typeof body.courseId === "string" ? body.courseId : "";
      const orderId = typeof body.orderId === "string" ? body.orderId : "";
      const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
      const signature = typeof body.signature === "string" ? body.signature : "";
      if (!courseId || !orderId || !paymentId || !signature) {
        return errorResponse("Course and payment details are required.");
      }

      const keyId = process.env.RAZORPAY_KEY_ID?.trim();
      const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
      if (!keyId || !keySecret) return errorResponse("Payments are not configured.", 503);
      const course = lmsDB.getCourse(courseId);
      if (!course) return errorResponse("Course not found.", 404);

      const crypto = await import("crypto");
      const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return errorResponse("Payment signature verification failed.", 400);
      }

      const basic = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
      const [orderResponse, paymentResponse] = await Promise.all([
        fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
          headers: { Authorization: `Basic ${basic}` },
        }),
        fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
          headers: { Authorization: `Basic ${basic}` },
        }),
      ]);
      if (!orderResponse.ok || !paymentResponse.ok) {
        return errorResponse("Could not verify payment with Razorpay.", 502);
      }
      const order = await orderResponse.json() as { id?: string; amount?: number; currency?: string; notes?: { course_id?: string } };
      const payment = await paymentResponse.json() as { id?: string; order_id?: string; amount?: number; currency?: string; status?: string };
      if (order.id !== orderId || payment.id !== paymentId || payment.order_id !== orderId) {
        return errorResponse("Payment identifiers do not match.", 400);
      }
      if (order.amount !== course.price_inr * 100 || payment.amount !== order.amount ||
          order.currency !== "INR" || payment.currency !== "INR") {
        return errorResponse("Paid amount does not match this course.", 400);
      }
      if (order.notes?.course_id !== course.id && order.notes?.course_id !== course.slug) {
        return errorResponse("Payment was not created for this course.", 400);
      }
      if (payment.status !== "captured") {
        return errorResponse("Payment has not been captured.", 402);
      }

      const purchaseResult = lmsDB.queryTable("purchases", {
        action: "upsert",
        onConflict: "razorpay_payment_id",
        values: {
          id: `purchase_${paymentId}`,
          user_id: user.userId,
          course_id: course.id,
          amount_inr: course.price_inr,
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
        },
      });
      const enrollment = lmsDB.enrollStudent(
        user.userId,
        course.id,
        user.name || "Learner",
        user.email || "",
      );
      await lmsDB.flush();
      return jsonResponse({ ok: true, purchase: purchaseResult.data, enrollment });
    }

    // POST /api/lms/complete-lesson
    if (path === "complete-lesson" && method === "POST") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const body = await req.json();
      const { courseId, lessonId, completed = true } = body;
      if (!courseId || !lessonId) return errorResponse("Missing courseId or lessonId");

      const result = lmsDB.completeLesson({
        studentId: user.userId,
        courseIdOrSlug: courseId,
        lessonId,
        completed: Boolean(completed),
        studentName: user.name || body.studentName,
        studentEmail: user.email || body.studentEmail,
      });

      return jsonResponse(result);
    }

    // GET /api/lms/student-dashboard
    if (path === "student-dashboard" && method === "GET") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const data = lmsDB.getStudentDashboard(user.userId);
      return jsonResponse(data);
    }

    // GET /api/lms/instructor-data
    if (path === "instructor-data" && method === "GET") {
      if (!user.isTeacher) return errorResponse("Forbidden: Instructor role required", 403);
      const data = lmsDB.getInstructorData(user.userId, user.isAdmin);
      return jsonResponse(data);
    }

    // POST /api/lms/course (Create course)
    if (path === "course" && method === "POST") {
      if (!user.isTeacher) return errorResponse("Forbidden: Instructor role required", 403);
      const body = await req.json();
      if (!body.title || !body.slug) return errorResponse("Title and slug are required");

      const videoUrls = Array.isArray(body.video_urls)
        ? body.video_urls.filter(Boolean)
        : body.video_url
          ? [body.video_url]
          : [];
      const primaryVideoUrl = body.video_url || videoUrls[0] || "";
      // Course creation is an explicit publish action unless the instructor
      // deliberately selected Draft/Review. Never let an empty/invalid status
      // silently create a non-published course.
      const courseStatus =
        body.status === "draft" || body.status === "review" ? body.status : "published";

      const created = lmsDB.createCourse({
        title: body.title,
        slug: String(body.slug).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
        description: body.description || "",
        instructor: body.instructor || user.name || "Lead Instructor",
        teacher_id: user.userId,
        thumbnail: body.thumbnail || "/course-typescript.jpg",
        status: courseStatus,
        price_inr: Number(body.price_inr) || 999,
        preview_minutes: Number(body.preview_minutes) || 3,
        video_url: primaryVideoUrl,
        video_urls: videoUrls,
        hours: Number(body.hours) || 10,
        level: body.level || "Intermediate",
        category: body.category || "Development",
        rating: 5.0,
        reviews: "1",
        learners: "0",
      });

      return jsonResponse({ course: created });
    }

    // PUT /api/lms/course (Update course)
    if (path === "course" && method === "PUT") {
      if (!user.isTeacher) return errorResponse("Forbidden: Instructor role required", 403);
      const body = await req.json();
      const courseId = body.id || body.slug;
      if (!courseId) return errorResponse("Course id is required");

      const existing = lmsDB.getCourse(courseId);
      if (!existing) return errorResponse("Course not found", 404);
      // Legacy seed courses without an owner are claimable by the first instructor
      // who edits them; courses already owned by another instructor stay protected.
      if (!user.isAdmin && existing.teacher_id === null) {
        lmsDB.updateCourse(existing.id, { teacher_id: user.userId });
        existing.teacher_id = user.userId;
      }
      if (!user.isAdmin && existing.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only modify your own courses", 403);
      }

      const updated = lmsDB.updateCourse(existing.id, body);
      return jsonResponse({ course: updated });
    }

    // DELETE /api/lms/course
    if (path === "course" && method === "DELETE") {
      if (!user.isTeacher) return errorResponse("Forbidden: Instructor role required", 403);
      const body = await req.json();
      const courseId = body.id || body.slug;
      if (!courseId) return errorResponse("Course id is required");

      const existing = lmsDB.getCourse(courseId);
      if (!existing) return errorResponse("Course not found", 404);
      if (!user.isAdmin && existing.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only delete your own courses", 403);
      }

      const ok = lmsDB.deleteCourse(existing.id);
      return jsonResponse({ success: ok });
    }

    // POST /api/lms/upload-video
    // The request body is the video file itself, not multipart/form-data.
    if (path === "upload-video" && method === "POST") {
      if (!user.isTeacher) return errorResponse("Forbidden: Instructor role required", 403);

      const courseId = url.searchParams.get("courseId") || "";
      if (!courseId) return errorResponse("Course id is required.");

      const course = lmsDB.getCourse(courseId);
      if (!course) return errorResponse("Course not found.", 404);
      // Claim legacy unowned seed courses on first instructor upload.
      if (!user.isAdmin && course.teacher_id === null) {
        lmsDB.updateCourse(course.id, { teacher_id: user.userId });
        course.teacher_id = user.userId;
      }
      if (!user.isAdmin && course.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only upload videos to your own courses", 403);
      }

      const MAX_VIDEO_SIZE = 500 * 1024 * 1024;
      const declaredSize = Number(
        req.headers.get("x-file-size") || req.headers.get("content-length") || 0,
      );
      if (declaredSize > MAX_VIDEO_SIZE) {
        return errorResponse("Video is too large. Maximum file size is 500 MB.", 413);
      }
      if (!req.body) return errorResponse("Video file is required.", 400);

      let originalName = "video.mp4";
      const encodedName = req.headers.get("x-file-name");
      if (encodedName) {
        try {
          originalName = decodeURIComponent(encodedName);
        } catch {
          originalName = encodedName;
        }
      }

      const allowedExtensions = new Set([".mp4", ".webm", ".mov", ".m4v"]);
      const dot = originalName.lastIndexOf(".");
      const extension = dot >= 0 ? originalName.slice(dot).toLowerCase() : "";
      if (!allowedExtensions.has(extension)) {
        return errorResponse("Unsupported video format. Use MP4, WebM, MOV, or M4V.", 400);
      }

      const safeBase =
        originalName
          .slice(0, dot >= 0 ? dot : originalName.length)
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "video";
      const uniqueName = `${course.id}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeBase}${extension}`;

      const uploadDir = nodePath.resolve(process.cwd(), "public", "uploads", "videos");
      fs.mkdirSync(uploadDir, { recursive: true });
      const filePath = nodePath.join(uploadDir, uniqueName);

      try {
        const writeStream = fs.createWriteStream(filePath);
        await pipeline(Readable.fromWeb(req.body as ReadableStream<Uint8Array>), writeStream);

        // Verify the file was written to disk
        const writtenStat = await fs.promises.stat(filePath);
        if (declaredSize > 0 && writtenStat.size === 0) {
          await fs.promises.rm(filePath, { force: true }).catch(() => {});
          return errorResponse("Video upload failed: 0 bytes written to disk.", 500);
        }
      } catch (err) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        if (req.signal?.aborted) {
          console.warn("Video upload request was aborted by the client.");
          return errorResponse("Video upload was cancelled before completion.", 499);
        }
        throw err;
      }

      const publicVideoUrl = `/uploads/videos/${uniqueName}`;

      const lessonId = url.searchParams.get("lessonId");
      if (lessonId) {
        const lesson = lmsDB.getLesson(lessonId);
        if (!lesson) {
          await fs.promises.rm(filePath, { force: true }).catch(() => {});
          return errorResponse("Lesson not found.", 404);
        }
        if (lesson.course_id !== course.id) {
          await fs.promises.rm(filePath, { force: true }).catch(() => {});
          return errorResponse("Lesson does not belong to this course.", 403);
        }
        try {
          lmsDB.updateLesson(lessonId, { video_url: publicVideoUrl });
        } catch (lErr) {
          await fs.promises.rm(filePath, { force: true }).catch(() => {});
          console.warn("Failed to auto-update lesson video_url during upload:", lErr);
          return errorResponse("Failed to save lesson video.", 500);
        }
      } else {
        // Automatically append to course's video_urls and update video_url
        try {
          const currentUrls =
            course.video_urls && Array.isArray(course.video_urls)
              ? [...course.video_urls]
              : course.video_url
                ? [course.video_url]
                : [];
          if (!currentUrls.includes(publicVideoUrl)) {
            currentUrls.push(publicVideoUrl);
          }
          lmsDB.updateCourse(course.id, {
            video_url: publicVideoUrl,
            video_urls: currentUrls,
          });
        } catch (dbErr) {
          console.warn("Failed to auto-update course video_url during upload:", dbErr);
        }
      }

      return jsonResponse({
        videoUrl: publicVideoUrl,
        fileName: originalName,
        size: declaredSize,
      });
    }

    // POST /api/lms/upload-thumbnail
    // The request body is the image file itself, not multipart/form-data.
    if (path === "upload-thumbnail" && method === "POST") {
      if (!user.isTeacher) return errorResponse("Forbidden: Instructor role required", 403);

      const courseId = url.searchParams.get("courseId") || "";
      if (!courseId) return errorResponse("Course id is required.");

      const course = lmsDB.getCourse(courseId);
      if (!course) return errorResponse("Course not found.", 404);
      // Claim legacy unowned seed courses on first thumbnail upload.
      if (!user.isAdmin && course.teacher_id === null) {
        lmsDB.updateCourse(course.id, { teacher_id: user.userId });
        course.teacher_id = user.userId;
      }
      if (!user.isAdmin && course.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only upload thumbnails to your own courses", 403);
      }

      const MAX_THUMBNAIL_SIZE = 10 * 1024 * 1024;
      const declaredSize = Number(
        req.headers.get("x-file-size") || req.headers.get("content-length") || 0,
      );
      if (declaredSize > MAX_THUMBNAIL_SIZE) {
        return errorResponse("Thumbnail is too large. Maximum file size is 10 MB.", 413);
      }
      if (!req.body) return errorResponse("Thumbnail image is required.", 400);

      let originalName = "thumbnail";
      const encodedName = req.headers.get("x-file-name");
      if (encodedName) {
        try {
          originalName = decodeURIComponent(encodedName);
        } catch {
          originalName = encodedName;
        }
      }

      const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
      const dot = originalName.lastIndexOf(".");
      const extension = dot >= 0 ? originalName.slice(dot).toLowerCase() : "";
      if (!allowedExtensions.has(extension)) {
        return errorResponse("Unsupported thumbnail format. Use JPG, JPEG, PNG, WebP, or GIF.", 400);
      }

      const safeBase =
        originalName
          .slice(0, dot >= 0 ? dot : originalName.length)
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "thumbnail";
      const uniqueName =
        course.id + "-" + Date.now() + "-" + crypto.randomUUID().slice(0, 8) + "-" + safeBase + extension;

      const uploadDir = nodePath.resolve(process.cwd(), "public", "uploads", "thumbnails");
      fs.mkdirSync(uploadDir, { recursive: true });
      const filePath = nodePath.join(uploadDir, uniqueName);

      try {
        const writeStream = fs.createWriteStream(filePath);
        await pipeline(Readable.fromWeb(req.body as ReadableStream<Uint8Array>), writeStream);
        const writtenStat = await fs.promises.stat(filePath);
        if (declaredSize > 0 && writtenStat.size === 0) {
          await fs.promises.rm(filePath, { force: true }).catch(() => {});
          return errorResponse("Thumbnail upload failed: 0 bytes written to disk.", 500);
        }
      } catch (err) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        if (req.signal?.aborted) {
          return errorResponse("Thumbnail upload was cancelled before completion.", 499);
        }
        throw err;
      }

      const publicThumbnailUrl = "/uploads/thumbnails/" + uniqueName;
      try {
        lmsDB.updateCourse(course.id, { thumbnail: publicThumbnailUrl });
      } catch (dbErr) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        console.warn("Failed to save course thumbnail:", dbErr);
        return errorResponse("Failed to save course thumbnail.", 500);
      }

      return jsonResponse({
        thumbnailUrl: publicThumbnailUrl,
        fileName: originalName,
        size: declaredSize,
      });
    }

    // POST /api/lms/lesson (Add lesson)
    if (path === "lesson" && method === "POST") {
      if (!user.isTeacher) return errorResponse("Forbidden", 403);
      const body = await req.json();
      const {
        courseId,
        title,
        description = "",
        duration = "15:00",
        videoUrl = "",
        isRequired = true,
        isPreview = false,
      } = body;
      if (!courseId || !title) return errorResponse("Missing courseId or title");

      const existingCourse = lmsDB.getCourse(courseId);
      if (!existingCourse) return errorResponse("Course not found", 404);
      if (!user.isAdmin && existingCourse.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only add lessons to your own courses", 403);
      }

      const lesson = lmsDB.addLesson(existingCourse.id, {
        title,
        description,
        duration,
        video_url: videoUrl || existingCourse.video_url,
        is_required: Boolean(isRequired),
        is_preview: Boolean(isPreview),
        lesson_order: body.lessonOrder || 0,
      });

      return jsonResponse({ lesson });
    }

    // PUT /api/lms/lesson (Edit lesson)
    if (path === "lesson" && method === "PUT") {
      if (!user.isTeacher) return errorResponse("Forbidden", 403);
      const body = await req.json();
      const { lessonId, ...patch } = body;
      if (!lessonId) return errorResponse("Missing lessonId");
      const existingLesson = lmsDB.getLesson?.(lessonId);
      if (!existingLesson) return errorResponse("Lesson not found", 404);
      const lessonCourse = lmsDB.getCourse(existingLesson.course_id);
      if (!lessonCourse) return errorResponse("Course not found", 404);
      if (!user.isAdmin && lessonCourse.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only modify your own course lessons", 403);
      }

      if (patch.videoUrl && !patch.video_url) {
        patch.video_url = patch.videoUrl;
      }

      const lesson = lmsDB.updateLesson(lessonId, patch);
      if (!lesson) return errorResponse("Lesson not found", 404);
      return jsonResponse({ lesson });
    }

    // DELETE /api/lms/lesson (Delete lesson)
    if (path === "lesson" && method === "DELETE") {
      if (!user.isTeacher) return errorResponse("Forbidden", 403);
      const body = await req.json();
      const { lessonId } = body;
      if (!lessonId) return errorResponse("Missing lessonId");
      const existingLesson = lmsDB.getLesson?.(lessonId);
      if (!existingLesson) return errorResponse("Lesson not found", 404);
      const lessonCourse = lmsDB.getCourse(existingLesson.course_id);
      if (!lessonCourse) return errorResponse("Course not found", 404);
      if (!user.isAdmin && lessonCourse.teacher_id !== user.userId) {
        return errorResponse("Forbidden: You can only delete your own course lessons", 403);
      }

      const ok = lmsDB.deleteLesson(lessonId);
      return jsonResponse({ success: ok });
    }

    // POST /api/lms/submit-assignment
    if (path === "submit-assignment" && method === "POST") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const body = await req.json();
      const { assignmentId, courseId, githubUrl = "", solutionNotes = "" } = body;
      if (!assignmentId || !courseId) return errorResponse("Missing assignmentId or courseId");

      const course = lmsDB.getCourse(courseId);
      if (!course) return errorResponse("Course not found", 404);

      const submission = lmsDB.submitAssignment({
        assignment_id: assignmentId,
        course_id: course.id,
        student_id: user.userId,
        student_name: user.name || body.studentName || "Student",
        student_email: user.email || body.studentEmail || "student@example.com",
        github_url: githubUrl,
        solution_notes: solutionNotes,
        max_score: Number(body.maxScore) || 100,
      });

      return jsonResponse({ submission });
    }

    // POST /api/lms/grade-submission
    if (path === "grade-submission" && method === "POST") {
      if (!user.isTeacher) return errorResponse("Forbidden", 403);
      const body = await req.json();
      const { submissionId, score, feedback, status } = body;
      if (!submissionId || score === undefined)
        return errorResponse("Missing submissionId or score");

      const graded = lmsDB.gradeSubmission(submissionId, {
        score: Number(score),
        feedback: feedback || "Well done!",
        gradedBy: user.name || "Instructor",
        status: status === "needs_revision" || status === "approved" ? status : undefined,
      });

      if (!graded) return errorResponse("Submission not found", 404);
      return jsonResponse({ submission: graded });
    }

    // POST /api/lms/save-assignment
    if (path === "save-assignment" && method === "POST") {
      if (!user.isTeacher) return errorResponse("Forbidden", 403);
      const body = await req.json();
      const course = lmsDB.getCourse(body.courseId || body.courseSlug);
      if (!course) return errorResponse("Course not found", 404);

      const asg = lmsDB.saveAssignment({
        id: body.id,
        course_id: course.id,
        course_slug: course.slug,
        course_title: course.title,
        title: body.title,
        description: body.description || "",
        due_date: body.dueDate || new Date(Date.now() + 86400000 * 7).toISOString(),
        max_score: Number(body.maxScore) || 100,
        created_by: user.userId,
      });

      return jsonResponse({ assignment: asg });
    }

    // DELETE /api/lms/assignment
    if (path === "assignment" && method === "DELETE") {
      if (!user.isTeacher) return errorResponse("Forbidden", 403);
      const body = await req.json();
      const { id } = body;
      if (!id) return errorResponse("Missing id");
      const ok = lmsDB.deleteAssignment(id);
      return jsonResponse({ success: ok });
    }

    // POST /api/lms/submit-quiz
    if (path === "submit-quiz" && method === "POST") {
      if (!user.userId) return errorResponse("Unauthorized", 401);
      const body = await req.json();
      const { quizId, courseId, answers = {} } = body;
      if (!quizId || !courseId) return errorResponse("Missing quizId or courseId");

      const db = lmsDB.getAllCourses();
      const course = lmsDB.getCourse(courseId);
      if (!course) return errorResponse("Course not found", 404);

      // Find quiz to score answers
      const quiz = (lmsDB as unknown as { read: () => { quizzes: unknown[] } })
        .read?.()
        ?.quizzes?.find((q: unknown) => (q as { id: string }).id === quizId) as
        | {
            questions: { id: number; correct_option: number; marks: number }[];
            pass_percentage: number;
          }
        | undefined;

      let score = 0;
      let totalMarks = 0;
      if (quiz && quiz.questions) {
        quiz.questions.forEach((q) => {
          totalMarks += q.marks;
          if (answers[q.id] === q.correct_option) {
            score += q.marks;
          }
        });
      } else {
        totalMarks = 100;
        score = 80;
      }

      const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
      const passed = percentage >= (quiz?.pass_percentage || 70);

      const attempt = lmsDB.submitQuizAttempt({
        quiz_id: quizId,
        course_id: course.id,
        student_id: user.userId,
        student_name: user.name || body.studentName || "Student",
        student_email: user.email || body.studentEmail || "student@example.com",
        score,
        total_marks: totalMarks,
        percentage,
        passed,
        answers,
      });

      return jsonResponse({ attempt });
    }

    // POST /api/lms/save-quiz
    if (path === "save-quiz" && method === "POST") {
      if (!user.isTeacher) return errorResponse("Forbidden", 403);
      const body = await req.json();
      const course = lmsDB.getCourse(body.courseId || body.courseSlug);
      if (!course) return errorResponse("Course not found", 404);

      const quiz = lmsDB.saveQuiz({
        id: body.id,
        course_id: course.id,
        course_slug: course.slug,
        course_title: course.title,
        title: body.title,
        description: body.description || "",
        duration_minutes: Number(body.durationMinutes) || 15,
        pass_percentage: Number(body.passPercentage) || 70,
        questions: body.questions || [],
        created_by: user.userId,
      });

      return jsonResponse({ quiz });
    }

    return errorResponse(`Unhandled endpoint: ${method} /api/lms/${path}`, 404);
  } catch (err: unknown) {
    console.error("LMS API Error:", err);
    const msg = err instanceof Error ? err.message : "Internal Server Error";
    return errorResponse(msg, 500);
  }
}

export async function handleLmsApiRequest(req: Request): Promise<Response | null> {
  await lmsDB.ready();
  try {
    return await handleLmsApiRequestInternal(req);
  } finally {
    await lmsDB.flush();
  }
}
