import { supabase } from "@/integrations/supabase/client";
import { syncLocalSessionProfile } from "@/lib/local-db";

async function getAuthHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Server routes must derive identity from a session token, not client-supplied
  // x-user-id / x-user-role headers. The database validates the bearer token.
  try {
    const localSession = typeof window !== "undefined"
      ? ["sb-local-auth-token", "sb-csjygxumpnonfupobhih-auth-token", "skillbridge_local_auth_session"]
          .map((key) => {
            try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
          })
          .find((session) => session?.access_token)
      : null;
    if (localSession?.access_token) {
      headers["Authorization"] = `Bearer ${localSession.access_token}`;
      return headers;
    }
  } catch {
    // Fall through to the auth adapter.
  }

  try {
    const { data } = await supabase.auth.getSession();
    const session = data?.session;
    if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;
  } catch {
    // No browser auth session available.
  }

  // Legacy local demo sessions have no signed server token. Do not send identity
  // headers as if they were authentication credentials.

  return headers;
}

async function uploadToVercelBlob(
  kind: "video" | "thumbnail" | "avatar",
  file: File,
  courseId?: string,
  lessonId?: string,
): Promise<{ publicUrl: string }> {
  const authHeaders = await getAuthHeaders();
  const response = await fetch("/api/lms/create-upload-url", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      kind,
      courseId,
      lessonId,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
    }),
  });

  if (response.status === 503) {
    throw new Error("LOCAL_STORAGE_FALLBACK");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.uploadUrl || !data.publicUrl || !data.pathname) {
    throw new Error(data?.error || `Unable to prepare ${kind} upload (HTTP ${response.status})`);
  }

  const putResponse = await fetch(data.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!putResponse.ok) {
    throw new Error(`${kind} upload to cloud storage failed (HTTP ${putResponse.status})`);
  }

  // The signed PUT URL already identifies the exact Blob object. The server
  // returns its canonical public URL separately, so no eventual-consistency
  // HEAD/list request is needed after the upload completes.
  return { publicUrl: String(data.publicUrl) };
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(`/api/lms/${endpoint}`, {
    ...options,
    headers: {
      ...authHeaders,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let errMsg = `Request failed: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) errMsg = body.error;
    } catch {
      // ignore
    }
    throw new Error(errMsg);
  }

  return res.json();
}

export interface ClientCourse {
  id: string;
  slug: string;
  title: string;
  description: string;
  instructor: string;
  teacher_id: string | null;
  thumbnail: string;
  status: "published" | "draft" | "review";
  price_inr: number;
  preview_minutes: number;
  video_url: string;
  video_urls?: string[];
  lessons_count?: number;
  hours: number;
  level: string;
  category: string;
  rating: number;
  reviews: string;
  learners: string;
  bestseller?: boolean;
}

export interface ClientLesson {
  id: string;
  course_id: string;
  title: string;
  description: string;
  video_url: string;
  duration: string;
  lesson_order: number;
  is_required: boolean;
  is_preview: boolean;
  completed?: boolean;
}

export interface ClientEnrollment {
  id: string;
  student_id: string;
  course_id: string;
  student_name: string;
  student_email: string;
  enrolled_at: string;
  completion_percentage: number;
  completed_at: string | null;
  status: "enrolled" | "in_progress" | "completed";
}

export interface StudentDashboardData {
  enrolledCourses: Array<{
    id: string;
    slug: string;
    title: string;
    instructor: string;
    description: string;
    thumbnail: string;
    hours: number;
    progress: number;
    lessonsDone: number;
    lessonsTotal: number;
    nextLesson: string;
    status: string;
    enrolledAt: string;
    completedAt: string | null;
    certificateId: string | null;
    videoUrl: string;
  }>;
  inProgressCoursesCount: number;
  completedCoursesCount: number;
  overallProgress: number;
  upcomingAssignments: Array<{
    id: string;
    title: string;
    description: string;
    course: string;
    courseSlug: string;
    due: string;
    maxScore: number;
    submissionStatus: "unsubmitted" | "pending" | "approved" | "resubmission_required";
    score: number | null;
    feedback: string | null;
    submittedAt: string | null;
  }>;
  studentQuizzes: Array<{
    id: string;
    title: string;
    description: string;
    course: string;
    courseSlug: string;
    durationMinutes: number;
    passPercentage: number;
    questionsCount: number;
    bestScore: number | null;
    totalMarks: number | null;
    passed: boolean;
    attemptCount: number;
  }>;
  grades: Array<{
    id: string;
    assignmentId: string;
    title: string;
    course: string;
    score: number;
    maxScore: number;
    percentage: number;
    feedback: string | null;
    gradedAt: string | null;
  }>;
  certificates: Array<{
    id: string;
    certificate_id: string;
    course_title: string;
    completion_date: string;
  }>;
}

export interface InstructorDashboardData {
  courses: ClientCourse[];
  students: Array<{
    id: string;
    studentId: string;
    studentName: string;
    studentEmail: string;
    avatarUrl?: string | null;
    courseId: string;
    courseSlug: string;
    courseTitle: string;
    progress: number;
    completedLessons: number;
    totalRequiredLessons: number;
    status: string;
    enrolledAt: string;
    completedAt: string | null;
    certificateEarned: boolean;
    certificateId: string | null;
    assignmentStatus: string;
    quizStatus: string;
  }>;
  submissions: Array<{
    id: string;
    assignment_id: string;
    assignmentTitle: string;
    course_id: string;
    courseTitle: string;
    courseSlug: string;
    student_id: string;
    student_name: string;
    student_email: string;
    github_url: string;
    solution_notes: string;
    submitted_at: string;
    status: "pending" | "approved" | "resubmission_required";
    score: number | null;
    max_score: number;
    feedback: string | null;
    graded_at: string | null;
    graded_by: string | null;
  }>;
  assignments: Array<{
    id: string;
    course_id: string;
    course_slug: string;
    course_title: string;
    title: string;
    description: string;
    due_date: string;
    max_score: number;
  }>;
  quizzes: Array<{
    id: string;
    course_id: string;
    course_slug: string;
    course_title: string;
    title: string;
    description: string;
    duration_minutes: number;
    pass_percentage: number;
    questions: Array<{
      id: number;
      question: string;
      options: string[];
      correct_option: number;
      explanation: string;
      marks: number;
    }>;
  }>;
}

export const lmsClient = {
  // COURSES
  async getCourses(): Promise<{ courses: ClientCourse[] }> {
    return request<{ courses: ClientCourse[] }>("courses");
  },

  async getCourse(idOrSlug: string): Promise<{
    course: ClientCourse;
    lessons: ClientLesson[];
    enrollment: ClientEnrollment | null;
    lessonProgress: Array<{ lesson_id: string; completed: boolean; completed_at: string | null }>;
  }> {
    return request(`course?idOrSlug=${encodeURIComponent(idOrSlug)}`);
  },

  async enroll(
    courseIdOrSlug: string,
    studentName?: string,
    studentEmail?: string,
  ): Promise<{ enrollment: ClientEnrollment }> {
    return request("enroll", {
      method: "POST",
      body: JSON.stringify({ courseId: courseIdOrSlug, studentName, studentEmail }),
    });
  },

  async completeLesson(
    courseIdOrSlug: string,
    lessonId: string,
    completed = true,
    studentName?: string,
    studentEmail?: string,
  ): Promise<{
    progress: number;
    completedCount: number;
    totalCount: number;
    isCompleted: boolean;
    certificateId?: string;
  }> {
    return request("complete-lesson", {
      method: "POST",
      body: JSON.stringify({
        courseId: courseIdOrSlug,
        lessonId,
        completed,
        studentName,
        studentEmail,
      }),
    });
  },

  // STUDENT DASHBOARD
  async getStudentDashboard(): Promise<StudentDashboardData> {
    return request<StudentDashboardData>("student-dashboard");
  },

  // INSTRUCTOR DATA
  async getInstructorData(): Promise<InstructorDashboardData> {
    return request<InstructorDashboardData>("instructor-data");
  },

  // PROFILE
  async updateProfile(data: {
    displayName?: string;
    avatarUrl?: string | null;
  }): Promise<{ user: { id: string; email: string; user_metadata: Record<string, unknown> } }> {
    return request("profile", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  async uploadAvatar(file: File): Promise<{ avatarUrl: string; fileName: string; size: number }> {
    try {
      // Avatars use the LMS server endpoint so Vercel Blob returns the
      // canonical public URL from the server-side put operation. The signed
      // PUT URL is only an upload URL and must not be used as the media URL.
      const authHeaders = await getAuthHeaders();
      const response = await fetch("/api/lms/upload-avatar", {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
          "X-File-Size": String(file.size),
        },
        body: file,
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          data?.error || data?.message || `Avatar upload failed (HTTP ${response.status})`,
        );
      }

      const avatarUrl = String(data?.avatarUrl || "");
      if (!avatarUrl) {
        throw new Error("Avatar upload completed without a public image URL.");
      }

      syncLocalSessionProfile({ avatarUrl });
      return data as { avatarUrl: string; fileName: string; size: number };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "LOCAL_STORAGE_FALLBACK") throw error;

      const authHeaders = await getAuthHeaders();
      const response = await fetch("/api/lms/upload-avatar", {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
          "X-File-Size": String(file.size),
        },
        body: file,
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          data?.error || data?.message || `Avatar upload failed (HTTP ${response.status})`,
        );
      }

      syncLocalSessionProfile({ avatarUrl: String(data?.avatarUrl || "") });
      return data as { avatarUrl: string; fileName: string; size: number };
    }
  },

  // COURSE MANAGEMENT
  async createCourse(data: Partial<ClientCourse>): Promise<{ course: ClientCourse }> {
    return request("course", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async updateCourse(id: string, data: Partial<ClientCourse>): Promise<{ course: ClientCourse }> {
    return request("course", {
      method: "PUT",
      body: JSON.stringify({ id, ...data }),
    });
  },

  async deleteCourse(id: string): Promise<{ success: boolean }> {
    return request("course", {
      method: "DELETE",
      body: JSON.stringify({ id }),
    });
  },

  // VIDEO UPLOADS
  async uploadVideo(
    courseId: string,
    file: File,
    lessonId?: string,
  ): Promise<{ videoUrl: string; fileName: string; size: number }> {
    try {
      const uploaded = await uploadToVercelBlob("video", file, courseId, lessonId);
      return { videoUrl: uploaded.publicUrl, fileName: file.name, size: file.size };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "LOCAL_STORAGE_FALLBACK") throw error;

      const authHeaders = await getAuthHeaders();
      const headers: Record<string, string> = {
        ...authHeaders,
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        "X-File-Size": String(file.size),
      };
      const query = new URLSearchParams({ courseId });
      if (lessonId) query.set("lessonId", lessonId);

      const res = await fetch(`/api/lms/upload-video?${query.toString()}`, {
        method: "POST",
        headers,
        body: file,
      });

      if (!res.ok) {
        let errMsg = `Upload failed: ${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body.error) errMsg = body.error;
        } catch {}
        throw new Error(errMsg);
      }
      return res.json();
    }
  },

  // COURSE THUMBNAIL UPLOAD
  async uploadThumbnail(
    courseId: string,
    file: File,
  ): Promise<{ thumbnailUrl: string; fileName: string; size: number }> {
    try {
      const uploaded = await uploadToVercelBlob("thumbnail", file, courseId);
      await request("course", {
        method: "PUT",
        body: JSON.stringify({ id: courseId, thumbnail: uploaded.publicUrl }),
      });
      return { thumbnailUrl: uploaded.publicUrl, fileName: file.name, size: file.size };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "LOCAL_STORAGE_FALLBACK") throw error;

      const authHeaders = await getAuthHeaders();
      const headers: Record<string, string> = {
        ...authHeaders,
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        "X-File-Size": String(file.size),
      };
      const query = new URLSearchParams({ courseId });
      const res = await fetch(`/api/lms/upload-thumbnail?${query.toString()}`, {
        method: "POST",
        headers,
        body: file,
      });

      if (!res.ok) {
        let errMsg = `Thumbnail upload failed: ${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body.error) errMsg = body.error;
        } catch {}
        throw new Error(errMsg);
      }
      return res.json();
    }
  },

  // LESSON MANAGEMENT
  async addLesson(
    courseId: string,
    data: {
      title: string;
      description?: string;
      duration?: string;
      videoUrl?: string;
      isRequired?: boolean;
      isPreview?: boolean;
      lessonOrder?: number;
    },
  ): Promise<{ lesson: ClientLesson }> {
    return request("lesson", {
      method: "POST",
      body: JSON.stringify({ courseId, ...data }),
    });
  },

  async updateLesson(
    lessonId: string,
    patch: Partial<ClientLesson>,
  ): Promise<{ lesson: ClientLesson }> {
    return request("lesson", {
      method: "PUT",
      body: JSON.stringify({ lessonId, ...patch }),
    });
  },

  async deleteLesson(lessonId: string): Promise<{ success: boolean }> {
    return request("lesson", {
      method: "DELETE",
      body: JSON.stringify({ lessonId }),
    });
  },

  // ASSIGNMENTS & SUBMISSIONS
  async submitAssignment(data: {
    assignmentId: string;
    courseId: string;
    githubUrl: string;
    solutionNotes: string;
    maxScore?: number;
    studentName?: string;
    studentEmail?: string;
  }): Promise<{ submission: unknown }> {
    return request("submit-assignment", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async gradeSubmission(
    submissionId: string,
    score: number,
    feedback?: string,
    status?: "approved" | "needs_revision",
  ): Promise<{ submission: unknown }> {
    return request("grade-submission", {
      method: "POST",
      body: JSON.stringify({ submissionId, score, feedback, status }),
    });
  },

  async saveAssignment(data: {
    id?: string;
    courseId: string;
    title: string;
    description: string;
    dueDate?: string;
    maxScore?: number;
  }): Promise<{ assignment: unknown }> {
    return request("save-assignment", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async deleteAssignment(id: string): Promise<{ success: boolean }> {
    return request("assignment", {
      method: "DELETE",
      body: JSON.stringify({ id }),
    });
  },

  // QUIZZES
  async submitQuiz(
    quizId: string,
    courseId: string,
    answers: Record<string | number, number>,
    studentName?: string,
    studentEmail?: string,
  ): Promise<{ attempt: unknown }> {
    return request("submit-quiz", {
      method: "POST",
      body: JSON.stringify({ quizId, courseId, answers, studentName, studentEmail }),
    });
  },

  async saveQuiz(data: {
    id?: string;
    courseId: string;
    title: string;
    description?: string;
    durationMinutes?: number;
    passPercentage?: number;
    questions: Array<{
      id: number;
      question: string;
      options: string[];
      correct_option: number;
      explanation: string;
      marks: number;
    }>;
  }): Promise<{ quiz: unknown }> {
    return request("save-quiz", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
};
