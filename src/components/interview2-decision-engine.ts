export type Interview2Phase =
  | 'setup'
  | 'connecting'
  | 'greeting'
  | 'warmup'
  | 'interview'
  | 'wrapup'
  | 'closing'
  | 'report';

export type ObserverAnalysisShape = {
  is_filler_pause: boolean;
  is_substantive_answer: boolean;
  answer_summary: string;
  needs_cv_lookup: boolean;
  cv_topic: string;
  topic_exhausted: boolean;
  suggested_phase_advance: 'none' | 'warmup' | 'interview' | 'wrapup' | 'closing' | 'report';
  should_score_answer: boolean;
  ai_rambling: boolean;
  ai_hallucination_or_tone_issue: string;
  candidate_struggling: boolean;
  red_flag_detected: string;
  callback_opportunity: string;
  requested_pause_seconds: number;
  candidate_needs_more_time: boolean;
  candidate_does_not_know: boolean;
  is_complex_question: boolean;
  candidate_has_final_question?: boolean;
  candidate_ready_to_end?: boolean;
  should_end_call?: boolean;
  is_off_topic: boolean;
  should_force_pivot: boolean;
  custom_correction_directive: string;
  is_incomplete_answer: boolean;
  is_answer_complete: boolean;
};

export type ScoreEvaluationInput = {
  question: string;
  answer: string;
  topic: string;
  cvText: string;
};

export type ScoreEvaluationResult = {
  question_summary: string;
  score: number;
  technical_accuracy: number;
  logic_evaluation: string;
  missed_opportunities: string[];
  confidence: 'high' | 'medium' | 'low';
  grammar: 'good' | 'average' | 'poor';
  clarity: 'good' | 'average' | 'poor';
  depth: 'shallow' | 'adequate' | 'deep';
  feedback: string;
  tags: string[];
  suggested_followup: string;
  project_reference: string;
  cv_followup: string;
};

export type DirectivePriority = 1 | 2 | 3 | 4 | 5;

export type DirectorAction =
  | 'forced_progression'
  | 'corrective_refocus'
  | 'greeting_to_warmup'
  | 'warmup_follow_up'
  | 'warmup_to_interview'
  | 'interview_to_wrapup'
  | 'wrapup_to_closing'
  | 'candidate_support'
  | 'move_on'
  | 'red_flag'
  | 'bridge_topic'
  | 'cv_lookup'
  | 'callback'
  | 'end_call'
  | 'noop';

export type DirectiveCandidate = {
  id: string;
  action: DirectorAction;
  priority: DirectivePriority;
  instruction: string;
  reason: string;
  nextPhase?: Interview2Phase;
  cvTopic?: string;
};

export type DirectiveChoice = {
  candidate_id?: string;
  reason?: string;
};

export type DirectiveContext = {
  phase: Interview2Phase;
  currentTopic: string;
  nextWarmupQuestion: string;
  greetingCount: number;
  warmupCount: number;
  wrapupCount: number;
  phaseTurnCount: number;
  totalScores: number;
  numQuestions: number;
  driftCount: number;
  struggleCount: number;
  incompleteCount: number;
};

const SCORE_FALLBACK: ScoreEvaluationResult = {
  question_summary: '',
  score: 5,
  technical_accuracy: 5,
  logic_evaluation: '',
  missed_opportunities: [],
  confidence: 'medium',
  grammar: 'average',
  clarity: 'average',
  depth: 'adequate',
  feedback: 'Answer recorded.',
  tags: [],
  suggested_followup: '',
  project_reference: '',
  cv_followup: '',
};

function stripCodeFences(raw: string) {
  return raw.replace(/```json|```/gi, '').trim();
}

function extractJsonObject(raw: string): string | null {
  const cleaned = stripCodeFences(raw);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const objectText = extractJsonObject(raw);
  if (!objectText) return null;
  try {
    return JSON.parse(objectText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toConfidence(value: unknown): ScoreEvaluationResult['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function toQuality(value: unknown): 'good' | 'average' | 'poor' {
  return value === 'good' || value === 'average' || value === 'poor' ? value : 'average';
}

function toDepth(value: unknown): ScoreEvaluationResult['depth'] {
  return value === 'shallow' || value === 'adequate' || value === 'deep' ? value : 'adequate';
}

function priorityLabel(priority: DirectivePriority) {
  return `P${priority}`;
}

function describeCandidate(candidate: DirectiveCandidate) {
  return `${candidate.id} | ${priorityLabel(candidate.priority)} | ${candidate.reason}`;
}

export function buildScoreEvaluationPrompt(input: ScoreEvaluationInput): string {
  return `Evaluate the candidate's answer once and return a single JSON object.

Question: "${input.question}"
Answer: "${input.answer}"
Topic: "${input.topic}"
CV Excerpt:
${input.cvText.slice(0, 4000)}

Return JSON only:
{
  "question_summary": "string",
  "score": number,
  "technical_accuracy": number,
  "logic_evaluation": "string",
  "missed_opportunities": ["string"],
  "confidence": "high|medium|low",
  "grammar": "good|average|poor",
  "clarity": "good|average|poor",
  "depth": "shallow|adequate|deep",
  "feedback": "string",
  "tags": ["string"],
  "suggested_followup": "string",
  "project_reference": "string",
  "cv_followup": "string"
}

Rules:
1. Keep feedback short and concrete.
2. suggested_followup should be a single natural follow-up question or an empty string.
3. project_reference and cv_followup can be empty strings if there is no CV tie-in.
4. Do not split this into multiple outputs.`;
}

export function parseScoreEvaluation(raw: string): ScoreEvaluationResult {
  const parsed = parseJsonObject(raw);
  if (!parsed) return SCORE_FALLBACK;

  return {
    question_summary: asString(parsed.question_summary, SCORE_FALLBACK.question_summary),
    score: clampInt(parsed.score, SCORE_FALLBACK.score, 1, 10),
    technical_accuracy: clampInt(parsed.technical_accuracy, SCORE_FALLBACK.technical_accuracy, 1, 10),
    logic_evaluation: asString(parsed.logic_evaluation, SCORE_FALLBACK.logic_evaluation),
    missed_opportunities: asStringArray(parsed.missed_opportunities),
    confidence: toConfidence(parsed.confidence),
    grammar: toQuality(parsed.grammar),
    clarity: toQuality(parsed.clarity),
    depth: toDepth(parsed.depth),
    feedback: asString(parsed.feedback, SCORE_FALLBACK.feedback),
    tags: asStringArray(parsed.tags),
    suggested_followup: asString(parsed.suggested_followup, SCORE_FALLBACK.suggested_followup),
    project_reference: asString(parsed.project_reference, SCORE_FALLBACK.project_reference),
    cv_followup: asString(parsed.cv_followup, SCORE_FALLBACK.cv_followup),
  };
}

export function buildDirectiveCandidates(
  analysis: ObserverAnalysisShape,
  context: DirectiveContext,
): DirectiveCandidate[] {
  const candidates: DirectiveCandidate[] = [];
  const greetingWallHit = context.phaseTurnCount >= 5;
  const warmupWallHit = context.phaseTurnCount >= 15;
  const nextWarmupQuestion = context.nextWarmupQuestion.trim() || 'What do you enjoy doing outside of work?';

  const shouldAdvanceGreeting =
    context.phase === 'greeting' &&
    ((analysis.is_substantive_answer && analysis.is_answer_complete) || greetingWallHit);

  const warmupEligible =
    context.phase === 'warmup' &&
    (((analysis.is_substantive_answer || analysis.answer_summary.trim().length > 5) && analysis.is_answer_complete) || warmupWallHit);

  const nextWarmupCount = context.warmupCount + ((analysis.is_substantive_answer || analysis.answer_summary.trim().length > 5) ? 1 : 0);
  const nextWrapupCount = context.wrapupCount + (analysis.is_substantive_answer ? 1 : 0);

  if ((analysis.ai_rambling || analysis.ai_hallucination_or_tone_issue || analysis.should_force_pivot) && analysis.custom_correction_directive.trim().length > 5) {
    candidates.push({
      id: 'corrective_refocus',
      action: 'corrective_refocus',
      priority: 2,
      instruction: `SYSTEM DIRECTIVE: IF the candidate has definitively finished their current thought: ${analysis.custom_correction_directive}. ELSE: Smoothly encourage them to continue or wait patiently.`,
      reason: 'AI correction needed',
    });
  } else if (analysis.should_force_pivot) {
    const fallbackDirective =
      context.phase === 'greeting'
        ? 'SYSTEM DIRECTIVE: You are only doing an audio check. Ask ONLY: "Are you ready to begin?"'
        : context.phase === 'warmup'
          ? `SYSTEM DIRECTIVE: Acknowledge naturally and ask your next personal warmup question: "${nextWarmupQuestion}"`
          : context.phase === 'interview'
            ? `SYSTEM DIRECTIVE: Pivot back to the current technical topic: ${context.currentTopic}.`
            : 'SYSTEM DIRECTIVE: Focus only on the current phase goals and stay on script.';

    candidates.push({
      id: 'corrective_refocus_fallback',
      action: 'corrective_refocus',
      priority: 2,
      instruction: fallbackDirective,
      reason: 'Force pivot requested without a custom directive',
    });
  }

  if (analysis.red_flag_detected.trim().length > 0) {
    candidates.push({
      id: 'red_flag',
      action: 'red_flag',
      priority: 2,
      instruction: `SYSTEM DIRECTIVE: RED FLAG: ${analysis.red_flag_detected}. On your next turn, abandon the queue and cleanly ask ONE question probing this concern.`,
      reason: 'Red flag detected',
    });
  }

  if ((analysis.topic_exhausted || context.struggleCount >= 2) && context.phase === 'interview' && analysis.is_answer_complete) {
    candidates.push({
      id: 'bridge_topic',
      action: 'bridge_topic',
      priority: 2,
      instruction: `SYSTEM DIRECTIVE: The current topic is exhausted. Pivot cleanly to the next technical topic on your next turn.`,
      reason: 'Topic exhausted or persistent struggle',
    });
  }

  if (analysis.candidate_does_not_know && analysis.is_answer_complete && !analysis.candidate_needs_more_time) {
    const moveOnDirective =
      context.phase === 'greeting'
        ? 'SYSTEM DIRECTIVE: The candidate is not ready yet. Briefly acknowledge and ask whether they are ready to begin.'
        : context.phase === 'warmup'
          ? `SYSTEM DIRECTIVE: The candidate does not know this warmup answer. Briefly acknowledge it and move to the next warmup question: "${nextWarmupQuestion}"`
          : context.phase === 'interview'
            ? 'SYSTEM DIRECTIVE: The candidate does not know this answer. Acknowledge briefly, do not keep probing the same question, and move to a simpler adjacent technical question or the next topic.'
            : context.phase === 'wrapup'
              ? 'SYSTEM DIRECTIVE: The candidate is not ready with questions. Acknowledge briefly and keep the wrap-up moving naturally.'
              : 'SYSTEM DIRECTIVE: Acknowledge briefly and continue naturally.';

    candidates.push({
      id: 'move_on',
      action: 'move_on',
      priority: 2,
      instruction: moveOnDirective,
      reason: 'Candidate explicitly does not know',
    });
  }

  if (shouldAdvanceGreeting) {
    candidates.push({
      id: 'greeting_to_warmup',
      action: 'greeting_to_warmup',
      priority: 2,
      nextPhase: 'warmup',
      instruction: `SYSTEM DIRECTIVE: Acknowledge and smoothly ask your first personal warmup question: "${nextWarmupQuestion}"`,
      reason: greetingWallHit ? 'Greeting wall hit' : 'Candidate answered the greeting',
    });
  } else if (context.phase === 'greeting' && analysis.is_substantive_answer && !analysis.is_answer_complete) {
    candidates.push({
      id: 'greeting_hold',
      action: 'noop',
      priority: 5,
      instruction: '',
      reason: 'Greeting answer is still in progress',
    });
  }

  if (warmupEligible) {
    if (nextWarmupCount >= 3 || warmupWallHit) {
      candidates.push({
        id: 'warmup_to_interview',
        action: 'warmup_to_interview',
        priority: 2,
        nextPhase: 'interview',
        instruction: 'SYSTEM DIRECTIVE: Warmup is complete. Pivot naturally into the formal interview.',
        reason: warmupWallHit ? 'Warmup wall hit' : 'Warmup quota reached',
      });
    } else {
      candidates.push({
        id: 'warmup_follow_up',
        action: 'warmup_follow_up',
        priority: 3,
        nextPhase: 'warmup',
        instruction: `SYSTEM DIRECTIVE: Acknowledge their answer naturally, then ask your next casual warmup question: "${nextWarmupQuestion}"`,
        reason: 'Continue warmup',
      });
    }
  }

  if (context.phase === 'interview' && context.totalScores >= context.numQuestions && analysis.is_answer_complete) {
    candidates.push({
      id: 'interview_to_wrapup',
      action: 'interview_to_wrapup',
      priority: 2,
      nextPhase: 'wrapup',
      instruction: "SYSTEM DIRECTIVE: The technical interview is officially over. You MUST immediately stop asking technical questions. On your next turn, say exactly: 'Alright, that covers all my technical questions! You did great. To wrap things up, what questions do you have for me about the role or the team?' Do not ask any more interview questions.",
      reason: 'Interview quota reached',
    });
  }

  if (context.phase === 'wrapup' && (analysis.candidate_ready_to_end || nextWrapupCount >= 3)) {
    candidates.push({
      id: 'wrapup_to_closing',
      action: 'wrapup_to_closing',
      priority: 2,
      nextPhase: 'closing',
      instruction: 'SYSTEM DIRECTIVE: Wrap-up is complete. On your next turn, provide a warm final farewell and stop.',
      reason: 'Wrap-up complete',
    });
  }

  if (analysis.candidate_struggling) {
    candidates.push({
      id: 'candidate_support',
      action: 'candidate_support',
      priority: 3,
      instruction: 'SYSTEM DIRECTIVE: The candidate is struggling. On your next turn, simplify the question or offer a helpful hint.',
      reason: 'Candidate struggling',
    });
  }

  if (analysis.needs_cv_lookup && context.phase !== 'warmup' && context.phase !== 'greeting') {
    candidates.push({
      id: 'cv_lookup',
      action: 'cv_lookup',
      priority: 3,
      instruction: `SYSTEM DATA: Pull the CV context for "${analysis.cv_topic}" before asking your next question.`,
      reason: 'CV lookup requested',
      cvTopic: analysis.cv_topic,
    });
  }

  if (analysis.callback_opportunity.trim().length > 0) {
    candidates.push({
      id: 'callback',
      action: 'callback',
      priority: 4,
      instruction: `SYSTEM DIRECTIVE: If appropriate, tie your next question into this past context seamlessly: ${analysis.callback_opportunity}`,
      reason: 'Contextual callback opportunity',
    });
  }

  if (analysis.should_end_call && (context.phase === 'wrapup' || context.phase === 'closing')) {
    candidates.push({
      id: 'end_call',
      action: 'end_call',
      priority: 1,
      instruction: 'SYSTEM DIRECTIVE: The conversation is complete. Give a warm final farewell and stop.',
      reason: 'Candidate wants to end the call',
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      id: 'noop',
      action: 'noop',
      priority: 5,
      instruction: '',
      reason: 'No directive needed',
    });
  }

  return candidates;
}

export function getTopPriorityCandidates(candidates: DirectiveCandidate[]) {
  if (candidates.length === 0) return [];
  const topPriority = Math.min(...candidates.map((candidate) => candidate.priority));
  return candidates.filter((candidate) => candidate.priority === topPriority);
}

export function buildDirectiveArbiterPrompt(params: {
  analysis: ObserverAnalysisShape;
  context: DirectiveContext;
  candidates: DirectiveCandidate[];
}): string {
  const topCandidates = getTopPriorityCandidates(params.candidates).filter((candidate) => candidate.action !== 'noop');
  const bucketText = topCandidates.map((candidate, index) => `  ${index + 1}. ${describeCandidate(candidate)}`).join('\n');

  return `You are the director model for Aria.
The observer already analyzed the turn. Choose exactly one candidate from the highest-priority bucket.
Smaller numbers are more urgent. Never invent a new action. Never choose from a lower-priority bucket when a higher one exists.

Priority guide:
1 = critical control: must act now
2 = hard steering: correction, explicit unknown recovery, bridge, or phase movement
3 = support: warmup follow-up, candidate help, or CV lookup
4 = enrichment: callback or soft context link
5 = no-op

Current phase: ${params.context.phase.toUpperCase()}
Current topic: ${params.context.currentTopic}
Observer summary:
${JSON.stringify(params.analysis, null, 2)}

Candidates in the top bucket:
${bucketText}

Return JSON only:
{
  "candidate_id": "string",
  "reason": "string"
}`;
}

export function parseDirectiveChoice(raw: string): DirectiveChoice {
  const parsed = parseJsonObject(raw);
  if (!parsed) return {};

  return {
    candidate_id: asString(parsed.candidate_id || parsed.id || parsed.action, ''),
    reason: asString(parsed.reason || parsed.explanation, ''),
  };
}

export function selectDirectiveCandidate(candidates: DirectiveCandidate[], choice?: DirectiveChoice) {
  if (candidates.length === 0) return null;

  const topPriority = Math.min(...candidates.map((candidate) => candidate.priority));
  const topBucket = candidates.filter((candidate) => candidate.priority === topPriority);

  if (choice?.candidate_id) {
    const matched = topBucket.find((candidate) => candidate.id === choice.candidate_id);
    if (matched) return matched;
  }

  return topBucket[0] ?? candidates[0] ?? null;
}
