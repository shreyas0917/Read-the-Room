// Per-player projection of the authoritative state. This is the ONLY way state
// leaves the server, so the privacy rules live here:
//
//  • During answer/predict/echo, nobody sees anyone else's submission — only
//    who has submitted.
//  • After reveal, answers are shown only as an anonymous count per value.
//    Predictions, echo picks and points are public once revealed.
//  • The Wildcard (unique extreme answer) is named — players are told this
//    in the rules before they answer.
//  • Echo Rounds: the correct answer is withheld until the echo reveal. A
//    Who Said It subject is named only at the reveal, only if they opted in
//    (enforced at generation), and during the question only the subject is
//    told it's them.
//  • Consent is shown to others only as a count, never per player.
//  • Tokens never live in RoomState, so they cannot leak through here.
//
// Note: aggregates can still imply answers (with two answers, the average
// plus your own answer gives away the other). See docs/ECHO_ROUNDS.md.

import type {
  ClientView,
  EchoResultView,
  EchoView,
  PlayerView,
  PromptView,
  RevealView,
  RoomState,
  RoundRecord,
  RoundSummary,
} from "./protocol";
import { getPrompt } from "./prompts";
import { ANSWER_MAX } from "./rules";
import { playersBySeat } from "./engine";
import { answersOf } from "./echo";
import { mean, rankPlayers, stdDev, ZERO_SCORE } from "./scoring";

function promptView(id: string): PromptView {
  const p = getPrompt(id);
  return { id: p.id, text: p.text, low: p.low, high: p.high };
}

function countAnswers(answers: Readonly<Record<string, number>>, ids: readonly string[]): number[] {
  const counts = new Array<number>(ANSWER_MAX).fill(0);
  for (const id of ids) {
    const v = answers[id];
    if (v !== undefined) counts[v - 1] = (counts[v - 1] ?? 0) + 1;
  }
  return counts;
}

function echoView(s: RoomState, r: RoundRecord, viewerId: string | null): EchoView | null {
  const ch = r.echo;
  if (!ch) return null;
  const revealed = s.phase === "echo_reveal";
  const source = (idx: number) => s.history.find((h) => h.index === idx);

  let result: EchoResultView | null = null;
  if (revealed) {
    result = {
      cancelled: r.voided,
      truth: ch.truth,
      subjectId: ch.kind === "who" && !r.voided ? ch.subjectId : null,
      picks: r.participants.map((id) => ({
        playerId: id,
        choice: r.choices[id] ?? null,
        score: r.scores[id] ?? { ...ZERO_SCORE },
      })),
      stats:
        ch.kind === "pattern"
          ? ch.options.map((o) => {
              const h = source(o.round);
              const vals = h ? answersOf(h) : [];
              return { average: mean(vals) ?? 0, spread: stdDev(vals) ?? 0, counts: h ? countAnswers(h.answers, h.participants) : [] };
            })
          : null,
      counts: ch.kind === "count" ? (() => {
        const h = source(ch.sourceRound);
        return h ? countAnswers(h.answers, h.participants) : null;
      })() : null,
    };
  }

  return {
    kind: ch.kind,
    first: !s.history.some((h) => h.kind === "echo"),
    sourceRound: ch.kind === "pattern" ? null : ch.sourceRound,
    prompt: ch.kind === "pattern" ? null : promptView(ch.promptId),
    threshold: ch.kind === "count" ? ch.threshold : null,
    max: ch.kind === "count" ? ch.max : null,
    value: ch.kind === "who" ? ch.value : null,
    metric: ch.kind === "pattern" ? ch.metric : null,
    promptOptions: ch.kind === "pattern" ? ch.options.map((o) => promptView(o.promptId)) : null,
    playerOptions: ch.kind === "who" ? [...ch.options] : null,
    youAreSubject: ch.kind === "who" && viewerId !== null && viewerId === ch.subjectId,
    result,
  };
}

export function viewFor(s: RoomState, viewerId: string | null, now: number): ClientView {
  const viewer = viewerId ? s.players[viewerId] : undefined;
  const r = s.current;
  const bucket =
    r && s.phase === "answer" ? r.answers : r && s.phase === "predict" ? r.predictions : r && s.phase === "echo" ? r.choices : null;

  const players: PlayerView[] = playersBySeat(s).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    role: p.role,
    connected: p.connected,
    isHost: p.id === s.hostId,
    score: p.score,
    submitted: bucket && r?.participants.includes(p.id) ? bucket[p.id] !== undefined : null,
  }));

  const participants = r ? r.participants.filter((id) => s.players[id]) : [];
  const isParticipant = !!viewer && participants.includes(viewer.id);

  let reveal: RevealView | null = null;
  if (s.phase === "reveal" && r) {
    reveal = {
      voided: r.voided,
      average: r.average,
      counts: countAnswers(r.answers, r.participants),
      answerCount: r.participants.filter((id) => r.answers[id] !== undefined).length,
      yourAnswer: viewer ? (r.answers[viewer.id] ?? null) : null,
      wildcardId: r.wildcardId,
      guesses: r.participants.map((id) => ({
        playerId: id,
        value: r.predictions[id] ?? null,
        score: r.scores[id] ?? { ...ZERO_SCORE },
      })),
    };
  }

  let rounds: RoundSummary[] | null = null;
  if (s.phase === "final") {
    rounds = s.history
      .filter((h) => h.kind === "regular")
      .map((h) => ({
        index: h.index,
        prompt: promptView(h.promptId),
        voided: h.voided,
        average: h.average,
        counts: countAnswers(h.answers, h.participants),
      }));
  }

  const isEcho = r?.kind === "echo";
  return {
    code: s.code,
    phase: s.phase,
    round: s.round,
    totalRounds: s.settings.rounds,
    deadline: s.deadline,
    serverNow: now,
    settings: { ...s.settings },
    hostId: s.hostId,
    you: viewer
      ? {
          id: viewer.id,
          role: viewer.role,
          isHost: viewer.id === s.hostId,
          participant: isParticipant,
          onRecord: viewer.onRecord,
        }
      : null,
    onRecordCount: Object.values(s.players).filter((p) => p.onRecord).length,
    players,
    prompt: r && !isEcho ? promptView(r.promptId) : null,
    submittedCount: bucket ? participants.filter((id) => bucket[id] !== undefined).length : 0,
    expectedCount: participants.length,
    mine: {
      answer: viewer && r ? (r.answers[viewer.id] ?? null) : null,
      prediction: viewer && r ? (r.predictions[viewer.id] ?? null) : null,
      echo: viewer && r ? (r.choices[viewer.id] ?? null) : null,
    },
    reveal,
    echo: r && isEcho ? echoView(s, r, viewer?.id ?? null) : null,
    standings: s.phase === "final" ? rankPlayers(playersBySeat(s).filter((p) => p.role === "player")) : null,
    rounds,
    endedEarly: s.endedEarly,
  };
}
