// In-memory dummy emails.

export const emails = [
  {
    id: "email_001",
    from: "boss@company.com",
    subject: "Q1 Budget Review",
    body: "Hi, please review the attached Q1 budget document and share your feedback by end of week. This is important for our board meeting next Monday. Thanks.",
    preview: "Hi, please review the attached Q1 budget document and share your feedback...",
    received_at: "2026-03-09T08:30:00Z",
    read: false,
  },
  {
    id: "email_002",
    from: "notifications@github.com",
    subject: "PR #42 approved",
    body: "Your pull request 'Authentication Refactor' (#42) has been approved by 2 reviewers: alice and bob. It is now ready to merge.",
    preview: "Your pull request has been approved by 2 reviewers.",
    received_at: "2026-03-09T09:15:00Z",
    read: false,
  },
  {
    id: "email_003",
    from: "hr@company.com",
    subject: "Reminder: Benefits Enrollment Deadline",
    body: "This is a reminder that the annual benefits enrollment window closes on March 20, 2026. Please log in to the HR portal and make your selections before the deadline.",
    preview: "Annual benefits enrollment window closes on March 20, 2026.",
    received_at: "2026-03-08T14:00:00Z",
    read: false,
  },
  {
    id: "email_004",
    from: "newsletter@techdigest.io",
    subject: "Weekly Tech Digest #112",
    body: "This week in tech: Breakthroughs in quantum computing, the latest Node.js LTS release, and an interview with a prominent AI researcher.",
    preview: "Breakthroughs in quantum computing, Node.js LTS, and more.",
    received_at: "2026-03-07T07:00:00Z",
    read: true,
  },
];

// Pre-built summaries keyed by email ID (simulates AI summarization without a live LLM).
export const summaries = {
  email_001:
    "Your boss is requesting that you review the Q1 budget document and provide feedback by end of week. The context is a board meeting happening next Monday, so the tone implies urgency.",
  email_002:
    "Your pull request 'Authentication Refactor' (#42) has been approved by two reviewers (alice and bob) and is ready to merge.",
  email_003:
    "HR is reminding you that the annual benefits enrollment deadline is March 20, 2026. You need to log into the HR portal and select your benefits before that date.",
  email_004:
    "A weekly tech newsletter covering quantum computing breakthroughs, the latest Node.js LTS release, and an AI researcher interview.",
};
